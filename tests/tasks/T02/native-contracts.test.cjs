const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isNativeRequest,
  isNativeResult,
  MAX_COMPRESSED_IMAGE_SOURCE_BYTES,
  MAX_IMAGE_DIB_BYTES,
  MAX_IMAGE_PIXELS,
} = require("../../../dist-electron/shared/native-contracts");

const envelope = {
  v: 1,
  requestId: "req-1",
  generation: "panel-4",
  helperInstanceId: "instance-8",
  durationMs: 0.25,
};
const expected = {
  requestId: envelope.requestId,
  generation: envelope.generation,
  helperInstanceId: envelope.helperInstanceId,
};

function accepts(result) {
  return isNativeResult({ ...envelope, ...result }, expected);
}

const requestEnvelope = {
  v: 1,
  requestId: "request-1",
  generation: "panel-4",
  helperInstanceId: "instance-8",
};
const target = { hwnd: "18", pid: 27, processCreatedAt: "9007199254740993" };

function acceptsRequest(request) {
  return isNativeRequest({ ...requestEnvelope, ...request });
}

test("accepts empty physical trigger keys for click execution only", () => {
  assert.equal(acceptsRequest({
    kind: "commit_write",
    jobId: "job-1",
    prepareToken: "token-1",
    baselineClipboardSequence: "41",
    triggerKeys: [],
  }), true);
  assert.equal(acceptsRequest({
    kind: "paste",
    jobId: "job-1",
    prepareToken: "token-1",
    hostWindow: target,
    target,
    expectedClipboardSequence: "42",
    triggerKeys: [],
  }), true);
  assert.equal(acceptsRequest({ kind: "capture", triggerKeys: [] }), false);
  assert.equal(acceptsRequest({
    kind: "prepare",
    jobId: "job-1",
    objectToken: "object-1",
    expectedItemVersion: "version-1",
    itemRef: "legacy-item-ref",
  }), false);
});

test("keeps trigger arrays bounded and rejects duplicate, contradictory, or unknown keys", () => {
  const commit = { kind: "commit_write", jobId: "job-1", prepareToken: "token-1", baselineClipboardSequence: "41" };
  assert.equal(acceptsRequest({ ...commit, triggerKeys: ["Enter"] }), true);
  assert.equal(acceptsRequest({ ...commit, triggerKeys: ["Enter", "Enter"] }), false);
  assert.equal(acceptsRequest({ ...commit, triggerKeys: ["Enter", "V"] }), false);
  assert.equal(acceptsRequest({ ...commit, triggerKeys: ["Click"] }), false);
  assert.equal(acceptsRequest({ ...commit, triggerKeys: ["Enter", "V", "Enter"] }), false);
  assert.equal(acceptsRequest({ ...commit }), false);
});

test("separates compressed source and expanded DIB image limits", () => {
  assert.equal(MAX_COMPRESSED_IMAGE_SOURCE_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_IMAGE_PIXELS, 16_000_000);
  assert.equal(MAX_IMAGE_DIB_BYTES, 16_000_000 * 4 + 40);

  const register = {
    kind: "register_content",
    jobId: "job-1",
    objectToken: "object-1",
    itemRef: "item-1",
    expectedItemVersion: "version-1",
    contentType: "image",
    totalHash: "a".repeat(64),
  };
  assert.equal(acceptsRequest({ ...register, totalBytes: MAX_IMAGE_DIB_BYTES }), true);
  assert.equal(acceptsRequest({ ...register, totalBytes: MAX_IMAGE_DIB_BYTES + 1 }), false);
});

test("accepts strict READY and correlated stage results", () => {
  assert.equal(accepts({ status: "ready", helperPid: 4242, helperProcessCreatedAt: "1337" }), true);
  assert.equal(accepts({ status: "captured", target: { hwnd: "18", pid: 27, processCreatedAt: "9007199254740993" } }), true);
  assert.equal(accepts({ status: "input_submitted", jobId: "job-1", insertedInputs: 4, target: { hwnd: "18", pid: 27, processCreatedAt: "9007199254740993" } }), true);
});

