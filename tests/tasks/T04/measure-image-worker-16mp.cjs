// Diagnostic Windows x64 measurement using a synthetic PNG/JPEG, an isolated
// Electron profile, and a fresh utility process. It never accesses the system
// clipboard or sends input to another application.
const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

const ROOT = path.resolve(__dirname, "../../..");
const WIDTH = Math.max(1, Math.trunc(Number(process.env.T04_IMAGE_WIDTH) || 4000));
const HEIGHT = Math.max(1, Math.trunc(Number(process.env.T04_IMAGE_HEIGHT) || 4000));
const PIXELS = WIDTH * HEIGHT;
const WORKER_LIMIT_BYTES = 256 * 1024 * 1024;
const IMAGE_RESPONSE_CHUNK_BYTES = 1024 * 1024;
const SAMPLE_COUNT = Math.min(5, Math.max(1, Number(process.env.T04_IMAGE_SAMPLE_COUNT) || 5));
const SAMPLE_INTERVAL_MS = Math.max(50, Number(process.env.T04_IMAGE_SAMPLE_INTERVAL_MS) || 100);
const IMAGE_FORMAT = process.env.T04_IMAGE_FORMAT || "png";
const JPEG_ENCODER = process.env.T04_JPEG_ENCODER || "jpeg-js";
const MEASUREMENT_TAG = process.env.T04_IMAGE_MEASUREMENT_TAG || "";
if (IMAGE_FORMAT !== "png" && IMAGE_FORMAT !== "jpeg") throw new Error("unsupported_t04_image_format");
if (JPEG_ENCODER !== "jpeg-js" && JPEG_ENCODER !== "native-image") throw new Error("unsupported_t04_jpeg_encoder");
if (MEASUREMENT_TAG && !/^[a-z0-9-]{1,40}$/.test(MEASUREMENT_TAG)) throw new Error("invalid_t04_measurement_tag");
if (!Number.isSafeInteger(PIXELS) || PIXELS > 16_000_000) throw new Error("synthetic_image_exceeds_pixel_limit");

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clipnest-t04-image-worker-"));
  try {
    assertTemporaryProfileRoot(profileRoot);
    const userDataPath = path.join(profileRoot, "user-data");
    const sessionDataPath = path.join(profileRoot, "session-data");
    fs.mkdirSync(userDataPath);
    fs.mkdirSync(sessionDataPath);
    env.T04_PROFILE_ROOT = profileRoot;
    env.T04_USER_DATA_PATH = userDataPath;
    env.T04_SESSION_DATA_PATH = sessionDataPath;
    env.T04_WORKER_STAGE_TIMING = "1";
    const electronBinary = process.env.T04_ELECTRON_BIN
      ? path.resolve(process.env.T04_ELECTRON_BIN)
      : require("electron");
    const result = spawnSync(electronBinary, [`--user-data-dir=${userDataPath}`, __filename], {
      cwd: ROOT,
      env,
      stdio: "inherit",
      timeout: 180_000,
      windowsHide: true,
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    assertTemporaryProfileRoot(profileRoot);
    fs.rmSync(profileRoot, { recursive: true, force: true });
    const cleanupVerified = !fs.existsSync(profileRoot);
    if (cleanupVerified) recordProfileCleanup(measurementOutputPath());
    if (!cleanupVerified) throw new Error("t04_profile_cleanup_failed");
    process.stdout.write("T04_PROFILE_CLEANUP=PASS\n");
  }
} else {
  runMeasurement().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    require("electron").app.exit(1);
  });
}

