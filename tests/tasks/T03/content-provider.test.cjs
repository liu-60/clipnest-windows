const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");

const { NativeContentProvider } = require("../../../dist-electron/main/native/content-provider.js");

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ONE_PIXEL_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function makeProvider(getItem, options = {}) {
  const calls = { lookup: 0, decode: 0, helper: 0, clipboard: 0, focus: 0, input: 0 };
  const provider = new NativeContentProvider({
    lookupCurrentItem(id) {
      calls.lookup += 1;
      return getItem(id);
    },
    isTrustedSender: options.isTrustedSender ?? ((senderId) => senderId === 7),
    async decodeImage(dataUrl, bytes) {
      calls.decode += 1;
      if (options.decodeImage) return options.decodeImage(dataUrl, bytes);
      return { width: 1, height: 1, bgra: Buffer.from([0x10, 0x20, 0x30, 0x80]) };
    },
  });
  return { provider, calls };
}

function pngHeader(width, height) {
  const png = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
  png.writeUInt32BE(13, 8);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return `data:image/png;base64,${png.toString("base64")}`;
}

test("untrusted sender and malformed/deleted item references stop before lookup or helper side effects", async () => {
  const item = { id: "item-1", type: "text", content: "safe", preview: "safe", createdAt: 1, pinned: false, byteSize: 4 };
  const { provider, calls } = makeProvider((id) => (id === item.id ? item : undefined));

  await assert.rejects(provider.snapshot(8, "item-1"), /content_sender_rejected/);
  await assert.rejects(provider.snapshot(7, null), /content_item_ref_invalid/);
  await assert.rejects(provider.snapshot(7, "deleted-item"), /content_item_not_found/);
  assert.equal(calls.lookup, 1);
  assert.deepEqual([calls.helper, calls.clipboard, calls.focus, calls.input], [0, 0, 0, 0]);
});

test("snapshot version is content-derived and stale edits or deletions cannot register or prepare", async () => {
  const item = { id: "item-2", type: "text", content: "original", preview: "original", createdAt: 1, pinned: false, byteSize: 8 };
  const { provider } = makeProvider((id) => (id === item.id ? item : undefined));
  const snapshot = await provider.snapshot(7, item.id);
  assert.equal(snapshot.itemVersion, digest(Buffer.from("clipnest-item-v1\0text\0original")));
  assert.equal(snapshot.totalHash, digest(Buffer.from("original")));

  item.content = "edited";
  assert.equal(provider.isCurrent(snapshot), false);
  assert.throws(() => provider.registerCommand(snapshot, "job-2", "object-2"), /content_snapshot_stale/);

  item.content = "original";
  const freshSnapshot = await provider.snapshot(7, item.id);
  provider.registerCommand(freshSnapshot, "job-2", "object-2");
  provider.markRegistered(freshSnapshot, "job-2", "object-2");
  item.content = "edited after register";
  assert.throws(() => provider.createTransfer(freshSnapshot, "job-2", "object-2"), /content_snapshot_stale/);
  const cancel = provider.invalidateRegisteredObject(freshSnapshot, "job-2", "object-2");
  assert.deepEqual(cancel, { kind: "cancel", jobId: "job-2" });
  assert.throws(() => provider.prepareCommand(freshSnapshot, "job-2", "object-2"), /content_object_not_registered/);

  item.content = "original";
  const beforeDelete = await provider.snapshot(7, item.id);
  provider.registerCommand(beforeDelete, "job-3", "object-3");
  provider.markRegistered(beforeDelete, "job-3", "object-3");
  delete item.content;
  assert.throws(() => provider.prepareCommand(beforeDelete, "job-3", "object-3"), /content_snapshot_stale/);
  assert.deepEqual(provider.cancelCommand("job-3"), { kind: "cancel", jobId: "job-3" });
});

test("register carries itemRef while prepare carries only jobId, token, and expected version", async () => {
  const item = { id: "item-3", type: "link", content: "https://example.test", preview: "example", createdAt: 1, pinned: false, byteSize: 20 };
  const { provider } = makeProvider((id) => (id === item.id ? item : undefined));
  const snapshot = await provider.snapshot(7, item.id);
  const register = provider.registerCommand(snapshot, "job-3", "object-3");
  assert.equal(register.kind, "register_content");
  assert.equal(register.itemRef, item.id);
  assert.equal(register.contentType, "text");
  assert.equal(register.totalHash, digest(Buffer.from(item.content)));
  assert.equal(Buffer.from(register.inlineBase64, "base64").toString("utf8"), item.content);

  provider.markRegistered(snapshot, "job-3", "object-3");
  const prepare = provider.prepareCommand(snapshot, "job-3", "object-3");
  assert.deepEqual(Object.keys(prepare).sort(), ["expectedItemVersion", "jobId", "kind", "objectToken"].sort());
  assert.equal(prepare.expectedItemVersion, snapshot.itemVersion);
  assert.equal("itemRef" in prepare, false);
});

