const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { deflateSync } = require("node:zlib");
const jpeg = require("jpeg-js");
const { crc32 } = require("pngjs/lib/crc");
const { decodeProductionImage } = require("../../../dist-electron/main/clipboard/image-decoder.js");
const { IMAGE_LIMITS } = require("../../../dist-electron/main/clipboard/image-worker.js");

function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4, "ascii");
  data.copy(bytes, 8);
  bytes.writeInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4);
  return bytes;
}

function png({ width = 2, height = 1, depth = 8, colorType = 6, interlace = 0,
  raw = Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 128]), extra = [] } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = depth;
  header[9] = colorType;
  header[12] = interlace;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header),
    ...extra, chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

function filteredRgbaRows(width, height, pixels) {
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  const previous = Buffer.alloc(rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = y % 5;
    const rowOffset = y * rowBytes;
    const rawOffset = y * (rowBytes + 1);
    raw[rawOffset] = filter;
    for (let index = 0; index < rowBytes; index++) {
      const left = index >= 4 ? pixels[rowOffset + index - 4] : 0;
      const up = y > 0 ? previous[index] : 0;
      const upperLeft = y > 0 && index >= 4 ? previous[index - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = testPaeth(left, up, upperLeft);
      raw[rawOffset + 1 + index] = (pixels[rowOffset + index] - predictor) & 0xff;
    }
    pixels.copy(previous, 0, rowOffset, rowOffset + rowBytes);
  }
  return raw;
}

function testPaeth(left, up, upperLeft) {
  const prediction = left + up - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const upDistance = Math.abs(prediction - up);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance ? left
    : upDistance <= upperLeftDistance ? up : upperLeft;
}

function request(format, bytes, width = 2, height = 1) {
  return { jobId: "real-image", format, encodedBytes: Uint8Array.from(bytes), width, height };
}
const decode = (input) => decodeProductionImage(input, new AbortController().signal);

test("production PNG decoder returns exact unpremultiplied RGBA and preserves encoded bytes", async () => {
  const input = request("png", png());
  const before = Uint8Array.from(input.encodedBytes);
  const result = await decode(input);
  assert.deepEqual([result.width, result.height], [2, 1]);
  assert.ok(result.pixels instanceof Uint8Array);
  assert.deepEqual([...result.pixels], [255, 0, 0, 255, 0, 255, 0, 128]);
  assert.deepEqual(input.encodedBytes, before);
});

test("8-bit RGBA PNG in-place path reverses every row filter exactly", async () => {
  const pixels = Buffer.from(Array.from({ length: 2 * 5 * 4 }, (_value, index) => (index * 53 + 17) & 0xff));
  const source = png({ width: 2, height: 5, raw: filteredRgbaRows(2, 5, pixels) });
  const image = await decode(request("png", source, 2, 5));
  assert.deepEqual([...image.pixels], [...pixels]);

  // Build a validly compressed one-row image with an unsupported filter byte.
  const invalidFilter = png({ width: 2, height: 1, raw: Buffer.from([5, ...pixels.subarray(0, 8)]) });
  await assert.rejects(decode(request("png", invalidFilter, 2, 1)), /image_source_invalid/);
});

test("PNG decoder expands RGB and palette transparency, and rescales 16-bit grayscale to RGBA", async () => {
  const rgb = await decode(request("png", png({ colorType: 2, raw: Buffer.from([0, 255, 0, 0, 0, 255, 0]) })));
  assert.deepEqual([...rgb.pixels], [255, 0, 0, 255, 0, 255, 0, 255]);
  const palette = await decode(request("png", png({ colorType: 3, raw: Buffer.from([0, 0, 1]), extra: [
    chunk("PLTE", Buffer.from([255, 0, 0, 0, 255, 0])), chunk("tRNS", Buffer.from([255, 128])),
  ] })));
  assert.deepEqual([...palette.pixels], [255, 0, 0, 255, 0, 255, 0, 128]);
  const grayscale = await decode(request("png", png({ colorType: 0, depth: 16, raw: Buffer.from([0, 0xff, 0xff, 0x80, 0x80]) })));
  assert.deepEqual([...grayscale.pixels], [255, 255, 255, 255, 128, 128, 128, 255]);
});

test("Adam7 PNG decodes using its exact inflated size and rejects compressed excess", async () => {
  const tinyInterlaced = png({ width: 1, height: 1, interlace: 1, raw: Buffer.from([0, 20, 40, 60, 80]) });
  assert.deepEqual([...(await decode(request("png", tinyInterlaced, 1, 1))).pixels], [20, 40, 60, 80]);
  const bomb = png({ width: 1, height: 1, interlace: 1, raw: Buffer.alloc(1024 * 1024) });
  await assert.rejects(decode(request("png", bomb, 1, 1)), /image_decode_failed/);
  const truncatedPixels = png({ raw: Buffer.from([0, 255, 0, 0]) });
  await assert.rejects(decode(request("png", truncatedPixels)), /image_source_invalid/);
});

test("PNG decoder verifies IHDR, IDAT, and ancillary chunk CRCs before decoding", async () => {
  const source = png({ extra: [chunk("tEXt", Buffer.from("author\0ClipNest"))] });
  for (const type of ["IHDR", "tEXt", "IDAT"]) {
    const broken = Buffer.from(source);
    const offset = broken.indexOf(type, 8, "ascii");
    broken[offset + 4] ^= 1;
    await assert.rejects(decode(request("png", broken)), /image_png_crc_invalid/);
  }
  await assert.rejects(decode(request("png", source.subarray(0, source.length - 4))), /image_source_invalid/);
  const falseDimensions = png({ width: 3 });
  await assert.rejects(decode(request("png", falseDimensions)), /image_dimensions_mismatch/);
});

test("real JPEG decoder produces strict opaque RGBA and rejects damaged data", async () => {
  const pixels = Buffer.from([240, 40, 20, 255, 240, 40, 20, 255]);
  const encoded = jpeg.encode({ width: 2, height: 1, data: pixels }, 100).data;
  const input = request("jpeg", encoded);
  const before = Uint8Array.from(input.encodedBytes);
  const result = await decode(input);
  assert.deepEqual([result.width, result.height, result.pixels.length], [2, 1, 8]);
  for (let index = 0; index < 8; index++) {
    if (index % 4 === 3) assert.equal(result.pixels[index], 255);
    else assert.ok(Math.abs(result.pixels[index] - pixels[index]) <= 2);
  }
  assert.deepEqual(input.encodedBytes, before);
  await assert.rejects(decode(request("jpeg", encoded.subarray(0, encoded.length / 2))), /image_decode_failed/);
  await assert.rejects(decode(request("jpeg", encoded, 1, 1)), /image_dimensions_mismatch/);
});

test("encoded source, actual pixel dimensions, and PNG working-set limits are enforced", async () => {
  await assert.rejects(decode(request("png", Buffer.alloc(IMAGE_LIMITS.sourceBytes + 1))), /image_source_too_large/);
  // Claimed small dimensions cannot hide an oversized real IHDR/SOF.
  await assert.rejects(decode(request("png", png({ width: 5000, height: 4000 }))), /image_dimensions_too_large/);
  const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0x0f, 0xa0, 0x13, 0x88, 1, 1, 0x11, 0]);
  await assert.rejects(decode(request("jpeg", jpegHeader)), /image_dimensions_too_large/);
  // A valid 16 MP 16-bit header would require excessive intermediate buffers.
  await assert.rejects(decode(request("png", png({ width: 4000, height: 4000, depth: 16 }), 4000, 4000)), /image_worker_capacity_exceeded/);
  // Filter bookkeeping for millions of narrow rows must also fit the budget.
  await assert.rejects(decode(request("png", png({ width: 1, height: 16_000_000 }), 1, 16_000_000)), /image_worker_capacity_exceeded/);
});

