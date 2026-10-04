const assert = require("node:assert/strict");
const test = require("node:test");

const { isNativeRequest } = require("../../../dist-electron/shared/native-contracts.js");
const { selectionHelperDeadlineAtCommit } = require("../../../dist-electron/main/clipboard/selection-key-deadline.js");

function commit(selectionBudgetMs, selectionDeadlineTickMs) {
  const request = {
    v: 1, requestId: "write-1", generation: "panel-1", helperInstanceId: "helper-1",
    kind: "commit_write", jobId: "job-1", prepareToken: "prepare-1",
    baselineClipboardSequence: "41", triggerKeys: ["Enter"],
  };
  if (selectionBudgetMs !== undefined) request.selectionBudgetMs = selectionBudgetMs;
  if (selectionDeadlineTickMs !== undefined) request.selectionDeadlineTickMs = selectionDeadlineTickMs;
  return request;
}

test("an expired selection deadline produces a valid immediate check-only commit", () => {
  const deadline = selectionHelperDeadlineAtCommit(501, 500);
  assert.deepEqual(deadline, { kind: "expired", selectionBudgetMs: 0 });
  assert.equal(isNativeRequest(commit(deadline.selectionBudgetMs)), true);
});

test("commit_write accepts legacy JSON and bounds a supplied shared selection budget", () => {
  assert.equal(isNativeRequest(commit()), true);
  assert.equal(isNativeRequest(commit(0)), true);
  assert.equal(isNativeRequest(commit(1)), true);
  assert.equal(isNativeRequest(commit(500)), true);
  for (const value of [501, -1, 1.5, "100"]) {
    assert.equal(isNativeRequest(commit(value)), false, String(value));
  }
});

test("commit_write accepts only JSON-safe absolute Windows tick deadlines", () => {
  assert.equal(isNativeRequest(commit(undefined, 0)), true);
  assert.equal(isNativeRequest(commit(undefined, 987654321)), true);
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "987654321"]) {
    assert.equal(isNativeRequest(commit(undefined, value)), false, String(value));
  }
});