async function runMeasurement() {
  const { app, utilityProcess } = require("electron");
  const profileRoot = process.env.T04_PROFILE_ROOT;
  const userDataPath = process.env.T04_USER_DATA_PATH;
  const sessionDataPath = process.env.T04_SESSION_DATA_PATH;
  if (!profileRoot || !userDataPath || !sessionDataPath) throw new Error("isolated_electron_profile_required");
  assertTemporaryProfileRoot(profileRoot);
  assertInsideProfile(profileRoot, userDataPath);
  assertInsideProfile(profileRoot, sessionDataPath);
  app.setPath("userData", userDataPath);
  app.setPath("sessionData", sessionDataPath);
  const workerEntry = path.join(ROOT, "dist-electron", "main", "clipboard", "image-worker.js");
  const outputPath = measurementOutputPath();
  if (fs.existsSync(outputPath)) throw new Error(`measurement_output_exists; choose a unique T04_IMAGE_MEASUREMENT_TAG:${outputPath}`);
  assert.ok(fs.existsSync(workerEntry), `compiled worker entry missing: ${workerEntry}`);
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error(`measurement_requires_windows_x64:${process.platform}:${process.arch}`);
  }

  await app.whenReady();
  const jpegFixture = IMAGE_FORMAT === "jpeg" ? buildSyntheticJpeg(WIDTH, HEIGHT, JPEG_ENCODER) : null;
  const encodedBytes = jpegFixture?.bytes ?? buildSyntheticPng(WIDTH, HEIGHT);
  if (encodedBytes.byteLength > 20 * 1024 * 1024) throw new Error("synthetic_image_exceeds_source_limit");
  const imageSha256 = createHash("sha256").update(encodedBytes).digest("hex");
  const pixelOracle = jpegFixture ? runIndependentPixelOracle(encodedBytes, profileRoot) : null;
  const samples = [];
  const workers = [];
  const pixelOracleChecks = [];
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
        if (pixelOracle?.status === "READY") {
          pixelOracleChecks.push(comparePixelsWithOracle(image.pixels, pixelOracle));
        }
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
        stageTimings: image.stageTimings ?? null,
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
      workingTreeFiles: [
        "src/main/clipboard/image-decoder.ts",
        "src/main/clipboard/jpeg-baseline-stream.ts",
        "src/main/clipboard/image-worker.ts",
      ].map((file) => ({ path: file, sha256: fileSha256(path.join(ROOT, file)) })),
      builtArtifactFiles: [
        "dist-electron/main/clipboard/image-decoder.js",
        "dist-electron/main/clipboard/jpeg-baseline-stream.js",
        "dist-electron/main/clipboard/image-worker.js",
      ].map((file) => ({ path: file, sha256: fileSha256(path.join(ROOT, file)) })),
      measurementHarnessFiles: [
        "tests/tasks/T04/measure-image-worker-16mp.cjs",
        "tests/tasks/T04/purejsimage-independent-pixel-oracle.ps1",
      ].map((file) => ({ path: file, sha256: fileSha256(path.join(ROOT, file)) })),
    },
    environment: {
      platform: process.platform,
      architecture: process.arch,
      osVersion: os.version(),
      electronVersion: process.versions.electron,
      electronBinaryPath: process.execPath,
      profileIsolation: {
        isolated: true,
        userDataDirectory: "unique validated child of the OS temporary directory",
        sessionDataDirectory: "unique validated child of the OS temporary directory",
        cleanupPolicy: "remove the validated per-run root after Electron exits",
        cleanupVerified: null,
      },
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
        : "deterministic high-entropy synthetic baseline JPEG padded with APP2 segments near the 20 MiB source limit; no user data",
      encodedBytes: encodedBytes.byteLength,
      sourceLimitBytes: 20 * 1024 * 1024,
      sourceLimitHeadroomBytes: 20 * 1024 * 1024 - encodedBytes.byteLength,
      jpegQuality: jpegFixture?.quality ?? null,
      jpegEncoder: jpegFixture?.encoder ?? null,
      jpegImageBytesBeforeApp2Padding: jpegFixture?.imageBytesBeforePadding ?? null,
      jpegApp2PaddingBytes: jpegFixture?.app2PaddingBytes ?? null,
      jpegSamplingFactors: jpegFixture?.samplingFactors ?? null,
      sha256: imageSha256,
      independentPixelOracle: summarizePixelOracle(pixelOracle, pixelOracleChecks),
    },
    worker: {
      runtime: "Electron utilityProcess",
      recyclingPolicy: "one fresh process per uncached image larger than the 32 MiB decoded cache",
      configuredPeakBytes: WORKER_LIMIT_BYTES,
      jpegCapacityEstimate: IMAGE_FORMAT === "jpeg" ? {
        processReserveBytes: 112 * 1024 * 1024,
        coefficientBlockBytes: 512,
        quantizationTableBytes: 512,
        huffmanTableBytes: 4096,
        huffmanSymbolBytes: 2048,
        commentByteMultiplier: 2,
        metadataLimits: { quantizationTables: 64, huffmanTables: 64, huffmanSymbolsPerTable: 256, commentBytes: 1024 * 1024 },
        maximumMarkerSegments: 4096,
        includes: "encoded input copies, coefficient blocks, component lines, RGB intermediate, RGBA output, JPEG tables, Huffman trees, and decoded comments",
      } : null,
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
      timingScope: `fresh utility process ready, then request post through ${PIXELS * 4}-byte RGBA response receipt`,
      stageTimingDefinitions: {
        decodeMs: "utility process decoder duration",
        chunkSendMs: "utility process first chunk send through receipt of the final chunk ACK",
        requestToFirstChunkMessageMs: "parent postMessage through receipt of the first raw pixel chunk",
        parentChunkTransferMs: "parent receipt of first raw pixel chunk through validated end message",
      },
      diagnosticOnly: true,
      doesNotSatisfyNormalTextOrWake100SampleAcceptance: true,
      responsePayloadBytesMeaning: "sum of raw RGBA IPC chunk bytes (transportBytes)",
    },
    limitations: [
      `Fresh-process synthetic ${PIXELS}-pixel samples are diagnostic; they do not satisfy the T05 100-sample controlled desktop timing gates or measure end-user paste latency.`,
      IMAGE_FORMAT === "png"
        ? "The PNG input is one generated gradient/noise fixture; JPEG, other image content, UI responsiveness and original clipboard conversion are not covered."
        : "The JPEG is a generated baseline image with synthetic APP2 padding to exercise the encoded-source ceiling; progressive JPEG, real EXIF/ICC metadata, other image content, UI responsiveness and original clipboard conversion are not covered.",
      capacityRejectedSamples.length > 0
        ? IMAGE_FORMAT === "jpeg"
          ? "The measured JPEG sample set was capacity-rejected and did not prove successful full-resolution decode; the observed low peak applies only to these synthetic SOF layouts and is not a universal process-memory ceiling."
          : "A capacity rejection is fail-closed behavior, not a successful decode or proof of process peak under every input."
        : "No fixture was rejected by the decoder's internal capacity guard in this sample set; this does not establish a universal process-memory ceiling.",
      `PeakWorkingSet64 is the OS-reported peak for each fresh process; private bytes are sampled every ${SAMPLE_INTERVAL_MS} ms and around each decode, so shorter private-memory peaks can be missed. These observations do not prove a hard ceiling for every decode.`,
      "No clipboard, target window, physical input, installed package, helper, or rollback behavior was exercised. P15 and full T04 acceptance remain open.",
      "This harness sets unique userData and sessionData paths under the OS temporary directory and removes the validated per-run root only after Electron exits.",
      pixelOracle?.status === "READY"
        ? "Decoded RGB values were compared at nine coordinates with the independent Windows System.Drawing/GDI+ JPEG decoder using a maximum per-channel tolerance of 8. This is a sampled oracle, not a full-image pixel hash."
        : "No independent RGB oracle was run for this fixture.",
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
    let requestPostedAt = 0n;
    const expectedBytes = width * height * 4;
    const pixels = Buffer.allocUnsafe(expectedBytes);
    let nextSeq = 0;
    let receivedBytes = 0;
    let transportBytes = 0;
    let firstChunkAt = 0n;
    const onMessage = (eventOrMessage) => {
      const message = eventOrMessage && eventOrMessage.data !== undefined ? eventOrMessage.data : eventOrMessage;
      if (!message || message.requestId !== requestId) {
        finish(new Error("image_worker_response_invalid"));
        return;
      }
      if (message.type === "failed") finish(new Error(message.reason || "image_decode_failed"));
      else if (message.type === "decoded") {
        if (!message.image || message.image.width !== width || message.image.height !== height ||
            !(message.image.pixels instanceof Uint8Array) || message.image.pixels.byteLength !== expectedBytes) {
          finish(new Error("image_worker_response_invalid"));
          return;
        }
        finish(null, { ...message.image, transportBytes: message.image.pixels.byteLength });
      } else if (message.type === "decoded_chunk") {
        const chunk = message.pixels;
        if (!Number.isSafeInteger(message.seq) || message.seq !== nextSeq || !(chunk instanceof Uint8Array) ||
            chunk.byteLength === 0 || chunk.byteLength > IMAGE_RESPONSE_CHUNK_BYTES ||
            receivedBytes + chunk.byteLength > expectedBytes) {
          finish(new Error("image_worker_response_invalid"));
          return;
        }
        if (firstChunkAt === 0n) firstChunkAt = process.hrtime.bigint();
        Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(pixels, receivedBytes);
        receivedBytes += chunk.byteLength;
        transportBytes += chunk.byteLength;
        const seq = nextSeq++;
        try { child.postMessage({ type: "decoded_chunk_ack", requestId, seq }); }
        catch (error) { finish(error); }
      } else if (message.type === "decoded_end") {
        if (message.width !== width || message.height !== height || message.byteLength !== expectedBytes ||
            message.chunkCount !== nextSeq || receivedBytes !== expectedBytes || firstChunkAt === 0n) {
          finish(new Error("image_worker_response_invalid"));
          return;
        }
        const endedAt = process.hrtime.bigint();
        finish(null, {
          width, height, pixels, transportBytes,
          stageTimings: {
            ...(message.stageTimings ?? {}),
            requestToFirstChunkMessageMs: round(Number(firstChunkAt - requestPostedAt) / 1_000_000),
            parentChunkTransferMs: round(Number(endedAt - firstChunkAt) / 1_000_000),
          },
        });
      } else finish(new Error("image_worker_response_invalid"));
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
      requestPostedAt = process.hrtime.bigint();
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

function runIndependentPixelOracle(encodedBytes, profileRoot) {
  if (JPEG_ENCODER !== "jpeg-js") {
    return { status: "NOT_RUN", reason: "RGB tolerance is calibrated only for the deterministic 4:4:4 jpeg-js fixture" };
  }
  if (WIDTH !== 4000 || HEIGHT !== 4000) {
    return { status: "NOT_RUN", reason: "the existing independent GDI+ oracle is fixed to 4000x4000" };
  }
  const imagePath = path.join(profileRoot, "synthetic-jpeg-fixture.jpg");
  fs.writeFileSync(imagePath, encodedBytes);
  const points = [
    { x: 0, y: 0 }, { x: WIDTH - 1, y: 0 }, { x: 0, y: HEIGHT - 1 },
    { x: WIDTH - 1, y: HEIGHT - 1 }, { x: Math.floor(WIDTH / 2), y: Math.floor(HEIGHT / 2) },
    { x: Math.floor(WIDTH / 4), y: Math.floor(HEIGHT / 4) },
    { x: Math.floor(WIDTH * 3 / 4), y: Math.floor(HEIGHT / 4) },
    { x: Math.floor(WIDTH / 4), y: Math.floor(HEIGHT * 3 / 4) },
    { x: Math.floor(WIDTH * 3 / 4), y: Math.floor(HEIGHT * 3 / 4) },
  ];
  const scriptPath = path.join(__dirname, "purejsimage-independent-pixel-oracle.ps1");
  const result = spawnSync("powershell.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-File", scriptPath,
    "-ImagePath", imagePath, "-CoordinateJson", JSON.stringify(points),
  ], { cwd: ROOT, encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (result.error) return { status: "ERROR", reason: String(result.error) };
  if (result.status !== 0) {
    return { status: "ERROR", reason: `powershell_exit_${result.status}:${result.stderr || result.stdout}` };
  }
  let oracle;
  try { oracle = JSON.parse(result.stdout.trim()); }
  catch (error) { return { status: "ERROR", reason: `invalid_gdiplus_oracle_json:${error}` }; }
  return {
    status: "READY",
    decoder: oracle.decoder,
    powershellVersion: oracle.powershellVersion,
    dotNetRuntime: oracle.dotNetRuntime,
    pixelFormat: oracle.pixelFormat,
    samples: oracle.samples,
  };
}

function comparePixelsWithOracle(pixels, oracle) {
  let maxRgbDifference = 0;
  let alphaValid = true;
  const samples = oracle.samples.map((sample) => {
    const offset = (sample.y * WIDTH + sample.x) * 4;
    const actualRgba = [...pixels.subarray(offset, offset + 4)];
    const maxSampleDifference = Math.max(
      Math.abs(actualRgba[0] - sample.rgba[0]),
      Math.abs(actualRgba[1] - sample.rgba[1]),
      Math.abs(actualRgba[2] - sample.rgba[2]),
    );
    alphaValid &&= actualRgba[3] === 255;
    maxRgbDifference = Math.max(maxRgbDifference, maxSampleDifference);
    return { x: sample.x, y: sample.y, expectedRgba: sample.rgba, actualRgba, maxRgbDifference: maxSampleDifference };
  });
  return { maxRgbDifference, alphaValid, samples };
}

function summarizePixelOracle(oracle, checks) {
  if (!oracle) return { status: "NOT_APPLICABLE", reason: "PNG fixture" };
  if (oracle.status !== "READY") return oracle;
  const maxRgbDifference = Math.max(0, ...checks.map((check) => check.maxRgbDifference));
  const passed = checks.length > 0 && checks.every((check) =>
    check.maxRgbDifference <= 8 && check.alphaValid);
  return {
    status: passed ? "PASS" : "FAIL",
    decoder: oracle.decoder,
    powershellVersion: oracle.powershellVersion,
    dotNetRuntime: oracle.dotNetRuntime,
    pixelFormat: oracle.pixelFormat,
    toleranceRgbDifference: 8,
    verifiedWorkerSamples: checks.length,
    maxRgbDifference,
    alphaValid: checks.length > 0 && checks.every((check) => check.alphaValid),
    samples: checks[0]?.samples ?? [],
  };
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

function buildSyntheticJpeg(width, height, encoder) {
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

  const qualities = encoder === "native-image"
    ? [100, 96, 92, 88, 84, 80, 76, 72, 68, 64, 60, 56, 52, 48, 44, 40]
    : [82, 78, 74, 70, 66, 62, 58, 54, 50, 46, 42, 38];
  const jpeg = encoder === "jpeg-js" ? require("jpeg-js") : null;
  const nativeBitmap = encoder === "native-image"
    ? require("electron").nativeImage.createFromBitmap(pixels, { width, height })
    : null;
  let quality = null;
  let imageBytes = null;
  for (const candidate of qualities) {
    const encoded = encoder === "jpeg-js"
      ? Buffer.from(jpeg.encode({ width, height, data: pixels }, candidate).data)
      : nativeBitmap.toJPEG(candidate);
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
  return { bytes, quality, encoder, imageBytesBeforePadding: imageBytes.byteLength, app2PaddingBytes,
    samplingFactors: readJpegSamplingFactors(imageBytes) };
}

function readJpegSamplingFactors(bytes) {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset++] !== 0xff) throw new Error("synthetic_jpeg_marker_invalid");
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) throw new Error("synthetic_jpeg_segment_invalid");
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      const components = bytes[offset + 7];
      const samplingFactors = [];
      for (let index = 0; index < components; index++) {
        const sampling = bytes[offset + 9 + index * 3];
        samplingFactors.push({ horizontal: sampling >> 4, vertical: sampling & 0x0f });
      }
      return samplingFactors;
    }
    offset += segmentLength;
  }
  throw new Error("synthetic_jpeg_sof_missing");
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

function assertTemporaryProfileRoot(root) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith("clipnest-t04-image-worker-")) {
    throw new Error("unsafe_t04_profile_root");
  }
}

function assertInsideProfile(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("unsafe_t04_profile_path");
  }
}

function fileSha256(file) {
  if (!fs.existsSync(file)) return null;
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
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

function measurementOutputPath() {
  const tagSuffix = MEASUREMENT_TAG ? `-${MEASUREMENT_TAG}` : "";
  const outputName = IMAGE_FORMAT === "png"
    ? `image-worker-16mp-fresh-worker${tagSuffix}-${SAMPLE_COUNT}-sample-measurement.json`
    : `image-worker-${PIXELS}-pixel-jpeg-${JPEG_ENCODER === "jpeg-js" ? "" : "native-image-"}20mib-fresh-worker${tagSuffix}-${SAMPLE_COUNT}-sample-measurement.json`;
  return path.join(ROOT, "docs", "evidence", "T04", outputName);
}

function recordProfileCleanup(file) {
  if (!fs.existsSync(file)) return;
  const measurement = JSON.parse(fs.readFileSync(file, "utf8"));
  measurement.environment.profileIsolation.cleanupVerified = true;
  fs.writeFileSync(file, `${JSON.stringify(measurement, null, 2)}\n`, "utf8");
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
