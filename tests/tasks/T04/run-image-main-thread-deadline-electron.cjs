// Isolated Electron main-process diagnostic. Uses only a generated image and
// fake key state; it never reads/writes the system clipboard or sends input.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../../..");

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require("electron"), [__filename], {
    cwd: ROOT,
    env,
    stdio: "inherit",
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} else {
  runDiagnostic().then(
    () => require("electron").app.exit(0),
    (error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      require("electron").app.exit(1);
    },
  );
}

async function runDiagnostic() {
  const { app, nativeImage } = require("electron");
  const { encodeClipboardImage, MAX_IMAGE_PAYLOAD_BYTES } = require("../../../dist-electron/main/clipboard/image-payload.js");
  const {
    SELECTION_KEY_RELEASE_WINDOW_MS,
    startSelectionKeyReleaseMonitor,
  } = require("../../../dist-electron/main/clipboard/selection-key-deadline.js");
  const watchdog = setTimeout(() => {
    process.stderr.write("main-thread image/deadline diagnostic timed out\n");
    app.exit(1);
  }, 90_000);

  try {
    await app.whenReady();
    assert.equal(process.platform, "win32", "this timing diagnostic is scoped to Windows");
    assert.equal(process.arch, "x64", "this timing diagnostic is scoped to x64");
    assert.equal(process.type, "browser", "the probe must run in Electron's main process");

    const width = 3000;
    const height = 3000;
    const fixturePrepStartTickMs = performance.now();
    let pixels = buildSyntheticRgba(width, height);
    let image = nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 1 });
    const imageSize = image.getSize();
    assert.deepEqual([imageSize.width, imageSize.height], [width, height]);
    pixels = null;
    const fixturePreparationMs = performance.now() - fixturePrepStartTickMs;

    const conversion = { pngMs: 0, pngBytes: 0, jpegMs: 0, jpegBytes: 0 };
    const source = {
      getSize: () => image.getSize(),
      toPNG() {
        const start = performance.now();
        const bytes = image.toPNG();
        conversion.pngMs = performance.now() - start;
        conversion.pngBytes = bytes.byteLength;
        return bytes;
      },
      toJPEG(quality) {
        assert.equal(quality, 82, "production JPEG fallback quality");
        const start = performance.now();
        const bytes = image.toJPEG(quality);
        conversion.jpegMs = performance.now() - start;
        conversion.jpegBytes = bytes.byteLength;
        return bytes;
      },
    };

    const startedWallMs = Date.now();
    const startedTickMs = Math.floor(performance.now());
    const deadlineWallMs = startedWallMs + SELECTION_KEY_RELEASE_WINDOW_MS;
    const deadlineTickMs = startedTickMs + SELECTION_KEY_RELEASE_WINDOW_MS;
    const memoryAtSelectionStart = readMemory();
    let keyStateReads = 0;
    const monitor = startSelectionKeyReleaseMonitor({
      selectionDeadlineAt: deadlineWallMs,
      selectionDeadlineTickMs: deadlineTickMs,
      nowAt: () => Date.now(),
      nowTickMs: () => Math.floor(performance.now()),
      keysReleased: () => { keyStateReads += 1; return true; },
    });

    const workStartTickMs = performance.now();
    const encoded = encodeClipboardImage(source);
    const encodeAndFallbackMs = performance.now() - workStartTickMs;
    assert.ok(encoded, "production clipboard image encoder must return a supported image");
    assert.ok(conversion.pngBytes > MAX_IMAGE_PAYLOAD_BYTES, "production PNG must exceed the source cap");
    assert.equal(encoded.mimeType, "image/jpeg", "oversized PNG must use the production JPEG fallback");
    assert.ok(encoded.bytes.byteLength > 0 && encoded.bytes.byteLength <= MAX_IMAGE_PAYLOAD_BYTES);
    const encodedMimeType = encoded.mimeType;
    const encodedBytes = encoded.bytes.byteLength;
    image = null;

    const base64StartTickMs = performance.now();
    let base64 = encoded.bytes.toString("base64");
    const signature = createHash("sha256").update(`image:${base64}`).digest("hex");
    const base64Chars = base64.length;
    const base64AndHashMs = performance.now() - base64StartTickMs;
    assert.match(signature, /^[0-9a-f]{64}$/);
    base64 = null;
    encoded.bytes = null;
    const memoryAfterTransform = readMemory();

    // If conversion finishes early, keep this isolated main process busy until
    // after the original deadline so the overdue poll is exercised reliably.
    // This padding is harness-only and is reported separately from production work.
    const paddingStartTickMs = performance.now();
    const paddingTargetTickMs = deadlineTickMs + 50;
    const waitCell = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    while (Math.floor(performance.now()) <= paddingTargetTickMs) {
      Atomics.wait(waitCell, 0, 0, Math.max(1, paddingTargetTickMs - performance.now() + 1));
    }
    const harnessOnlyStallMs = performance.now() - paddingStartTickMs;

    const decision = await monitor.cutoff;
    const cutoffObservedTickMs = Math.floor(performance.now());
    monitor.cancel();
    const simulatedEffects = { clipboardWrites: 0, inputSubmissions: 0, panelHides: 0 };
    if (decision.kind === "continue") {
      simulatedEffects.clipboardWrites += 1;
      simulatedEffects.inputSubmissions += 1;
      simulatedEffects.panelHides += 1;
    }
    assert.deepEqual(decision, { kind: "blocked", reasonCode: "key_state_unavailable" });
    assert.equal(keyStateReads, 1, "the stale pre-stall released sample must not be reused at the missed cutoff");
    assert.deepEqual(simulatedEffects, { clipboardWrites: 0, inputSubmissions: 0, panelHides: 0 });

    process.stdout.write(`${JSON.stringify({
      result: "PASS",
      platform: `${process.platform}-${process.arch}`,
      electron: process.versions.electron,
      electronProcessType: process.type,
      dimensions: `${width}x${height}`,
      syntheticBitmapBytes: width * height * 4,
      fixturePreparationMs: round(fixturePreparationMs),
      productionPngBytes: conversion.pngBytes,
      productionPngMs: round(conversion.pngMs),
      productionJpegBytes: conversion.jpegBytes,
      productionJpegMs: round(conversion.jpegMs),
      productionJpegQuality: 82,
      encodedMimeType,
      encodedBytes,
      base64Chars,
      base64AndSha256Ms: round(base64AndHashMs),
      productionTransformMs: round(encodeAndFallbackMs + base64AndHashMs),
      memoryAtSelectionStart,
      memoryAfterTransform,
      absoluteSelectionDeadlineMs: SELECTION_KEY_RELEASE_WINDOW_MS,
      harnessOnlyEventLoopStallPaddingMs: round(harnessOnlyStallMs),
      cutoffObservedAfterDeadlineMs: Math.max(0, cutoffObservedTickMs - deadlineTickMs),
      keyStateReads,
      decision,
      simulatedEffects,
      clipboardContentRead: false,
      clipboardWritten: false,
      inputSent: false,
      browserWindowCreated: false,
    })}\n`);
  } finally {
    clearTimeout(watchdog);
  }
}

function buildSyntheticRgba(width, height) {
  const pixels = Buffer.allocUnsafe(width * height * 4);
  let state = 0x05eed123;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const rgb = state >>> 0;
    pixels[offset] = rgb & 0xff;
    pixels[offset + 1] = (rgb >>> 8) & 0xff;
    pixels[offset + 2] = (rgb >>> 16) & 0xff;
    pixels[offset + 3] = 0xff;
  }
  return pixels;
}

function round(value) {
  return Number(value.toFixed(2));
}

function readMemory() {
  const memory = process.memoryUsage();
  return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, externalBytes: memory.external };
}