test("decoder handles already-aborted requests and invalid format/signature without output", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(decodeProductionImage(request("png", png()), controller.signal), /image_decode_cancelled/);
  await assert.rejects(decode(request("gif", png())), /image_format_unsupported/);
  await assert.rejects(decode(request("png", Buffer.from([1, 2, 3]))), /image_source_invalid/);
  await assert.rejects(decode(request("jpeg", png())), /image_source_invalid/);
});

function loadWorker(electron, productionEntry) {
  const filename = path.resolve(__dirname, "../../../dist-electron/main/clipboard/image-worker.js");
  const module = { exports: {} };
  const localRequire = createRequire(filename);
  const requireMock = (name) => name === "electron" ? electron : localRequire(name);
  requireMock.main = productionEntry ? module : {};
  const wrapped = vm.runInThisContext(`(function (exports, require, module, __filename, __dirname, process) {\n${fs.readFileSync(filename, "utf8")}\n})`, { filename });
  wrapped(module.exports, requireMock, module, filename, path.dirname(filename), { parentPort: electron.parentPort });
  return module.exports;
}

test("compiled utility-process production entry decodes PNG through its real parentPort protocol", async () => {
  const port = new EventEmitter();
  const responses = [];
  port.postMessage = (message) => responses.push(message);
  loadWorker({ parentPort: port }, true);
  const input = request("png", png());
  port.emit("message", { data: { type: "decode", requestId: input.jobId, input } });
  await waitFor(() => responses.length === 1);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].type, "decoded");
  assert.equal(responses[0].requestId, input.jobId);
  assert.deepEqual([...responses[0].image.pixels], [255, 0, 0, 255, 0, 255, 0, 128]);
});

