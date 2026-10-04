// Diagnostic Windows x64 measurement using only a synthetic PNG and an
// isolated Electron utility process. It never accesses the system clipboard
// or sends input to another application.
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { createInflate } = zlib;

const ROOT = path.resolve(__dirname, "../../..");
const WIDTH = Math.max(1, Math.trunc(Number(process.env.T04_IMAGE_WIDTH) || 4000));
const HEIGHT = Math.max(1, Math.trunc(Number(process.env.T04_IMAGE_HEIGHT) || 4000));
const PIXELS = WIDTH * HEIGHT;
const WORKER_LIMIT_BYTES = 256 * 1024 * 1024;
const INFLATE_CHUNK_BYTES = 1024 * 1024;
const SAMPLE_COUNT = Math.min(5, Math.max(1, Number(process.env.T04_IMAGE_SAMPLE_COUNT) || 5));
const SAMPLE_INTERVAL_MS = Math.max(50, Number(process.env.T04_IMAGE_SAMPLE_INTERVAL_MS) || 100);
const IMAGE_FORMAT = process.env.T04_IMAGE_FORMAT || "png";
if (IMAGE_FORMAT !== "png" && IMAGE_FORMAT !== "jpeg") throw new Error("unsupported_t04_image_format");
if (!Number.isSafeInteger(PIXELS) || PIXELS > 16_000_000) throw new Error("synthetic_image_exceeds_pixel_limit");

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require("electron"), [__filename], {
    cwd: ROOT,
    env,
    stdio: "inherit",
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} else {
  runMeasurement().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    require("electron").app.exit(1);
  });
}

