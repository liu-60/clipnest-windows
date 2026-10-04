const assert = require("node:assert/strict");
const test = require("node:test");
const { encodeClipboardImage } = require("../../../dist-electron/main/clipboard/image-payload.js");

// v2/docs/spec/04-desktop-performance.md §6 sets a 20 MiB encoded image-payload limit.
const MAX_IMAGE_PAYLOAD_BYTES = 20 * 1024 * 1024;

function imageSource({ width, height, png, jpeg = Buffer.from([4, 5]) }) {
  const calls = { png: 0, jpeg: [], resize: 0 };
  return {
    calls,
    getSize: () => ({ width, height }),
    toPNG: () => { calls.png += 1; return png; },
    toJPEG: (quality) => { calls.jpeg.push(quality); return jpeg; },
    resize: () => { calls.resize += 1; throw new Error("image_must_not_be_downsampled"); },
  };
}

test("clipboard image payload preserves original dimensions without resize", () => {
  const source = imageSource({ width: 4096, height: 3072, png: Buffer.from([1, 2, 3]) });
  const encoded = encodeClipboardImage(source);
  assert.deepEqual(encoded, {
    bytes: Buffer.from([1, 2, 3]),
    mimeType: "image/png",
    width: 4096,
    height: 3072,
  });
  assert.equal(source.calls.png, 1);
  assert.deepEqual(source.calls.jpeg, []);
  assert.equal(source.calls.resize, 0);
});

test("oversized PNG falls back to a full-resolution JPEG", () => {
  const jpeg = Buffer.alloc(MAX_IMAGE_PAYLOAD_BYTES);
  const source = imageSource({
    width: 5000,
    height: 3000,
    png: Buffer.alloc(MAX_IMAGE_PAYLOAD_BYTES + 1),
    jpeg,
  });
  const encoded = encodeClipboardImage(source);
  assert.equal(encoded.mimeType, "image/jpeg");
  assert.equal(encoded.width, 5000);
  assert.equal(encoded.height, 3000);
  assert.equal(encoded.bytes, jpeg);
  assert.deepEqual(source.calls.jpeg, [82]);
  assert.equal(source.calls.resize, 0);
});

test("a 16 MP image with a PNG exactly at 20 MiB is accepted without re-encoding", () => {
  const png = Buffer.alloc(MAX_IMAGE_PAYLOAD_BYTES);
  const source = imageSource({
    width: 4000,
    height: 4000,
    png,
    jpeg: Buffer.alloc(MAX_IMAGE_PAYLOAD_BYTES + 1),
  });
  const encoded = encodeClipboardImage(source);
  assert.equal(encoded.mimeType, "image/png");
  assert.equal(encoded.width, 4000);
  assert.equal(encoded.height, 4000);
  assert.equal(encoded.bytes, png);
  assert.equal(source.calls.png, 1);
  assert.deepEqual(source.calls.jpeg, []);
  assert.equal(source.calls.resize, 0);
});

test("over-limit pixel dimensions are rejected before encoding", () => {
  const source = imageSource({ width: 5000, height: 4000, png: Buffer.from([1]) });
  assert.equal(encodeClipboardImage(source), null);
  assert.equal(source.calls.png, 0);
  assert.deepEqual(source.calls.jpeg, []);
});

test("an image exceeding 20 MiB in both encodings is rejected without downsampling", () => {
  const source = imageSource({
    width: 4000,
    height: 4000,
    png: Buffer.alloc(MAX_IMAGE_PAYLOAD_BYTES + 1),
    jpeg: Buffer.alloc(MAX_IMAGE_PAYLOAD_BYTES + 1),
  });
  assert.equal(encodeClipboardImage(source), null);
  assert.equal(source.calls.resize, 0);
});
