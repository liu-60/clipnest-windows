// Runs the production utility-process worker from the already-built app.asar.
// It deliberately bypasses ImagePreparationService and its 3000 ms deadline.
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { app, BrowserWindow } = require("electron");

const TEMP_ROOT = path.resolve("D:/ClipNest-work/.codex-temp-t04-asar-20261005-01");
const WIDTH = 4000;
const HEIGHT = 4000;
const PIXELS = WIDTH * HEIGHT;
const SOURCE_LIMIT_BYTES = 20 * 1024 * 1024;
const OUTPUT_BYTES = PIXELS * 4;
const EXPECTED_FIXTURE_SHA256 = "5f5178ce761193b569130af082740669cd16071de9ea733aa8968f4f8e9dc6a3";
const EXPECTED_RGBA_SHA256 = "f6f1c8619e4adc31a55adc532c5219ab7408bca3cafdcf677d0dde2a0fce83dc";
const asarPath = process.env.CLIPNEST_ASAR_PATH;
const configuredTempRoot = process.env.T04_ASAR_TEMP_ROOT;
assert.equal(path.resolve(configuredTempRoot ?? ""), TEMP_ROOT, "task-specific temp directory is required");
assert.equal(path.resolve(fs.realpathSync(configuredTempRoot ?? "")).toLowerCase(),
  path.resolve(TEMP_ROOT).toLowerCase(), "task-specific temp directory must not be a junction or symlink");
assert.equal(path.resolve(asarPath ?? ""), path.join(TEMP_ROOT, "output", "win-unpacked", "resources", "app.asar"),
  "the previously verified ASAR must be used");
assert.ok(fs.existsSync(asarPath), "previously verified ASAR must exist");
assert.equal(BrowserWindow.getAllWindows().length, 0, "no BrowserWindow may be created");

const packagedRequire = createRequire(path.join(asarPath, "package.json"));
const jpeg = packagedRequire("jpeg-js");
const jpegPackage = packagedRequire("jpeg-js/package.json");
const workerModulePath = packagedRequire.resolve("./dist-electron/main/clipboard/image-worker.js");
const { createUtilityProcessImageWorker } = packagedRequire("./dist-electron/main/clipboard/image-worker.js");
assert.equal(jpegPackage.version, "0.4.4");
assert.ok(packagedRequire.resolve("jpeg-js").includes("app.asar"), "JPEG encoder must resolve from the existing ASAR");

const fixturePath = path.join(TEMP_ROOT, "synthetic-4000x4000-20mib.jpg");
let worker;
let workerExitPromise;
let workerStopped = false;
let fixtureOwned = false;
const cleanupFixture = () => {
  if (!fixtureOwned) return true;
  try {
    fs.rmSync(fixturePath, { force: true });
    fixtureOwned = false;
    return true;
  } catch (error) {
    process.stderr.write(`fixture cleanup failed: ${error.stack ?? error}\n`);
    return false;
  }
};
const watchdog = setTimeout(() => {
  process.stderr.write("packaged ASAR 16 MP JPEG smoke timed out\n");
  try { worker?.child?.kill(); } catch { /* app.exit below is the bounded fallback. */ }
  cleanupFixture();
  app.exit(1);
}, 120_000);

