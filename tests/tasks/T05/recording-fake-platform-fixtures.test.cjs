"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const fixtureModulePath = path.join(__dirname, "recording-fake-platform-fixtures.cjs");
const { PREPARATION_BOUNDARY, RecordingFakePlatform, SCENARIO_SEEDS, loadFixtureCatalog } = require(fixtureModulePath);
const catalog = loadFixtureCatalog();
const acceptanceFieldNames = new Set(["expected", "expectedResult", "expectedCalls", "result", "outcome", "pass", "status", "evidence"]);

function assertNoAcceptanceFields(value, location) {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) assertNoAcceptanceFields(entry, `${location}[${index}]`);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    assert.ok(!acceptanceFieldNames.has(key), `${location}.${key} must not encode an acceptance result`);
    assertNoAcceptanceFields(entry, `${location}.${key}`);
  }
}

test("fixture catalog is explicitly preparation-only", () => {
  assert.equal(PREPARATION_BOUNDARY.classification, "PREPARATION_ONLY");
  for (const [key, value] of Object.entries(PREPARATION_BOUNDARY)) {
    if (key !== "classification") assert.equal(value, false, `${key} must remain false`);
  }
  assert.equal(catalog.fixturePlanStatus, "preflight_only");
  assert.equal(catalog.fixturePlanExecutionStatus, "NOT_RUN");
  assert.equal(catalog.assertionMapExecutionStatus, "NOT_RUN");
});

test("scenario seeds cover planned P01-P28 in order and preserve source setup/action", () => {
  const plan = JSON.parse(fs.readFileSync(path.join(__dirname, "fixture-plan.json"), "utf8"));
  const expectedIds = Array.from({ length: 28 }, (_, index) => `P${String(index + 1).padStart(2, "0")}`);
  assert.deepEqual(SCENARIO_SEEDS.map((seed) => seed.caseId), expectedIds);
  assert.deepEqual(catalog.cases.map((scenario) => scenario.caseId), expectedIds);

  for (const [index, scenario] of catalog.cases.entries()) {
    assert.equal(scenario.setup, plan.cases[index].setup);
    assert.equal(scenario.action, plan.cases[index].action);
    assert.ok(scenario.runs.length > 0, `${scenario.caseId} needs at least one inert run seed`);
  }
});

test("all 71 mapped assertions remain NOT_RUN with empty evidence", () => {
  const map = JSON.parse(fs.readFileSync(path.join(__dirname, "assertion-map.json"), "utf8"));
  assert.equal(map.assertions.length, 71);
  assert.equal(catalog.assertions.length, 71);
  assert.ok(catalog.assertions.every((assertion) => assertion.status === "NOT_RUN"));
  assert.ok(catalog.assertions.every((assertion) => Array.isArray(assertion.evidence) && assertion.evidence.length === 0));

  for (const scenario of catalog.cases) {
    const expected = map.assertions.filter((assertion) => assertion.caseId === scenario.caseId)
      .map((assertion) => assertion.assertionId);
    assert.deepEqual(scenario.assertionIds, expected);
  }
});

test("scenario entries contain synthetic inputs only and no result or expected-call fields", () => {
  const allowedCaseKeys = ["caseId", "setup", "action", "assertionIds", "runs"];
  const allowedRunKeys = ["runId", "initialState", "stimuli"];
  const runIds = new Set();

  for (const scenario of catalog.cases) {
    assert.deepEqual(Object.keys(scenario).sort(), [...allowedCaseKeys].sort());
    for (const run of scenario.runs) {
      assert.deepEqual(Object.keys(run).sort(), [...allowedRunKeys].sort());
      assert.match(run.runId, new RegExp(`^${scenario.caseId}-`));
      assert.ok(!runIds.has(run.runId), `duplicate synthetic run ID ${run.runId}`);
      runIds.add(run.runId);
      assert.ok(run.initialState && typeof run.initialState === "object");
      assert.ok(Array.isArray(run.stimuli) && run.stimuli.length > 0);
      assertNoAcceptanceFields(run.initialState, `${run.runId}.initialState`);
      assertNoAcceptanceFields(run.stimuli, `${run.runId}.stimuli`);
      for (const stimulus of run.stimuli) {
        assert.equal(typeof stimulus.event, "string");
        assert.ok(!Object.hasOwn(stimulus, "result"));
        assert.ok(!Object.hasOwn(stimulus, "expectedCalls"));
        assert.ok(!Object.hasOwn(stimulus, "assertionStatus"));
      }
    }
  }
  assert.ok(runIds.size > catalog.cases.length, "multi-boundary cases should preserve separate synthetic runs");
});

test("RecordingFakePlatform records supplied descriptors in memory and returns no fake result", () => {
  const recorder = new RecordingFakePlatform();
  const details = { sequence: 1, synthetic: true };
  const returned = recorder.recordCall({ label: "fixture-only:probe", requestId: "P01-probe", details });
  details.sequence = 2;

  assert.equal(returned, undefined);
  assert.deepEqual(recorder.snapshot(), [
    { label: "fixture-only:probe", requestId: "P01-probe", details: { sequence: 1, synthetic: true } },
  ]);

  const detachedSnapshot = recorder.snapshot();
  detachedSnapshot[0].details.sequence = 3;
  assert.equal(recorder.snapshot()[0].details.sequence, 1);
  assert.throws(() => recorder.recordCall({ label: "", requestId: "P01-probe", details: {} }), TypeError);
});

test("RecordingFakePlatform instances keep independent traces", () => {
  const first = new RecordingFakePlatform();
  const second = new RecordingFakePlatform();
  first.recordCall({ label: "fixture-only:first", requestId: "P01-first", details: { synthetic: true } });
  second.recordCall({ label: "fixture-only:second", requestId: "P02-second", details: { synthetic: true } });

  assert.deepEqual(first.snapshot().map((call) => call.label), ["fixture-only:first"]);
  assert.deepEqual(second.snapshot().map((call) => call.label), ["fixture-only:second"]);
});

test("fixture module imports Node built-ins only", () => {
  const source = fs.readFileSync(fixtureModulePath, "utf8");
  const imports = [...source.matchAll(/\brequire\(["']([^"']+)["']\)/g)].map((match) => match[1]);
  assert.deepEqual(imports, ["node:fs", "node:path"]);
  assert.ok(!source.includes("src/"));
  assert.ok(!source.includes("dist-electron/"));
});
