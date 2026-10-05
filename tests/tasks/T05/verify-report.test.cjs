"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { buildNotRunReport } = require("./create-not-run-report.cjs");
const {
  SAMPLE_REPORT,
  collectEvidenceErrors,
  collectReportErrors,
  loadVerifierContext,
  nearestRankPercentile,
  validateEvidenceReference,
  validateMeasurement,
} = require("./verify-report.cjs");
const { loadPreparationInputs } = require("./validate-preparation.cjs");

const context = loadVerifierContext();
const example = JSON.parse(fs.readFileSync(SAMPLE_REPORT, "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));
const sample = (requestId, outcome, valueMs) => ({
  requestId,
  outcome,
  result: outcome === "success" ? "inputSubmitted" : outcome,
  valueMs,
  stageMs: { total: valueMs },
});

function measuredFixture(samples) {
  const counts = { success: 0, failure: 0, cancelled: 0, timeout: 0 };
  for (const item of samples) counts[item.outcome] += 1;
  const successful = samples.filter((item) => item.outcome === "success").map((item) => item.valueMs);
  return {
    status: "FAIL",
    observationMode: "fake",
    targetSampleCount: 100,
    successfulSampleCount: counts.success,
    failureCount: counts.failure,
    cancellationCount: counts.cancelled,
    timeoutCount: counts.timeout,
    p50Ms: nearestRankPercentile(successful, 0.5),
    p95Ms: nearestRankPercentile(successful, 0.95),
    maxMs: nearestRankPercentile(successful, 1),
    evidence: [],
    samples,
  };
}

function errorsFor(report, overrides = {}, validationOptions = {}) {
  return collectReportErrors(report, { ...context, ...overrides }, validationOptions);
}

test("NOT_RUN example is reproducible and maps all cases and assertion IDs", () => {
  const inputs = loadPreparationInputs();
  const generated = buildNotRunReport({
    fixturePlan: inputs.fixturePlan,
    assertionMap: inputs.assertionMap,
    progress: context.progress,
  });
  assert.deepEqual(example, generated);
  assert.deepEqual(errorsFor(example), []);
  assert.equal(example.cases.length, 28);
  assert.equal(example.cases.reduce((sum, item) => sum + item.assertions.length, 0), 71);
  assert.equal(example.status, "NOT_RUN");
  assert.equal(example.measurements.normalText.samples.length, 0);
  assert.equal(example.measurements.wakeToActionable.samples.length, 0);
});

test("the regular Node consistency checker does not require the optional schema validator", () => {
  assert.deepEqual(
    errorsFor(example, {}, { pythonExecutables: ["clipnest-python-not-installed"] }),
    [],
  );
});

test("report assertion names must match all 71 mapped IDs in each case", () => {
  const report = clone(example);
  report.cases[20].assertions.pop();
  report.cases[0].assertions[0].name = "P02-A01";
  const errors = errorsFor(report);
  assert.equal(errors.filter((error) => error.code === "ASSERTION_NAMES_MISMATCH").length, 2);
});

test("report case IDs must match P01-P28 exactly once and in source order", () => {
  const report = clone(example);
  report.cases[1].id = report.cases[0].id;
  assert.ok(errorsFor(report).some((error) => error.code === "CASE_IDS_MISMATCH"));
});

test("dependencyGate is compared with current docs/progress.json, not its own claim", () => {
  const report = clone(example);
  report.dependencyGate.T04 = "accepted";
  assert.ok(errorsFor(report).some((error) => error.code === "DEPENDENCY_MISMATCH"));

  const forgedProgress = clone(context.progress);
  forgedProgress.tasks.T04.status = "accepted";
  assert.ok(errorsFor(example, { progress: forgedProgress }).some((error) => error.code === "DEPENDENCY_MISMATCH"));
});

test("a forged root PASS is rejected while current dependency T04 is not accepted", () => {
  const report = clone(example);
  report.status = "PASS";
  report.dependencyGate.T04 = "accepted";
  report.notRun = [];
  const errors = errorsFor(report);
  assert.ok(errors.some((error) => error.code === "DEPENDENCY_MISMATCH"));
  assert.ok(errors.some((error) => error.code === "PASS_BLOCKED_UNACCEPTED_DEPENDENCY"));
  assert.ok(errors.some((error) => error.code === "PASS_CASE_REQUIRED"));
});

test("root PASS requires the complete recorded environment", () => {
  const report = clone(example);
  report.status = "PASS";
  report.dependencyGate = { T03: "accepted", T04: "accepted" };
  report.environment = {
    platform: "Windows",
    osVersion: "Windows 11",
    architecture: "x64",
    buildMode: "release",
    dataProfile: "isolated_synthetic",
    datasetSeed: "seed-1",
    displayConfiguration: "1920x1080",
    powerMode: null,
    networkCondition: "offline",
    cacheState: "cold",
  };
  const acceptedContext = clone(context);
  acceptedContext.progress.tasks.T03.status = "accepted";
  acceptedContext.progress.tasks.T04.status = "accepted";
  acceptedContext.progress.tasks.T05.status = "in_progress";

  assert.ok(collectReportErrors(report, acceptedContext).some((error) => error.code === "PASS_ENVIRONMENT_REQUIRED"));

  report.environment.powerMode = "AC";
  report.environment.datasetSeed = "s".repeat(129);
  assert.ok(collectReportErrors(report, acceptedContext).some((error) => error.code === "PASS_ENVIRONMENT_REQUIRED"));
});

test("root PASS requires a valid or unsigned rollback helper signature", () => {
  const report = clone(example);
  report.status = "PASS";
  report.dependencyGate = { T03: "accepted", T04: "accepted" };
  const acceptedContext = clone(context);
  acceptedContext.progress.tasks.T03.status = "accepted";
  acceptedContext.progress.tasks.T04.status = "accepted";
  acceptedContext.progress.tasks.T05.status = "in_progress";

  assert.ok(collectReportErrors(report, acceptedContext).some((error) => error.code === "PASS_ROLLBACK_SIGNATURE_STATUS"));
});

test("root PASS recomputes helper identity from expected and actual fields", () => {
  const report = clone(example);
  report.status = "PASS";
  report.dependencyGate = { T03: "accepted", T04: "accepted" };
  const acceptedContext = clone(context);
  acceptedContext.progress.tasks.T03.status = "accepted";
  acceptedContext.progress.tasks.T04.status = "accepted";
  acceptedContext.progress.tasks.T05.status = "in_progress";

  Object.assign(report.packageAndRollback.helperResource, {
    result: "PASS",
    expectedPath: "resources/native/clipnest-helper.exe",
    actualPath: "resources/native/clipnest-helper.exe",
    expectedVersion: "1.0.0",
    actualVersion: "1.0.0",
    expectedProtocol: "1",
    actualProtocol: "1",
    expectedSha256: "a".repeat(64),
    actualSha256: "a".repeat(64),
    identityMatched: true,
    signatureStatus: "valid",
    evidence: ["tests/tasks/T05/fixture-plan.json"],
  });

  const mismatchMutations = [
    (helper) => { helper.actualPath = "resources/other/clipnest-helper.exe"; },
    (helper) => { helper.actualVersion = "1.0.1"; },
    (helper) => { helper.actualProtocol = "2"; },
    (helper) => { helper.actualSha256 = "b".repeat(64); },
    (helper) => { helper.identityMatched = false; },
  ];
  for (const mutate of mismatchMutations) {
    const forged = clone(report);
    mutate(forged.packageAndRollback.helperResource);
    assert.ok(
      collectReportErrors(forged, acceptedContext).some((error) => error.code === "PASS_HELPER_IDENTITY_REQUIRED"),
    );
  }
});

test("root PASS recomputes rollback version and hash identity", () => {
  const report = clone(example);
  report.status = "PASS";
  report.dependencyGate = { T03: "accepted", T04: "accepted" };
  const acceptedContext = clone(context);
  acceptedContext.progress.tasks.T03.status = "accepted";
  acceptedContext.progress.tasks.T04.status = "accepted";
  acceptedContext.progress.tasks.T05.status = "in_progress";

  Object.assign(report.packageAndRollback.rollback, {
    result: "PASS",
    priorVersion: "1.0.0",
    rollbackVersion: "1.0.0",
    priorSha256: "a".repeat(64),
    rollbackSha256: "a".repeat(64),
    identityMatched: true,
    signatureStatus: "valid",
    helperBinaryOnly: { name: "helperBinaryOnly", result: "PASS", evidence: ["tests/tasks/T05/fixture-plan.json"] },
    evidence: ["tests/tasks/T05/fixture-plan.json"],
  });

  const mismatchMutations = [
    (rollback) => { rollback.rollbackVersion = "1.0.1"; },
    (rollback) => { rollback.rollbackSha256 = "b".repeat(64); },
    (rollback) => { rollback.identityMatched = false; },
  ];
  for (const mutate of mismatchMutations) {
    const forged = clone(report);
    mutate(forged.packageAndRollback.rollback);
    assert.ok(
      collectReportErrors(forged, acceptedContext).some((error) => error.code === "PASS_ROLLBACK_IDENTITY_REQUIRED"),
    );
  }
});

test("a PASS subcheck cannot be reported before dependencies or without local evidence", () => {
  const report = clone(example);
  report.cases[0].result = "PASS";
  report.cases[0].evidence = ["../outside-evidence.json"];
  const errors = errorsFor(report);
  assert.ok(errors.some((error) => error.code === "PASS_BLOCKED_UNACCEPTED_DEPENDENCY"));
  assert.ok(errors.some((error) => error.code === "EVIDENCE_PATH_OUTSIDE_REPO"));
});

test("duplicate sample request IDs are rejected", () => {
  const metric = measuredFixture([
    sample("same-request", "success", 12.5),
    sample("same-request", "failure", 18.25),
  ]);
  const errors = validateMeasurement(metric, "metric", []);
  assert.ok(errors.some((error) => error.code === "SAMPLE_REQUEST_ID_DUPLICATE"));
});

test("request IDs are unique across both timing metrics", () => {
  const report = clone(example);
  report.measurements.normalText = measuredFixture([sample("shared-request", "success", 12)]);
  report.measurements.wakeToActionable = measuredFixture([sample("shared-request", "failure", 18)]);
  assert.ok(errorsFor(report).some((error) => error.code === "SAMPLE_REQUEST_ID_DUPLICATE_REPORT"));
});

test("outcome counts must equal the raw sample rows", () => {
  const metric = measuredFixture([
    sample("request-1", "success", 12.5),
    sample("request-2", "timeout", 30),
  ]);
  metric.timeoutCount = 0;
  const errors = validateMeasurement(metric, "metric", []);
  assert.ok(errors.some((error) => error.code === "MEASUREMENT_COUNT_MISMATCH"));
});

test("p50, p95, and max use the benchmark nearest-rank rule on successful valueMs", () => {
  const metric = measuredFixture([
    sample("request-1", "success", 1.12345),
    sample("request-2", "success", 2.23456),
    sample("request-3", "success", 3.34567),
    sample("request-4", "failure", 99),
  ]);
  assert.deepEqual([metric.p50Ms, metric.p95Ms, metric.maxMs], [2.235, 3.346, 3.346]);
  assert.deepEqual(validateMeasurement(metric, "metric", []), []);

  metric.p95Ms = 3.345;
  assert.ok(validateMeasurement(metric, "metric", []).some((error) => error.code === "MEASUREMENT_STAT_MISMATCH"));
});

test("NOT_RUN metrics have no samples and null statistics", () => {
  const report = clone(example);
  report.measurements.normalText.samples = [sample("request-1", "success", 1)];
  report.measurements.normalText.successfulSampleCount = 1;
  const errors = errorsFor(report);
  assert.ok(errors.some((error) => error.code === "NOT_RUN_MEASUREMENT_HAS_DATA"));
});

test("PASS evidence references must resolve to existing files inside the repository", () => {
  assert.equal(validateEvidenceReference("tests/tasks/T05/fixture-plan.json", context.repoRoot), null);
  assert.equal(validateEvidenceReference("../outside.json", context.repoRoot).code, "EVIDENCE_PATH_OUTSIDE_REPO");
  assert.equal(validateEvidenceReference("tests/tasks/T05/missing-evidence.json", context.repoRoot).code, "EVIDENCE_NOT_FOUND");
  assert.equal(validateEvidenceReference(path.resolve(context.repoRoot, "tests/tasks/T05/fixture-plan.json"), context.repoRoot).code, "EVIDENCE_PATH_OUTSIDE_REPO");

  const errors = collectEvidenceErrors({
    checks: [{ result: "PASS", evidence: ["tests/tasks/T05/fixture-plan.json"] }],
  }, context.repoRoot);
  assert.deepEqual(errors, []);
});

test("schema makes assertion IDs and raw sample valueMs explicit", () => {
  const { reportSchema } = loadPreparationInputs();
  const caseResult = reportSchema.$defs.caseResult;
  const assertionSchema = caseResult.properties.assertions.items.allOf[1].properties.name;
  const measurementSample = reportSchema.$defs.measurement.properties.samples.items;
  assert.match("P21-A06", new RegExp(assertionSchema.pattern));
  assert.ok(measurementSample.required.includes("valueMs"));
  assert.equal(measurementSample.properties.valueMs.type, "number");
});

test("successful metric samples require the target result and every §04 stage timing", () => {
  const metricContracts = {
    normalText: {
      expectedResult: "inputSubmitted",
      stageKeys: ["selection", "write", "hide", "focus", "modifier", "inputSubmitted"],
    },
    wakeToActionable: {
      expectedResult: "list_actionable",
      stageKeys: ["hotkey", "capture", "show", "firstFrame", "actionable"],
    },
  };

  for (const [metricName, contract] of Object.entries(metricContracts)) {
    const makeReport = (result, stageKeys) => {
      const report = clone(example);
      report.status = "REVIEW";
      const successfulSample = {
        ...sample(`${metricName}-request`, "success", 12),
        result,
        stageMs: Object.fromEntries(stageKeys.map((key) => [key, 1])),
      };
      report.measurements[metricName] = measuredFixture([successfulSample]);
      return report;
    };

    const wrongResult = errorsFor(makeReport("copiedOnly", contract.stageKeys));
    assert.ok(wrongResult.some((error) => error.code === "SAMPLE_SUCCESS_RESULT_MISMATCH"), metricName);

    const missingStage = errorsFor(makeReport(contract.expectedResult, contract.stageKeys.slice(1)));
    assert.ok(missingStage.some((error) => error.code === "SAMPLE_STAGE_TIMING_MISSING"), metricName);
  }
});