test("chunk transfer stays within one unacknowledged 32KiB chunk and a stale edit aborts it", async () => {
  const item = { id: "item-4", type: "text", content: "x".repeat(32 * 1024 + 9), preview: "large", createdAt: 1, pinned: false, byteSize: 32 * 1024 + 9 };
  const { provider } = makeProvider((id) => (id === item.id ? item : undefined));
  const snapshot = await provider.snapshot(7, item.id);
  const registration = provider.registerCommand(snapshot, "job-4", "object-4");
  assert.equal("inlineBase64" in registration, false);
  provider.markRegistered(snapshot, "job-4", "object-4");
  const transfer = provider.createTransfer(snapshot, "job-4", "object-4");

  const first = transfer.nextChunk();
  assert.equal(Buffer.from(first.base64, "base64").length, 32 * 1024);
  assert.throws(() => transfer.nextChunk(), /content_chunk_ack_pending/);
  transfer.acknowledge(first.index, true);
  const second = transfer.nextChunk();
  assert.equal(Buffer.from(second.base64, "base64").length, 9);
  transfer.acknowledge(second.index, true);
  assert.equal(transfer.nextChunk(), null);
  assert.equal(transfer.finishCommand().totalHash, snapshot.totalHash);

  item.content = "edited while preparing";
  assert.throws(() => transfer.finishCommand(), /content_snapshot_stale/);
  assert.throws(() => provider.prepareCommand(snapshot, "job-4", "object-4"), /content_snapshot_stale/);
});

test("release zeroes snapshot bytes and invalidates every existing transfer session", async () => {
  const item = { id: "item-release", type: "text", content: "x".repeat(32 * 1024 + 5), preview: "large", createdAt: 1, pinned: false, byteSize: 32 * 1024 + 5 };
  const { provider } = makeProvider((id) => (id === item.id ? item : undefined));
  const snapshot = await provider.snapshot(7, item.id);
  provider.registerCommand(snapshot, "job-release", "object-release");
  provider.markRegistered(snapshot, "job-release", "object-release");
  const firstTransfer = provider.createTransfer(snapshot, "job-release", "object-release");
  const secondTransfer = provider.createTransfer(snapshot, "job-release", "object-release");
  firstTransfer.nextChunk();

  provider.release(snapshot, "job-release", "object-release");

  assert.ok(firstTransfer.payload.every((byte) => byte === 0));
  assert.strictEqual(secondTransfer.payload, firstTransfer.payload);
  assert.throws(() => firstTransfer.nextChunk(), /content_snapshot_unknown/);
  assert.throws(() => firstTransfer.acknowledge(0, true), /content_snapshot_unknown/);
  assert.throws(() => firstTransfer.finishCommand(), /content_snapshot_unknown/);
  assert.throws(() => provider.createTransfer(snapshot, "job-release", "object-release"), /content_object_not_registered/);
  assert.throws(() => provider.prepareCommand(snapshot, "job-release", "object-release"), /content_object_not_registered/);
});

test("image snapshot is bounded and emitted as an exact top-down 40-byte-header CF_DIB", async () => {
  const item = { id: "image-1", type: "image", content: ONE_PIXEL_PNG, preview: "image", createdAt: 1, pinned: false, byteSize: 68, width: 1, height: 1 };
  const { provider, calls } = makeProvider((id) => (id === item.id ? item : undefined));
  const snapshot = await provider.snapshot(7, item.id);
  const registration = provider.registerCommand(snapshot, "job-image", "object-image");
  const dib = Buffer.from(registration.inlineBase64, "base64");

  assert.equal(snapshot.contentType, "image");
  assert.equal(calls.decode, 1);
  assert.equal(snapshot.totalBytes, 44);
  assert.equal(dib.length, 44);
  assert.equal(dib.readUInt32LE(0), 40);
  assert.equal(dib.readInt32LE(4), 1);
  assert.equal(dib.readInt32LE(8), -1);
  assert.equal(dib.readUInt16LE(12), 1);
  assert.equal(dib.readUInt16LE(14), 32);
  assert.equal(dib.readUInt32LE(16), 0);
  assert.equal(dib.readUInt32LE(20), 4);
  assert.deepEqual([...dib.subarray(40)], [0x8f, 0x9f, 0xaf, 0xff]);
  assert.equal(snapshot.totalHash, digest(dib));
});

