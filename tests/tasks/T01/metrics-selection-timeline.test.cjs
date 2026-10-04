const assert = require("node:assert/strict");
const { test } = require("node:test");
const { MetricsRecorder } = require("../../../dist-electron/main/metrics/recorder.js");

test("selection timeline separates SendInput ACK from target display observation", () => {
  let now = 100;
  const recorder = new MetricsRecorder({
    enabled: true,
    now: () => now,
    createRequestId: () => "synthetic-selection-1",
  });
  const requestId = recorder.begin("selection");
  now = 104;
  recorder.mark(requestId, "selection_received");
  now = 111;
  recorder.mark(requestId, "clipboard_written");
  now = 116;
  recorder.mark(requestId, "paste_helper_spawned");
  now = 121;
  recorder.mark(requestId, "send_input_acknowledged");
  now = 134;
  recorder.mark(requestId, "target_display_observed");
  now = 136;
  recorder.finish(requestId, "ok");

  const events = recorder.snapshot();
  const ack = events.find((event) => event.stage === "send_input_acknowledged");
  const display = events.find((event) => event.stage === "target_display_observed");
  assert.ok(ack);
  assert.ok(display);
  assert.equal(ack.requestId, display.requestId);
  assert.equal(ack.elapsedMs, 21);
  assert.equal(display.elapsedMs, 34);
  assert.equal(display.stageDurationMs, 13);
  assert.notEqual(ack.stage, display.stage);
  assert.ok(events.every((event) => !("content" in event) && !("windowTitle" in event)));
});
