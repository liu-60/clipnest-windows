// Real Electron utility-process verification for post-scan JPEG metadata.
// It creates no window and never accesses the system clipboard, native helper, or input APIs.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const WIDTH = 4000;
const HEIGHT = 4000;
const COM_PAYLOAD_BYTES = 1024 * 1024;
const RESPONSE_CHUNK_BYTES = 1024 * 1024;
const REQUEST_ID = "postscan-stream-16mp";

function segment(marker, payload) {
  const result = Buffer.alloc(payload.length + 4);
  result[0] = 0xff;
  result[1] = marker;
  result.writeUInt16BE(payload.length + 2, 2);
  payload.copy(result, 4);
  return result;
}

function grayscaleBaselineJpeg(width, height) {
  if (width % 8 !== 0 || height % 8 !== 0) throw new Error("fixture_dimensions_must_align_to_blocks");
  const quantization = Buffer.alloc(65, 1);
  quantization[0] = 0;
  const frame = Buffer.alloc(9);
  frame[0] = 8;
  frame.writeUInt16BE(height, 1);
  frame.writeUInt16BE(width, 3);
  frame[5] = 1;
  frame[6] = 1;
  frame[7] = 0x11;
  frame[8] = 0;
  const huffman = Buffer.alloc(36);
  huffman[0] = 0x00;
  huffman[1] = 1;
  huffman[18] = 0x10;
  huffman[19] = 1;
  const scan = Buffer.from([1, 1, 0, 0, 63, 0]);
  const blockCount = width / 8 * (height / 8);
  const entropyByteCount = blockCount / 4;
  if (!Number.isInteger(entropyByteCount)) throw new Error("fixture_entropy_alignment_invalid");
  // Each grayscale block encodes DC category 0 and AC EOB as two zero bits.
  const entropy = Buffer.alloc(entropyByteCount);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    segment(0xdb, quantization),
    segment(0xc0, frame),
    segment(0xc4, huffman),
    segment(0xda, scan),
    entropy,
    Buffer.from([0xff, 0xd9]),
  ]);
}

function appendPostScanMetadata(encoded) {
  const eoi = Buffer.from([0xff, 0xd9]);
  const eoiOffset = encoded.lastIndexOf(eoi);
  assert.notEqual(eoiOffset, -1, "fixture must end with EOI");
  const app1 = segment(0xe1, Buffer.from([0x45, 0x78, 0xff, 0xd9, 0x69, 0x66, 0x00]));
  const comments = [];
  for (let remaining = COM_PAYLOAD_BYTES; remaining > 0;) {
    const length = Math.min(65_533, remaining);
    comments.push(segment(0xfe, Buffer.alloc(length)));
    remaining -= length;
  }
  assert.equal(comments.length, 17);
  return Buffer.concat([
    encoded.subarray(0, eoiOffset),
    Buffer.from([0xff, 0xff]),
    app1,
    ...comments,
    Buffer.from([0xff, 0xff, 0xff]),
    encoded.subarray(eoiOffset),
  ]);
}