test("utility worker restores bounded compressed image responses and rejects excess pixels", async () => {
  const children = [];
  const { createUtilityProcessImageWorker } = loadWorker({ utilityProcess: { fork() {
    const child = new EventEmitter();
    child.kill = () => true;
    child.postMessage = (message) => { child.request = message; };
    children.push(child);
    return child;
  } } }, false);
  const worker = createUtilityProcessImageWorker();
  const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128]);
  const first = { ...request("png", png()), jobId: "compressed-good" };
  const decoded = worker.decode(first, new AbortController().signal);
  children[0].emit("message", { type: "decoded_compressed", requestId: first.jobId, width: 2, height: 1,
    uncompressedBytes: pixels.byteLength, compressedPixels: deflateSync(pixels) });
  assert.deepEqual([...(await decoded).pixels], [...pixels]);

  const second = { ...first, jobId: "compressed-excess" };
  const rejected = worker.decode(second, new AbortController().signal);
  children[0].emit("message", { type: "decoded_compressed", requestId: second.jobId, width: 2, height: 1,
    uncompressedBytes: pixels.byteLength, compressedPixels: deflateSync(Buffer.alloc(pixels.byteLength + 1)) });
  await assert.rejects(rejected, /image_worker_response_invalid/);

  const controller = new AbortController();
  const third = { ...first, jobId: "compressed-abort", width: 1024, height: 1024 };
  const cancelled = worker.decode(third, controller.signal);
  children[0].emit("message", { type: "decoded_compressed", requestId: third.jobId, width: third.width, height: third.height,
    uncompressedBytes: third.width * third.height * 4, compressedPixels: deflateSync(Buffer.alloc(4 * 1024 * 1024)) });
  assert.ok(worker.inflater, "inflate stream is active before cancellation");
  controller.abort();
  assert.equal(worker.inflater, null, "cancellation clears the active inflater immediately");
  await assert.rejects(cancelled, /image_decode_cancelled/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.pending, null, "late inflate events cannot settle a cancelled request again");
  const disposed = worker.dispose();
  children[0].emit("exit", 0);
  await disposed;
});

test("utility worker rejects decoded responses with mismatched dimensions or pixel lengths", async () => {
  const children = [];
  const { createUtilityProcessImageWorker } = loadWorker({ utilityProcess: { fork() {
    const child = new EventEmitter();
    child.kill = () => true;
    child.postMessage = (message) => { child.request = message; };
    children.push(child);
    return child;
  } } }, false);
  const worker = createUtilityProcessImageWorker();
  const input = { ...request("png", png()), jobId: "decoded-invalid" };
  for (const [width, height, byteLength] of [[1, 1, 8], [2, 1, 7], [2, 1, 9]]) {
    const current = { ...input, jobId: `decoded-invalid-${width}-${height}-${byteLength}` };
    const rejected = worker.decode(current, new AbortController().signal);
    children[0].emit("message", { type: "decoded", requestId: current.jobId,
      image: { width, height, pixels: Buffer.alloc(byteLength) } });
    await assert.rejects(rejected, /image_worker_response_invalid/);
  }
  const disposed = worker.dispose();
  children[0].emit("exit", 0);
  await disposed;
});

function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (predicate()) { resolve(); return; }
      if (Date.now() - startedAt >= timeoutMs) { reject(new Error("test_wait_timeout")); return; }
      setTimeout(check, 1);
    };
    check();
  });
}

test("all cancellation reasons quarantine the dying utility process and ignore its late response", async () => {
  for (const reason of [undefined, new Error("image_prepare_timeout")]) {
    const children = [];
    const { createUtilityProcessImageWorker } = loadWorker({ utilityProcess: { fork() {
      const child = new EventEmitter();
      child.kill = () => { child.killed = true; return true; };
      child.postMessage = (message) => { child.request = message; };
      children.push(child);
      return child;
    } } }, false);
    const worker = createUtilityProcessImageWorker();
    const controller = new AbortController();
    const input = request("png", png());
    const pending = worker.decode(input, controller.signal);
    controller.abort(reason);
    await assert.rejects(pending, reason ? /image_prepare_timeout/ : /image_decode_cancelled/);
    assert.equal(children[0].killed, true);
    await assert.rejects(worker.decode(input, new AbortController().signal), /image_worker_terminating/);
    children[0].emit("message", { type: "decoded", requestId: input.jobId, image: { width: 2, height: 1, pixels: new Uint8Array(8) } });
    children[0].emit("exit", 0);
    const next = worker.decode({ ...input, jobId: "after-exit" }, new AbortController().signal);
    assert.equal(children.length, 2);
    children[1].emit("message", { type: "decoded", requestId: "after-exit", image: { width: 2, height: 1, pixels: new Uint8Array(8) } });
    await next;
    const disposed = worker.dispose();
    children[1].emit("exit", 0);
    await disposed;
  }
});