app.whenReady().then(async () => {
  let exitCode = 1;
  try {
    assert.equal(process.platform, "win32");
    assert.equal(process.arch, "x64");
    assert.equal(process.env.T04_IMAGE_STAGE_TIMING, undefined);
    assert.equal(process.env.T04_WORKER_STAGE_TIMING, undefined);

    const fixture = buildSyntheticJpeg();
    const inputSha256 = createHash("sha256").update(fixture.bytes).digest("hex");
    assert.equal(fixture.bytes.byteLength, SOURCE_LIMIT_BYTES);
    assert.equal(inputSha256, EXPECTED_FIXTURE_SHA256, "input must match the established synthetic 16 MP fixture");
    assert.deepEqual(fixture.samplingFactors, [
      { horizontal: 1, vertical: 1 },
      { horizontal: 1, vertical: 1 },
      { horizontal: 1, vertical: 1 },
    ], "fixture must be SOF0 4:4:4");
    const fixtureFd = fs.openSync(fixturePath, "wx");
    fixtureOwned = true;
    try { fs.writeFileSync(fixtureFd, fixture.bytes); }
    finally { fs.closeSync(fixtureFd); }
    fixture.bytes = null;
    if (global.gc) global.gc();

    const encodedBytes = fs.readFileSync(fixturePath);
    assert.equal(createHash("sha256").update(encodedBytes).digest("hex"), EXPECTED_FIXTURE_SHA256);
    worker = createUtilityProcessImageWorker();
    const startedAt = process.hrtime.bigint();
    const stageTimings = {};
    const resultPromise = worker.decode({
      jobId: "packaged-asar-16mp-sof0-444",
      format: "jpeg",
      encodedBytes,
      width: WIDTH,
      height: HEIGHT,
    }, new AbortController().signal, (stage, durationMs) => { stageTimings[stage] = durationMs; });
    const child = worker.child;
    assert.ok(child, "production utilityProcess must start");
    workerExitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    let decodedChunkCount = 0;
    let decodedEndCount = 0;
    let decodedEnd = null;
    const unexpectedMessages = [];
    child.on("message", (message) => {
      if (!message || typeof message.type !== "string") return;
      if (message.type === "decoded_chunk") decodedChunkCount++;
      else if (message.type === "decoded_end") {
        decodedEndCount++;
        decodedEnd = { width: message.width, height: message.height,
          chunkCount: message.chunkCount, byteLength: message.byteLength };
      } else if (message.type !== "diagnostic_ready") unexpectedMessages.push(message.type);
    });

    const result = await resultPromise;
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    assert.deepEqual([result.width, result.height, result.pixels.byteLength], [WIDTH, HEIGHT, OUTPUT_BYTES]);
    const outputRgbaSha256 = createHash("sha256").update(result.pixels).digest("hex");
    assert.equal(outputRgbaSha256, EXPECTED_RGBA_SHA256,
      "output must match the established jpeg-js full-frame-validated RGBA hash");
    const expectedChunkCount = Math.ceil(OUTPUT_BYTES / (1024 * 1024));
    assert.equal(decodedChunkCount, expectedChunkCount);
    assert.equal(decodedEndCount, 1);
    assert.deepEqual(decodedEnd, {
      width: WIDTH, height: HEIGHT, chunkCount: expectedChunkCount, byteLength: OUTPUT_BYTES,
    });
    assert.deepEqual(unexpectedMessages, []);
    assert.ok(Number.isFinite(stageTimings.jpegStreamPlanParseMs),
      "JPEG streaming plan timing proves the packaged baseline streaming route ran");
    assert.ok(Number.isFinite(stageTimings.jpegHuffmanIdctWriteMs),
      "JPEG block timing proves the packaged streaming decoder processed the image");

    const workerExit = await stopWorkerWithin(worker, workerExitPromise, 10_000);
    workerStopped = true;
    assert.equal(workerExit.code, 0);
    const report = {
      result: "PASS",
      packageVersion: packagedRequire("./package.json").version,
      packagePath: asarPath,
      workerModulePath,
      jpegJsModulePath: packagedRequire.resolve("jpeg-js"),
      jpegEncoder: "ASAR-pinned jpeg-js 0.4.4",
      format: "SOF0 baseline 4:4:4",
      dimensions: `${WIDTH}x${HEIGHT}`,
      encodedBytes: encodedBytes.byteLength,
      inputSha256,
      outputBytes: result.pixels.byteLength,
      outputRgbaSha256,
      utilityProcessPid: child.pid,
      utilityProcessResponseTypes: { decoded_chunk: decodedChunkCount, decoded_end: decodedEndCount },
      diagnosticTimings: stageTimings,
      streamingBaselineRouteObserved: true,
      workerExit,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      imagePreparationServiceUsed: false,
      selectionDeadlineEnforced: false,
      browserWindowCreated: false,
      systemClipboardReadOrWritten: false,
      physicalInputSent: false,
      nativeHelperInvoked: false,
    };
    process.stdout.write(`T04_ASAR_16MP_RESULT ${JSON.stringify(report)}\n`);
    exitCode = 0;
  } catch (error) {
    process.stderr.write(`${error.stack ?? error}\n`);
  } finally {
    clearTimeout(watchdog);
    if (worker && !workerStopped) {
      try {
        await stopWorkerWithin(worker, workerExitPromise, 10_000);
        workerStopped = true;
      } catch (error) {
        process.stderr.write(`worker shutdown did not finish within 10000 ms: ${error.stack ?? error}\n`);
        try { worker.child?.kill(); } catch { /* app.exit below is the bounded fallback. */ }
      }
    }
    if (!cleanupFixture()) exitCode = 1;
  }
  app.exit(exitCode);
}).catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  clearTimeout(watchdog);
  try { worker?.child?.kill(); } catch { /* app.exit below is the bounded fallback. */ }
  cleanupFixture();
  app.exit(1);
});

function buildSyntheticJpeg() {
  const pixels = Buffer.allocUnsafe(OUTPUT_BYTES);
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
  const quality = 74;
  const imageBytes = Buffer.from(jpeg.encode({ width: WIDTH, height: HEIGHT, data: pixels }, quality).data);
  if (imageBytes.byteLength >= SOURCE_LIMIT_BYTES) throw new Error("synthetic_jpeg_cannot_fit_source_limit");
  const targetBytes = SOURCE_LIMIT_BYTES - ((SOURCE_LIMIT_BYTES - imageBytes.byteLength) % 4);
  const app2PaddingBytes = targetBytes - imageBytes.byteLength;
  const segments = [];
  let remaining = app2PaddingBytes;
  while (remaining > 0) {
    const segmentBytes = Math.min(65_536, remaining);
    const segment = Buffer.alloc(segmentBytes);
    segment[0] = 0xff;
    segment[1] = 0xe2;
    segment.writeUInt16BE(segmentBytes - 2, 2);
    segments.push(segment);
    remaining -= segmentBytes;
  }
  const bytes = Buffer.concat([imageBytes.subarray(0, 2), ...segments, imageBytes.subarray(2)]);
  return { bytes, quality, imageBytesBeforePadding: imageBytes.byteLength, app2PaddingBytes,
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
    if (marker === 0xc0) {
      const components = bytes[offset + 7];
      return Array.from({ length: components }, (_, index) => {
        const sampling = bytes[offset + 9 + index * 3];
        return { horizontal: sampling >> 4, vertical: sampling & 0x0f };
      });
    }
    offset += segmentLength;
  }
  throw new Error("synthetic_jpeg_sof_missing");
}

function waitWithin(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

async function stopWorkerWithin(worker, exitPromise, milliseconds) {
  const disposalPromise = worker.dispose();
  const stopped = exitPromise
    ? Promise.all([disposalPromise, exitPromise]).then(([, exit]) => exit)
    : disposalPromise.then(() => null);
  return waitWithin(stopped, milliseconds, "worker_shutdown_timeout");
}