async function runMeasurement() {
  const { app, utilityProcess } = require("electron");
  const workerEntry = path.join(ROOT, "dist-electron", "main", "clipboard", "image-worker.js");
  const outputName = IMAGE_FORMAT === "png"
    ? `image-worker-16mp-fresh-worker-${SAMPLE_COUNT}-sample-measurement.json`
    : `image-worker-${PIXELS}-pixel-jpeg-20mib-fresh-worker-${SAMPLE_COUNT}-sample-measurement.json`;
  const outputPath = path.join(ROOT, "docs", "evidence", "T04", outputName);
  assert.ok(fs.existsSync(workerEntry), `compiled worker entry missing: ${workerEntry}`);
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error(`measurement_requires_windows_x64:${process.platform}:${process.arch}`);
  }

  await app.whenReady();
  const jpegFixture = IMAGE_FORMAT === "jpeg" ? buildSyntheticJpeg(WIDTH, HEIGHT) : null;
  const encodedBytes = jpegFixture?.bytes ?? buildSyntheticPng(WIDTH, HEIGHT);
  if (encodedBytes.byteLength > 20 * 1024 * 1024) throw new Error("synthetic_image_exceeds_source_limit");
  const imageSha256 = createHash("sha256").update(encodedBytes).digest("hex");
  const samples = [];
  const workers = [];
  for (let index = 0; index < SAMPLE_COUNT; index++) {
    const requestId = `t04-${IMAGE_FORMAT}-${WIDTH}x${HEIGHT}-${index + 1}`;
    const workerStartedAt = process.hrtime.bigint();
    const child = utilityProcess.fork(workerEntry, [], {
      serviceName: "ClipNest T04 16MP Measurement",
      stdio: "ignore",
    });
    let sampler;
    let spawnMs;
    let memoryBefore;
    let decodeStartedAt;
    try {
      await waitForSpawn(child);
      spawnMs = Number(process.hrtime.bigint() - workerStartedAt) / 1_000_000;
      if (!child.pid) throw new Error("image_worker_pid_unavailable");
      sampler = startWindowsMemorySampler(child.pid, SAMPLE_INTERVAL_MS);
      await sampler.ready;
      sampler.startSampling();
      memoryBefore = await sampler.snapshot();
      decodeStartedAt = process.hrtime.bigint();
      const image = await decode(child, requestId, encodedBytes, WIDTH, HEIGHT, IMAGE_FORMAT);
      const decodeMs = Number(process.hrtime.bigint() - decodeStartedAt) / 1_000_000;
      assert.equal(image.width, WIDTH);
      assert.equal(image.height, HEIGHT);
      assert.equal(image.pixels.byteLength, PIXELS * 4);
      if (IMAGE_FORMAT === "png") {
        assertPixel(image.pixels, 0, 0);
        assertPixel(image.pixels, WIDTH - 1, HEIGHT - 1);
      } else {
        assertOpaquePixels(image.pixels);
      }
      const memoryAfter = await sampler.snapshot();
      const memory = await sampler.stop();
      workers.push({ pid: child.pid, spawnMs: round(spawnMs), peakWorkingSetBytes: memory.peakWorkingSetBytes,
        sampledPeakPrivateBytes: memory.sampledPeakPrivateBytes, workingSetAtStopBytes: memory.workingSetAtStopBytes,
        privateBytesAtStop: memory.privateBytesAtStop, samplerSamples: memory.sampleCount });
      samples.push({ requestId, durationMs: round(decodeMs), workerStartupMs: round(spawnMs), outcome: "success",
        workingSetBeforeBytes: memoryBefore.workingSetBytes, privateBytesBefore: memoryBefore.privateBytes,
        workingSetAfterBytes: memoryAfter.workingSetBytes, privateBytesAfter: memoryAfter.privateBytes,
        responsePayloadBytes: image.transportBytes ?? image.pixels.byteLength,
        peakWorkingSetBytes: memory.peakWorkingSetBytes, sampledPeakPrivateBytes: memory.sampledPeakPrivateBytes });
      child.kill();
      await waitForExit(child);
    } catch (error) {
      if (IMAGE_FORMAT === "jpeg" && error.message === "image_worker_capacity_exceeded" && sampler && memoryBefore && decodeStartedAt) {
        const rejectMs = Number(process.hrtime.bigint() - decodeStartedAt) / 1_000_000;
        const memoryAfter = await sampler.snapshot();
        const memory = await sampler.stop();
        workers.push({ pid: child.pid, spawnMs: round(spawnMs), outcome: "capacity_rejected",
          peakWorkingSetBytes: memory.peakWorkingSetBytes, sampledPeakPrivateBytes: memory.sampledPeakPrivateBytes,
          workingSetAtStopBytes: memory.workingSetAtStopBytes, privateBytesAtStop: memory.privateBytesAtStop,
          samplerSamples: memory.sampleCount });
        samples.push({ requestId, durationMs: round(rejectMs), workerStartupMs: round(spawnMs),
          outcome: "capacity_rejected", error: "image_worker_capacity_exceeded",
          workingSetBeforeBytes: memoryBefore.workingSetBytes, privateBytesBefore: memoryBefore.privateBytes,
          workingSetAfterBytes: memoryAfter.workingSetBytes, privateBytesAfter: memoryAfter.privateBytes,
          responsePayloadBytes: null, peakWorkingSetBytes: memory.peakWorkingSetBytes,
          sampledPeakPrivateBytes: memory.sampledPeakPrivateBytes });
        child.kill();
        await waitForExit(child);
        continue;
      }
      if (sampler) await sampler.stop().catch(() => undefined);
      child.kill();
      await waitForExit(child).catch(() => undefined);
      throw error;
    }
  }

  const peakWorkingSetBytes = Math.max(...workers.map((worker) => worker.peakWorkingSetBytes));
  const sampledPeakPrivateBytes = Math.max(...workers.map((worker) => worker.sampledPeakPrivateBytes));
  const totalSamplerSamples = workers.reduce((total, worker) => total + worker.samplerSamples, 0);
  const successfulSamples = samples.filter((sample) => sample.outcome === "success");
  const capacityRejectedSamples = samples.filter((sample) => sample.outcome === "capacity_rejected");
  const measurement = {
    schemaVersion: 1,
    task: "T04",
    result: capacityRejectedSamples.length === samples.length
      ? "DIAGNOSTIC_CAPACITY_REJECTION_WITH_LIMITATIONS" : "DIAGNOSTIC_MEASUREMENT_WITH_LIMITATIONS",
    measurementType: `fresh_utility_process_per_uncached_${PIXELS}-pixel_synthetic_${IMAGE_FORMAT}_decode`,
    executionStatus: capacityRejectedSamples.length === samples.length ? "MEASURED_CAPACITY_REJECTION" : "MEASURED",
    source: {
      commit: gitValue("rev-parse", "HEAD"),
      branch: gitValue("branch", "--show-current"),
      workingTreeWasDirty: gitValue("status", "--short").length > 0,
    },
    environment: {
      platform: process.platform,
      architecture: process.arch,
      osVersion: os.version(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      cpuModel: os.cpus()[0]?.model ?? null,
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      displayOrForegroundAppUsed: false,
      systemClipboardReadOrWritten: false,
      inputSent: false,
    },
    fixture: {
      format: IMAGE_FORMAT,
      width: WIDTH,
      height: HEIGHT,
      pixelCount: PIXELS,
      content: IMAGE_FORMAT === "png"
        ? "deterministic synthetic RGBA gradient/noise PNG; no user data"
        : "deterministic high-entropy synthetic baseline JPEG; APP2 segments bring the source within 3 bytes of 20 MiB; no user data",
      encodedBytes: encodedBytes.byteLength,
      sourceLimitBytes: 20 * 1024 * 1024,
      sourceLimitHeadroomBytes: 20 * 1024 * 1024 - encodedBytes.byteLength,
      jpegQuality: jpegFixture?.quality ?? null,
      jpegImageBytesBeforeApp2Padding: jpegFixture?.imageBytesBeforePadding ?? null,
      jpegApp2PaddingBytes: jpegFixture?.app2PaddingBytes ?? null,
      sha256: imageSha256,
    },
    worker: {
      runtime: "Electron utilityProcess",
      recyclingPolicy: "one fresh process per uncached image larger than the 32 MiB decoded cache",
      configuredPeakBytes: WORKER_LIMIT_BYTES,
      processes: workers,
      observedPeakWorkingSetBytes: peakWorkingSetBytes,
      observedPeakWorkingSetMiB: round(peakWorkingSetBytes / 1024 / 1024),
      sampledPeakPrivateBytes,
      sampledPeakPrivateMiB: round(sampledPeakPrivateBytes / 1024 / 1024),
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      totalSamplerSamples,
      withinConfiguredPeakWorkingSet: peakWorkingSetBytes <= WORKER_LIMIT_BYTES,
    },
    latency: {
      sampleCount: samples.length,
      successfulSampleCount: successfulSamples.length,
      capacityRejectedSampleCount: capacityRejectedSamples.length,
      samples,
      p50Ms: successfulSamples.length ? percentile(successfulSamples.map((sample) => sample.durationMs), 0.5) : null,
      p95Ms: successfulSamples.length ? percentile(successfulSamples.map((sample) => sample.durationMs), 0.95) : null,
      maxMs: successfulSamples.length ? Math.max(...successfulSamples.map((sample) => sample.durationMs)) : null,
      capacityRejectP50Ms: capacityRejectedSamples.length
        ? percentile(capacityRejectedSamples.map((sample) => sample.durationMs), 0.5) : null,
      capacityRejectP95Ms: capacityRejectedSamples.length
        ? percentile(capacityRejectedSamples.map((sample) => sample.durationMs), 0.95) : null,
      p50WorkerStartupMs: percentile(samples.map((sample) => sample.workerStartupMs), 0.5),
      p95WorkerStartupMs: percentile(samples.map((sample) => sample.workerStartupMs), 0.95),
      maxWorkerStartupMs: Math.max(...samples.map((sample) => sample.workerStartupMs)),
      timingScope: "fresh utility process ready, then request post through decompressed 64,000,000-byte RGBA response receipt",
      diagnosticOnly: true,
      doesNotSatisfyNormalTextOrWake100SampleAcceptance: true,
    },
    limitations: [
      "Fresh-process synthetic 16MP samples are diagnostic; they do not satisfy the T05 100-sample controlled desktop timing gates or measure end-user paste latency.",
      IMAGE_FORMAT === "png"
        ? "The PNG input is one generated gradient/noise fixture; JPEG, other image content, UI responsiveness and original clipboard conversion are not covered."
        : "The JPEG is a generated baseline image with synthetic APP2 padding to exercise the encoded-source ceiling; progressive JPEG, real EXIF/ICC metadata, other image content, UI responsiveness and original clipboard conversion are not covered.",
      capacityRejectedSamples.length > 0
        ? "A valid under-limit fixture may receive image_worker_capacity_exceeded from the decoder's internal 256 MiB allocation guard; a capacity rejection is fail-closed behavior, not a successful decode or proof of process peak under every input."
        : "No fixture was rejected by the decoder's internal capacity guard in this sample set; this does not establish a universal process-memory ceiling.",
      `PeakWorkingSet64 is the OS-reported peak for each fresh process; private bytes are sampled every ${SAMPLE_INTERVAL_MS} ms and around each decode, so shorter private-memory peaks can be missed. These observations do not prove a hard ceiling for every decode.`,
      "No clipboard, target window, physical input, installed package, helper, or rollback behavior was exercised. P15 and full T04 acceptance remain open.",
    ],
  };
  fs.writeFileSync(outputPath, `${JSON.stringify(measurement, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ outputPath, sampleCount: samples.length, successCount: successfulSamples.length,
    capacityRejectedCount: capacityRejectedSamples.length, p50Ms: measurement.latency.p50Ms, p95Ms: measurement.latency.p95Ms,
    capacityRejectP95Ms: measurement.latency.capacityRejectP95Ms, p95WorkerStartupMs: measurement.latency.p95WorkerStartupMs,
    peakWorkingSetBytes, sampledPeakPrivateBytes, sourceBytes: encodedBytes.byteLength })}\n`);
  app.exit(0);
}