test("16MP image snapshots produce the full 64,000,040-byte DIB without downsampling", async () => {
  const item = { id: "image-16mp", type: "image", content: pngHeader(4000, 4000), preview: "image", createdAt: 1, pinned: false, byteSize: 24 };
  const pixelBytes = Buffer.alloc(16_000_000 * 4, 0xff);
  const { provider, calls } = makeProvider((id) => (id === item.id ? item : undefined), {
    decodeImage: async (_dataUrl, _encodedBytes) => ({ width: 4000, height: 4000, bgra: pixelBytes }),
  });
  const snapshot = await provider.snapshot(7, item.id);
  const registration = provider.registerCommand(snapshot, "job-image-16mp", "object-image-16mp");

  assert.equal(calls.decode, 1);
  assert.equal(snapshot.totalBytes, 64_000_040);
  assert.equal(registration.totalBytes, 64_000_040);
  assert.equal("inlineBase64" in registration, false);
  assert.equal(snapshot.totalHash.length, 64);
});

test("image sources above 20MiB and dimensions above 16MP fail before decoder or helper work", async () => {
  const tooLargeSource = `data:image/png;base64,${"A".repeat(4 * Math.ceil((20 * 1024 * 1024) / 3) + 4)}`;
  const item = { id: "image-huge", type: "image", content: pngHeader(4001, 4000), preview: "image", createdAt: 1, pinned: false, byteSize: 24 };
  const { provider, calls } = makeProvider((id) => (id === "oversized-source" ? { ...item, id, content: tooLargeSource } : item));
  await assert.rejects(provider.snapshot(7, "oversized-source"), /image_source_invalid/);
  await assert.rejects(provider.snapshot(7, item.id), /image_dimensions_unsupported/);
  assert.equal(calls.decode, 0);
  assert.deepEqual([calls.helper, calls.clipboard, calls.focus, calls.input], [0, 0, 0, 0]);
});

test("image decode rejection does not permit helper, clipboard, focus, or input side effects", async () => {
  const item = { id: "image-decode-fail", type: "image", content: ONE_PIXEL_PNG, preview: "image", createdAt: 1, pinned: false, byteSize: 68 };
  const { provider, calls } = makeProvider((id) => (id === item.id ? item : undefined), {
    decodeImage: async () => { throw new Error("image_decode_failed"); },
  });
  await assert.rejects(provider.snapshot(7, item.id), /image_decode_failed/);
  assert.deepEqual([calls.helper, calls.clipboard, calls.focus, calls.input], [0, 0, 0, 0]);
});

test("image edits or deletion during async decode invalidate the original snapshot", async () => {
  const item = { id: "image-edit-during-decode", type: "image", content: ONE_PIXEL_PNG, preview: "image", createdAt: 1, pinned: false, byteSize: 68 };
  let finishDecode;
  const { provider, calls } = makeProvider((id) => (id === item.id ? item : undefined), {
    decodeImage: () => new Promise((resolve) => { finishDecode = resolve; }),
  });
  const pendingEditSnapshot = provider.snapshot(7, item.id);
  await new Promise((resolve) => setImmediate(resolve));
  item.content = "edited while image decoding";
  finishDecode({ width: 1, height: 1, bgra: Buffer.from([1, 2, 3, 255]) });
  await assert.rejects(pendingEditSnapshot, /content_snapshot_stale/);

  item.content = ONE_PIXEL_PNG;
  const pendingDeleteSnapshot = provider.snapshot(7, item.id);
  await new Promise((resolve) => setImmediate(resolve));
  delete item.content;
  finishDecode({ width: 1, height: 1, bgra: Buffer.from([1, 2, 3, 255]) });
  await assert.rejects(pendingDeleteSnapshot, /content_snapshot_stale/);
  assert.equal(calls.decode, 2);
  assert.deepEqual([calls.helper, calls.clipboard, calls.focus, calls.input], [0, 0, 0, 0]);
});
