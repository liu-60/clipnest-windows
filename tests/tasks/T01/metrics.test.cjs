const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");
const { MetricsRecorder } = require("../../../dist-electron/main/metrics/recorder.js");
const repositoryRoot = path.resolve(__dirname, "../../..");
const benchmarkScript = path.join(repositoryRoot, "scripts/benchmark/bench-desktop.cjs");

test("disabled metrics create no request IDs or records", () => {
  const recorder = new MetricsRecorder({ createRequestId: () => "must-not-be-created" });
  assert.equal(recorder.begin("wake"), null);
  assert.deepEqual(recorder.snapshot(), []);
});

test("request timeline uses monotonic deltas and contains metadata only", () => {
  let now = 100;
  const recorder = new MetricsRecorder({
    enabled: true,
    now: () => now,
    createRequestId: () => "synthetic-request-1",
  });

  const requestId = recorder.begin("wake");
  assert.equal(requestId, "synthetic-request-1");
  now = 112.5;
  assert.equal(recorder.mark(requestId, "panel_actionable"), true);
  now = 118;
  assert.equal(recorder.finish(requestId, "ok"), true);
  assert.equal(recorder.finish(requestId, "ok"), false);

  const events = recorder.snapshot();
  assert.deepEqual(events.map((event) => event.stage), [
    "request_started",
    "panel_actionable",
    "request_finished",
  ]);
  assert.equal(events[1].elapsedMs, 12.5);
  assert.equal(events[1].stageDurationMs, 12.5);
  assert.equal(events[2].elapsedMs, 18);
  assert.equal(events[2].stageDurationMs, 5.5);
  assert.ok(events.every((event) => !("content" in event) && !("windowTitle" in event)));
});

test("unknown or completed request IDs cannot add events", () => {
  const recorder = new MetricsRecorder({ enabled: true, createRequestId: () => "known" });
  assert.equal(recorder.mark("unknown", "panel_actionable"), false);
  const requestId = recorder.begin("selection");
  recorder.finish(requestId, "no_input");
  assert.equal(recorder.mark(requestId, "send_input_acknowledged"), false);
  assert.equal(recorder.snapshot().length, 2);
});

test("active requests and the retained timeline stay bounded", () => {
  let nextId = 0;
  const recorder = new MetricsRecorder({
    enabled: true,
    createRequestId: () => `request-${++nextId}`,
    maxRecords: 32,
  });
  for (let index = 0; index < 32; index += 1) recorder.begin("wake");
  assert.equal(recorder.begin("wake"), null);
  for (let index = 0; index < 64; index += 1) {
    recorder.finish(`request-${index + 1}`, "ok");
  }
  assert.equal(recorder.snapshot().length, 32);
});

test("benchmark refuses to run without --no-input before build or app launch", () => {
  const result = spawnSync(process.execPath, [
    benchmarkScript,
    "--profile",
    "tests/tasks/T01/runtime-profile",
    "--samples",
    "1",
  ], { cwd: repositoryRoot, encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--no-input is mandatory/);
  assert.equal(result.stdout.includes("building for production"), false);
});

test("benchmark refuses a profile outside the T01 fixture root before build or app launch", () => {
  const result = spawnSync(process.execPath, [
    benchmarkScript,
    "--profile",
    ".test-data/profile",
    "--no-input",
    "--samples",
    "1",
  ], { cwd: repositoryRoot, encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--profile must be tests\/tasks\/T01\/runtime-profile/);
  assert.equal(result.stdout.includes("building for production"), false);
});

test("benchmark refuses report paths outside T01 evidence before build or app launch", () => {
  const result = spawnSync(process.execPath, [
    benchmarkScript,
    "--profile",
    "tests/tasks/T01/runtime-profile",
    "--no-input",
    "--report",
    "..\\escape.json",
  ], { cwd: repositoryRoot, encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /--report must be a JSON filename in docs\/evidence\/T01/);
  assert.equal(result.stdout.includes("building for production"), false);
});