if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require("electron"), [__filename], {
    cwd: path.resolve(__dirname, "../../.."), env, stdio: "inherit", timeout: 75_000,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
} else {
  const { app, BrowserWindow } = require("electron");
  const { createUtilityProcessImageWorker } = require("../../../dist-electron/main/clipboard/image-worker.js");
  const worker = createUtilityProcessImageWorker();
  let controller;
  let child;
  let childExit;
  let childExitPromise;
  let timedOut = false;
  let summary;
  let watchdog;

  app.whenReady().then(async () => {
    let exitCode = 0;
    watchdog = setTimeout(() => {
      process.stderr.write("post-scan JPEG utility-process verification timed out\n");
      timedOut = true;
      controller?.abort(new Error("image_worker_timeout"));
    }, 50_000);
    try {
      assert.equal(BrowserWindow.getAllWindows().length, 0, "the smoke must not create a window");
      const base = grayscaleBaselineJpeg(WIDTH, HEIGHT);
      const encoded = appendPostScanMetadata(base);
      assert.ok(encoded.byteLength <= 20 * 1024 * 1024, "fixture must remain within the source-byte limit");
      assert.ok(encoded.byteLength + WIDTH * HEIGHT * 4 <= 256 * 1024 * 1024,
        "worker request must remain within the input-plus-output envelope");

      const stages = [];
      controller = new AbortController();
      const resultPromise = worker.decode({
        jobId: REQUEST_ID,
        format: "jpeg",
        encodedBytes: Uint8Array.from(encoded),
        width: WIDTH,
        height: HEIGHT,
      }, controller.signal, (stage) => stages.push(stage));

      child = worker.child;
      assert.ok(child, "the production utility process must start");
      childExitPromise = new Promise((resolve) => {
        child.once("exit", (code, signal) => {
          childExit = { code, signal: signal ?? null };
          resolve(childExit);
        });
      });
      let decodedChunkCount = 0;
      const decodedChunkSeqs = [];
      let decodedEndCount = 0;
      let decodedEnd;
      child.on("message", (message) => {
        if (!message || message.requestId !== REQUEST_ID) return;
        if (message.type === "decoded_chunk") {
          decodedChunkCount++;
          decodedChunkSeqs.push(message.seq);
        } else if (message.type === "decoded_end") {
          decodedEndCount++;
          decodedEnd = { width: message.width, height: message.height,
            chunkCount: message.chunkCount, byteLength: message.byteLength };
        }
      });

      const result = await resultPromise;

      assert.deepEqual([result.width, result.height, result.pixels.byteLength], [WIDTH, HEIGHT, WIDTH * HEIGHT * 4]);
      const preflightIndex = stages.indexOf("jpegPreflightParseMs");
      const planIndex = stages.indexOf("jpegStreamPlanParseMs");
      const decodeIndex = stages.indexOf("jpegHuffmanIdctWriteMs");
      assert.ok(preflightIndex >= 0 && preflightIndex < planIndex && planIndex < decodeIndex,
        `utility-process stages must prove production streaming; got ${stages.join(",")}`);
      assert.ok(stages.includes("workerChunkSendAckMs"), "the bounded worker chunk/ACK transfer must complete");
      assert.ok(stages.includes("mainChunkAssemblyMs"), "the main process must assemble the returned chunks");
      const expectedChunks = Math.ceil(result.pixels.byteLength / RESPONSE_CHUNK_BYTES);
      assert.equal(expectedChunks, 62);
      assert.equal(decodedChunkCount, expectedChunks, "the utility-process stream must emit every expected chunk");
      assert.deepEqual(decodedChunkSeqs, Array.from({ length: expectedChunks }, (_, index) => index),
        "the utility-process chunk sequence must be complete and ordered");
      assert.equal(decodedEndCount, 1, "the utility process must emit one terminal frame");
      assert.deepEqual(decodedEnd, { width: WIDTH, height: HEIGHT,
        chunkCount: expectedChunks, byteLength: WIDTH * HEIGHT * 4 });

      let mismatchOffset = -1;
      for (let offset = 0; offset < result.pixels.length; offset += 4) {
        if (result.pixels[offset] !== 128 || result.pixels[offset + 1] !== 128 ||
            result.pixels[offset + 2] !== 128 || result.pixels[offset + 3] !== 255) {
          mismatchOffset = offset;
          break;
        }
      }
      assert.equal(mismatchOffset, -1, "all returned pixels must be opaque neutral gray");
      assert.equal(BrowserWindow.getAllWindows().length, 0);
      summary = { electronVersion: process.versions.electron, decodedChunkCount, decodedEndCount,
        expectedChunks, stages };
    } catch (error) {
      process.stderr.write(`${error.stack ?? error}\n`);
      exitCode = 1;
    } finally {
      clearTimeout(watchdog);
      try {
        await stopWorkerWithin(worker, child, childExitPromise, 8_000);
      } catch (error) {
        process.stderr.write(`worker disposal failed: ${error.stack ?? error}\n`);
        exitCode = 1;
      }
      if (timedOut) exitCode = 1;
      if (child && (!childExit || childExit.code !== 0 || childExit.signal !== null)) {
        process.stderr.write(`worker did not exit cleanly: ${JSON.stringify(childExit)}\n`);
        exitCode = 1;
      }
    }
    if (exitCode === 0) {
      process.stdout.write(`PASS: Electron ${summary.electronVersion} utilityProcess decoded ${WIDTH}x${HEIGHT} ` +
        `post-scan APP1/1MiB COM JPEG; observed ${summary.decodedChunkCount}/${summary.expectedChunks} ordered bounded chunks, ` +
        `one decoded_end, chunk/ACK and assembly stages; worker exit=${JSON.stringify(childExit)}; ` +
        `stages=${summary.stages.join(",")}\n`);
    }
    app.exit(exitCode);
  });
}

async function stopWorkerWithin(worker, child, childExitPromise, timeoutMs) {
  try {
    const disposal = worker.dispose();
    await waitWithin(childExitPromise ? Promise.all([disposal, childExitPromise]) : disposal,
      timeoutMs, "image_worker_dispose_timeout");
  } catch (error) {
    try { child?.kill(); } catch { /* Explicitly kill again before the bounded app-exit fallback. */ }
    if (childExitPromise) await waitWithin(childExitPromise, 2_000, "image_worker_exit_timeout").catch(() => {});
    throw error;
  }
}

function waitWithin(promise, timeoutMs, reason) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}