function decode(child, requestId, bytes, width, height, format) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`image_decode_timeout:${requestId}`)), 30_000);
    const onMessage = (eventOrMessage) => {
      const message = eventOrMessage && eventOrMessage.data !== undefined ? eventOrMessage.data : eventOrMessage;
      if (!message || message.requestId !== requestId) return;
      if (message.type === "failed") finish(new Error(message.reason || "image_decode_failed"));
      else if (message.type === "decoded") finish(null, {
        ...message.image,
        transportBytes: message.image.pixels.byteLength,
      });
      else if (message.type === "decoded_compressed") {
        const compressed = Buffer.from(message.compressedPixels.buffer,
          message.compressedPixels.byteOffset, message.compressedPixels.byteLength);
        inflateExact(compressed, message.uncompressedBytes).then((pixels) => {
          finish(null, { width: message.width, height: message.height, pixels, transportBytes: compressed.byteLength });
        }, finish);
      }
      else finish(new Error("image_worker_response_invalid"));
    };
    const onExit = () => finish(new Error("image_worker_exited"));
    const finish = (error, image) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(image);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
    try {
      child.postMessage({
        type: "decode",
        requestId,
        input: {
          jobId: requestId,
          format,
          encodedBytes: Uint8Array.from(bytes),
          width,
          height,
        },
      });
    } catch (error) {
      finish(error);
    }
  });
}