test("rejects unknown fields and stale correlation identifiers", () => {
  assert.equal(isNativeResult({ ...envelope, status: "ready", helperPid: 4242, helperProcessCreatedAt: "1337", title: "secret" }, expected), false);
  assert.equal(isNativeResult({ ...envelope, status: "ready", helperPid: 4242, helperProcessCreatedAt: "1337" }), false);
  assert.equal(
    isNativeResult({ ...envelope, status: "ready", helperPid: 4242, helperProcessCreatedAt: "1337" }, { requestId: "req-old", generation: "panel-4", helperInstanceId: "instance-8" }),
    false,
  );
  assert.equal(accepts({ status: "input_submitted", jobId: "job-1", insertedInputs: 4, target: { hwnd: "01", pid: 27, processCreatedAt: "4" } }), false);
  assert.equal(accepts({ status: "ready", helperPid: 4242, helperProcessCreatedAt: "1337", jobId: "job-1" }), false);
  assert.equal(accepts({ status: "ready", helperPid: 4242, helperProcessCreatedAt: "1337", insertedInputs: 4 }), false);
  assert.equal(accepts({ status: "ready", helperPid: 4242, helperProcessCreatedAt: "1337", target: { hwnd: "18", pid: 27, processCreatedAt: "4" } }), false);
  assert.equal(accepts({ status: "ready" }), false);
  assert.equal(accepts({ status: "ready", helperPid: 0, helperProcessCreatedAt: "1337" }), false);
  assert.equal(accepts({ status: "ready", helperPid: 4242, helperProcessCreatedAt: "01" }), false);
  assert.equal(accepts({ status: "captured", target: { hwnd: "0", pid: 27, processCreatedAt: "4" } }), false);
  assert.equal(accepts({ status: "captured", target: { hwnd: "18446744073709551616", pid: 27, processCreatedAt: "4" } }), false);
});

test("requires cancellation quiescence and a matching terminal job event", () => {
  assert.equal(accepts({ status: "cancelled", workerQuiescent: false, jobId: "job-1" }), true);
  assert.equal(accepts({ status: "cancelled", jobId: "job-1" }), false);
  assert.equal(accepts({ status: "job_finished", jobId: "job-1", workerQuiescent: true }), true);
  assert.equal(accepts({ status: "job_finished", workerQuiescent: true }), false);
  assert.equal(accepts({ status: "job_finished", jobId: "job-1", workerQuiescent: false }), false);
  assert.equal(accepts({ status: "too_late", jobId: "job-1", workerQuiescent: true, prepareToken: "unexpected" }), false);
});

test("requires stage tokens and verifies exact SendInput completion shape", () => {
  assert.equal(accepts({ status: "content_registered", jobId: "job-1", objectToken: "object-1" }), true);
  assert.equal(accepts({ status: "prepared", jobId: "job-1", prepareToken: "token-1" }), true);
  assert.equal(accepts({ status: "prepared", jobId: "job-1" }), false);
  assert.equal(accepts({ status: "clipboard_written", jobId: "job-1", clipboardSequence: "42" }), true);
  assert.equal(accepts({ status: "input_submitted", jobId: "job-1", insertedInputs: 3, target: { hwnd: "18", pid: 27, processCreatedAt: "4" } }), false);
  assert.equal(accepts({ status: "input_submitted", jobId: "job-1", insertedInputs: 4, target: { hwnd: "18", pid: 27, processCreatedAt: "18446744073709551616" } }), false);
  assert.equal(accepts({ status: "input_rejected", jobId: "job-1", insertedInputs: 2, reasonCode: "partial" }), true);
  assert.equal(accepts({ status: "input_rejected", jobId: "job-1", reasonCode: "missing-count" }), false);
  assert.equal(accepts({ status: "input_rejected", jobId: "job-1", insertedInputs: 4 }), false);
});
