const assert = require("node:assert/strict");
const test = require("node:test");
const { ClipboardSequenceGate } = require("../../../dist-electron/main/clipboard/sequence-gate.js");

test("a stable DWORD sequence is captured once and later polls skip content reads", async () => {
  const gate = new ClipboardSequenceGate();
  let sequenceReads = 0;
  let contentReads = 0;
  const readSequence = () => { sequenceReads += 1; return 0; };
  const readContents = () => { contentReads += 1; return "image"; };

  assert.deepEqual(await gate.capture(readSequence, readContents), {
    status: "captured", sequence: 0, value: "image",
  });
  assert.deepEqual(await gate.capture(readSequence, readContents), { status: "skipped", sequence: 0 });
  assert.equal(sequenceReads, 3);
  assert.equal(contentReads, 1);
});

test("failed content reads do not cache their sequence", async () => {
  const gate = new ClipboardSequenceGate();
  let contentReads = 0;
  await assert.rejects(gate.capture(() => 17, () => {
    contentReads += 1;
    throw new Error("clipboard_read_failed");
  }), /clipboard_read_failed/);

  const result = await gate.capture(() => 17, () => {
    contentReads += 1;
    return "retry";
  });
  assert.equal(result.status, "captured");
  assert.equal(contentReads, 2);
});

test("a sequence change during the content read is returned as unstable and not cached", async () => {
  const gate = new ClipboardSequenceGate();
  let sequenceReads = 0;
  let contentReads = 0;
  const readSequence = () => (++sequenceReads === 1 ? 21 : 22);

  const unstable = await gate.capture(readSequence, () => { contentReads += 1; return "old"; });
  assert.equal(unstable.status, "captured_unstable");
  const stable = await gate.capture(() => 22, () => { contentReads += 1; return "new"; });
  assert.equal(stable.status, "captured");
  assert.equal(contentReads, 2);
});

test("an unavailable or invalid sequence fails open and is never cached", async () => {
  const gate = new ClipboardSequenceGate();
  let contentReads = 0;
  for (const unavailable of [null, undefined, -1, 1.5, 0x1_0000_0000, "3"]) {
    const result = await gate.capture(() => unavailable, () => `read-${++contentReads}`);
    assert.equal(result.status, "captured_unavailable");
  }
  const throwing = await gate.capture(() => { throw new Error("sequence_unavailable"); }, () => `read-${++contentReads}`);
  assert.equal(throwing.status, "captured_unavailable");
  const valid = await gate.capture(() => 3, () => `read-${++contentReads}`);
  assert.equal(valid.status, "captured");
  assert.equal(contentReads, 8);
});

test("a self-written clipboard sequence can be marked to skip rereading and encoding", async () => {
  const gate = new ClipboardSequenceGate();
  let contentReads = 0;
  assert.equal(gate.markProcessed(0xffff_ffff), true);
  assert.deepEqual(await gate.capture(() => 0xffff_ffff, () => { contentReads += 1; }), {
    status: "skipped", sequence: 0xffff_ffff,
  });
  assert.equal(gate.markProcessed(0x1_0000_0000), false);
  assert.equal(contentReads, 0);
});

test("forgetting the matching processed sequence allows a persistence retry to reread it", async () => {
  const gate = new ClipboardSequenceGate();
  let contentReads = 0;
  const capture = () => gate.capture(() => 55, () => `read-${++contentReads}`);

  assert.equal((await capture()).status, "captured");
  assert.equal(gate.forgetProcessed(54), false);
  assert.equal((await capture()).status, "skipped");
  assert.equal(gate.forgetProcessed(55), true);
  assert.deepEqual(await capture(), { status: "captured", sequence: 55, value: "read-2" });
  assert.equal(contentReads, 2);
});

test("duplicate notifications during one stable read do not start another read", async () => {
  const gate = new ClipboardSequenceGate();
  let contentReads = 0;
  let finishRead;
  const first = gate.capture(() => 44, () => {
    contentReads += 1;
    return new Promise((resolve) => { finishRead = resolve; });
  });

  assert.deepEqual(await gate.capture(() => 44, () => { contentReads += 1; }), {
    status: "in_progress", sequence: 44,
  });
  assert.equal(contentReads, 1);
  finishRead("captured");
  assert.equal((await first).status, "captured");
});