function inflateExact(compressed, expectedBytes) {
  return new Promise((resolve, reject) => {
    const inflater = createInflate({ chunkSize: INFLATE_CHUNK_BYTES });
    const pixels = Buffer.allocUnsafe(expectedBytes);
    let outputBytes = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      inflater.destroy();
      reject(error);
    };
    inflater.on("data", (chunk) => {
      if (settled) return;
      if (outputBytes + chunk.byteLength > expectedBytes) {
        fail(new Error("image_worker_response_invalid"));
        return;
      }
      chunk.copy(pixels, outputBytes);
      outputBytes += chunk.byteLength;
    });
    inflater.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    inflater.once("end", () => {
      if (settled) return;
      settled = true;
      if (outputBytes !== expectedBytes) reject(new Error("image_worker_response_invalid"));
      else resolve(pixels);
    });
    inflater.end(compressed);
  });
}

function buildSyntheticPng(width, height) {
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (rowBytes + 1) + 1; // filter byte remains 0
    const gy = y & 0xff;
    for (let x = 0; x < width; x++) {
      const offset = row + x * 4;
      const gx = x & 0xff;
      const noise = (Math.imul(x, 31) + Math.imul(y, 17) + (x >>> 5) ^ (y << 3)) & 0x0f;
      raw[offset] = gx;
      raw[offset + 1] = gy;
      raw[offset + 2] = (gx + gy + noise) & 0xff;
      raw[offset + 3] = 0xff;
    }
  }
  const compressed = zlib.deflateSync(raw, { level: 6 });
  const pngCrc = require("pngjs/lib/crc");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);

  function chunk(type, data) {
    const output = Buffer.alloc(data.byteLength + 12);
    output.writeUInt32BE(data.byteLength, 0);
    output.write(type, 4, 4, "ascii");
    data.copy(output, 8);
    output.writeUInt32BE(pngCrc.crc32(output.subarray(4, output.length - 4)) >>> 0, output.length - 4);
    return output;
  }
}

