const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");
const { ClipboardSequenceGate } = require("../../../dist-electron/main/clipboard/sequence-gate.js");
const { encodeClipboardImage } = require("../../../dist-electron/main/clipboard/image-payload.js");

const mainPath = path.resolve(__dirname, "../../../src/main/main.ts");
const mainSource = fs.readFileSync(mainPath, "utf8");
const parsedMain = ts.createSourceFile(mainPath, mainSource, ts.ScriptTarget.Latest, true);
const testedFunctionNames = [
  "fingerprint",
  "readClipboardImage",
  "readClipboardItem",
  "currentClipboardSequence",
  "pollClipboard",
];
const testedSource = testedFunctionNames.map((name) => {
  const declaration = parsedMain.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `the production ${name} function must exist`);
  return declaration.getText(parsedMain);
}).join("\n\n");
const compiledMain = ts.transpileModule(testedSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function createProductionPollHarness() {
  const calls = {
    sequence: 0,
    availableFormats: 0,
    readImage: 0,
    readText: 0,
    getSize: 0,
    toPNG: 0,
    toJPEG: 0,
    base64: 0,
    sha256: 0,
    historyUpdates: 0,
  };
  const png = Buffer.from([1, 2, 3]);
  const originalToString = Buffer.prototype.toString;
  png.toString = function (encoding, ...args) {
    if (encoding === "base64") calls.base64 += 1;
    return originalToString.call(this, encoding, ...args);
  };
  const image = {
    isEmpty: () => false,
    getSize: () => { calls.getSize += 1; return { width: 1, height: 1 }; },
    toPNG: () => { calls.toPNG += 1; return png; },
    toJPEG: () => { calls.toJPEG += 1; return Buffer.from([4, 5, 6]); },
  };
  const clipboard = {
    availableFormats: () => { calls.availableFormats += 1; return ["image/png"]; },
    readImage: () => { calls.readImage += 1; return image; },
    readText: () => { calls.readText += 1; return ""; },
  };
  const context = vm.createContext({
    Buffer,
    Date,
    clipboard,
    clipboardSequenceGate: new ClipboardSequenceGate(),
    createHash(algorithm) {
      if (algorithm === "sha256") calls.sha256 += 1;
      return crypto.createHash(algorithm);
    },
    encodeClipboardImage,
    lastClipboardSignature: "",
    randomUUID: () => "sequence-image",
    addHistoryItem: () => { calls.historyUpdates += 1; return true; },
    win32HostBridge: {
      getClipboardSequenceNumber: () => { calls.sequence += 1; return 17; },
    },
    console: { warn() {} },
  });
  vm.runInContext(compiledMain, context, { filename: mainPath });
  return {
    calls,
    pollClipboard: context.pollClipboard,
    flushPoll: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

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

test("production clipboard polling skips all image work for a duplicate sequence", async () => {
  const harness = createProductionPollHarness();

  harness.pollClipboard();
  await harness.flushPoll();
  assert.equal(harness.calls.historyUpdates, 1, "the first stable image sequence enters history once");
  assert.deepEqual({
    availableFormats: harness.calls.availableFormats,
    readImage: harness.calls.readImage,
    readText: harness.calls.readText,
    getSize: harness.calls.getSize,
    toPNG: harness.calls.toPNG,
    toJPEG: harness.calls.toJPEG,
    base64: harness.calls.base64,
    sha256: harness.calls.sha256,
  }, {
    availableFormats: 1,
    readImage: 1,
    readText: 0,
    getSize: 2,
    toPNG: 1,
    toJPEG: 0,
    base64: 1,
    sha256: 1,
  });

  const workAfterFirstCapture = { ...harness.calls };
  harness.pollClipboard();
  await harness.flushPoll();

  assert.equal(harness.calls.sequence, workAfterFirstCapture.sequence + 1,
    "the duplicate notification compares the current clipboard sequence");
  assert.equal(harness.calls.historyUpdates, workAfterFirstCapture.historyUpdates,
    "the duplicate sequence does not update history");
  assert.deepEqual({
    availableFormats: harness.calls.availableFormats,
    readImage: harness.calls.readImage,
    readText: harness.calls.readText,
    getSize: harness.calls.getSize,
    toPNG: harness.calls.toPNG,
    toJPEG: harness.calls.toJPEG,
    base64: harness.calls.base64,
    sha256: harness.calls.sha256,
  }, {
    availableFormats: workAfterFirstCapture.availableFormats,
    readImage: workAfterFirstCapture.readImage,
    readText: workAfterFirstCapture.readText,
    getSize: workAfterFirstCapture.getSize,
    toPNG: workAfterFirstCapture.toPNG,
    toJPEG: workAfterFirstCapture.toJPEG,
    base64: workAfterFirstCapture.base64,
    sha256: workAfterFirstCapture.sha256,
  });
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