function buildSyntheticJpeg(width, height) {
  const pixels = Buffer.allocUnsafe(width * height * 4);
  let state = 0x6d2b79f5;
  for (let offset = 0; offset < pixels.byteLength; offset += 4) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    pixels[offset] = state & 0xff;
    pixels[offset + 1] = (state >>> 8) & 0xff;
    pixels[offset + 2] = (state >>> 16) & 0xff;
    pixels[offset + 3] = 0xff;
  }

  const jpeg = require("jpeg-js");
  const qualities = [82, 78, 74, 70, 66, 62, 58, 54, 50, 46, 42, 38];
  let quality = null;
  let imageBytes = null;
  for (const candidate of qualities) {
    const encoded = Buffer.from(jpeg.encode({ width, height, data: pixels }, candidate).data);
    if (encoded.byteLength < 20 * 1024 * 1024) {
      quality = candidate;
      imageBytes = encoded;
      break;
    }
  }
  if (!imageBytes) throw new Error("synthetic_jpeg_cannot_fit_source_limit");

  const sourceLimitBytes = 20 * 1024 * 1024;
  const targetBytes = sourceLimitBytes - ((sourceLimitBytes - imageBytes.byteLength) % 4);
  const app2PaddingBytes = targetBytes - imageBytes.byteLength;
  const segments = [];
  let remaining = app2PaddingBytes;
  while (remaining > 0) {
    const segmentBytes = Math.min(65_536, remaining);
    const payloadBytes = segmentBytes - 4;
    const segment = Buffer.alloc(segmentBytes);
    segment[0] = 0xff;
    segment[1] = 0xe2; // APP2; unlike COM, jpeg-js does not stringify its payload.
    segment.writeUInt16BE(payloadBytes + 2, 2);
    segments.push(segment);
    remaining -= segmentBytes;
  }

  const bytes = Buffer.concat([imageBytes.subarray(0, 2), ...segments, imageBytes.subarray(2)]);
  return { bytes, quality, imageBytesBeforePadding: imageBytes.byteLength, app2PaddingBytes };
}

function assertPixel(pixels, x, y) {
  const offset = (y * WIDTH + x) * 4;
  const gx = x & 0xff;
  const gy = y & 0xff;
  const noise = (Math.imul(x, 31) + Math.imul(y, 17) + (x >>> 5) ^ (y << 3)) & 0x0f;
  assert.deepEqual([...pixels.subarray(offset, offset + 4)], [gx, gy, (gx + gy + noise) & 0xff, 0xff]);
}

function assertOpaquePixels(pixels) {
  for (const offset of [0, (PIXELS >> 1) * 4, (PIXELS - 1) * 4]) {
    assert.equal(pixels[offset + 3], 0xff, "decoded JPEG pixels must remain opaque RGBA");
  }
}

function startWindowsMemorySampler(pid, intervalMs) {
  const script = [
    "$ErrorActionPreference='Stop'",
    `$p=Get-Process -Id ${pid}`,
    "[Console]::Out.WriteLine('READY')",
    "while($true){$command=[Console]::In.ReadLine();if($command -eq 'STOP'){break};$p.Refresh();[Console]::Out.WriteLine(('SAMPLE,{0},{1},{2}' -f $command,$p.WorkingSet64,$p.PrivateMemorySize64))}",
    "$p.Refresh()",
    "[Console]::Out.WriteLine(('FINAL,{0},{1},{2}' -f $p.PeakWorkingSet64,$p.WorkingSet64,$p.PrivateMemorySize64))"
  ].join(";");
  const process = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let buffered = "";
  const sampleRows = [];
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let resolveClosed;
  let rejectClosed;
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
  let ticker = null;
  let stopPromise = null;
  let nextSnapshotId = 0;
  const snapshotWaiters = new Map();
  process.stdout.setEncoding("utf8");
  process.stdout.on("data", (chunk) => {
    buffered += chunk;
    const rows = buffered.split(/\r?\n/);
    buffered = rows.pop() ?? "";
    for (const row of rows) {
      if (row === "READY") resolveReady();
      else if (row.startsWith("SAMPLE,")) {
        const [, tag, workingSet, privateBytes] = row.split(",");
        const sample = { workingSetBytes: Number(workingSet), privateBytes: Number(privateBytes) };
        sampleRows.push([sample.workingSetBytes, sample.privateBytes]);
        const waiter = snapshotWaiters.get(tag);
        if (waiter) { snapshotWaiters.delete(tag); waiter(sample); }
      }
      else if (row.startsWith("FINAL,")) {
        const values = row.split(",").slice(1).map(Number);
        resolveClosed({ peakWorkingSetBytes: values[0], workingSetAtStopBytes: values[1], privateBytesAtStop: values[2], sampleRows });
      }
    }
  });
  process.on("error", rejectReady);
  process.on("close", (code) => { if (code !== 0) rejectClosed(new Error(`powershell_sampler_exit_${code}`)); });
  process.stderr.setEncoding("utf8");
  let stderr = "";
  process.stderr.on("data", (chunk) => { stderr += chunk; });
  return {
    ready: Promise.race([ready, closed.then(() => { throw new Error("sampler_closed_before_ready"); })]),
    startSampling() {
      if (ticker) return;
      ticker = setInterval(() => { if (!process.stdin.destroyed) process.stdin.write("TICK\n"); }, intervalMs);
    },
    snapshot() {
      const tag = `SNAPSHOT_${++nextSnapshotId}`;
      return Promise.race([
        new Promise((resolve, reject) => {
          snapshotWaiters.set(tag, resolve);
          process.stdin.write(`${tag}\n`, (error) => {
            if (error) { snapshotWaiters.delete(tag); reject(error); }
          });
        }),
        delayReject(10_000, "sampler_snapshot_timeout"),
      ]);
    },
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        if (process.exitCode !== null) throw new Error(`sampler_exited_early:${stderr}`);
        if (ticker) clearInterval(ticker);
        process.stdin.write("STOP\n");
        const result = await Promise.race([closed, delayReject(10_000, `sampler_stop_timeout:${stderr}`)]);
        return {
          ...result,
          sampledPeakPrivateBytes: Math.max(0, ...sampleRows.map((row) => row[1])),
          sampleCount: sampleRows.length,
        };
      })();
      return stopPromise;
    },
  };
}

function gitValue(...args) {
  try { return spawnSync("git", args, { cwd: ROOT, encoding: "utf8" }).stdout.trim(); }
  catch { return ""; }
}
function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
}
function round(value) { return Math.round(value * 100) / 100; }
function delayReject(milliseconds, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds));
}
function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delayReject(10_000, "image_worker_exit_timeout"),
  ]);
}
function waitForSpawn(child) {
  if (child.pid) return Promise.resolve();
  return Promise.race([
    new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("exit", (code) => reject(new Error(`image_worker_exited_before_spawn:${code}`)));
    }),
    delayReject(10_000, "image_worker_spawn_timeout"),
  ]);
}
