"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { buildNotRunReport } = require("./create-not-run-report.cjs");
const {
  SAMPLE_REPORT,
  collectEvidenceErrors,
  collectReportErrors,
  loadIdentityManifestFile,
  loadVerifierContext,
  nearestRankPercentile,
  validateEvidenceReference,
  validateArtifactFileSha256,
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

function createArtifactFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipnest-t05-artifact-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    write(relativePath, contents) {
      const filePath = path.join(root, ...relativePath.split("/"));
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, contents);
      return crypto.createHash("sha256").update(contents).digest("hex");
    },
  };
}

function createIdentityManifestFixture(t, manifest) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clipnest-t05-identity-manifest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, "expected-identity.json");
  fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
  return filePath;
}

function syntheticIdentityManifest({ sourceCommit = "synthetic-source-commit", helperSha256 = "a".repeat(64), helperVersion = "1.0.0", helperProtocol = "1", rollbackPath = "rollback/prior-helper.exe", rollbackSha256 = "b".repeat(64), rollbackVersion = "0.9.0" } = {}) {
  return {
    schemaVersion: 1,
    task: "T05",
    sourceCommit,
    artifactRootKind: "windows_x64_unpacked_app_root",
    helper: {
      relativePath: "resources/native/clipnest-helper.exe",
      sha256: helperSha256,
      version: helperVersion,
      protocol: helperProtocol,
    },
    rollbackPrior: {
      relativePath: rollbackPath,
      sha256: rollbackSha256,
      version: rollbackVersion,
    },
  };
}

function loadSyntheticIdentityContext(t, acceptedContext, artifactRoot, manifest) {
  const manifestPath = createIdentityManifestFixture(t, manifest);
  Object.assign(acceptedContext, loadIdentityManifestFile(manifestPath, SAMPLE_REPORT, artifactRoot));
  return acceptedContext;
}

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

test("caller identity manifest is a separate CLI file outside the report and artifact root", (t) => {
  const artifact = createArtifactFixture(t);
  const manifest = syntheticIdentityManifest();
  const manifestPath = createIdentityManifestFixture(t, manifest);
  const loaded = loadIdentityManifestFile(manifestPath, SAMPLE_REPORT, artifact.root);
  assert.equal(loaded.identityManifestPathIndependent, true);
  assert.deepEqual(loaded.identityManifest, manifest);
  assert.equal(loaded.identityManifestSha256, crypto.createHash("sha256")
    .update(fs.readFileSync(manifestPath)).digest("hex"));

  const reportAlias = loadIdentityManifestFile(SAMPLE_REPORT, SAMPLE_REPORT, artifact.root);
  assert.equal(reportAlias.identityManifestError.code, "IDENTITY_MANIFEST_REPORT_ALIAS");

  artifact.write("expected-identity.json", Buffer.from(JSON.stringify(manifest)));
  const insideRoot = loadIdentityManifestFile(
    path.join(artifact.root, "expected-identity.json"),
    SAMPLE_REPORT,
    artifact.root,
  );
  assert.equal(insideRoot.identityManifestError.code, "IDENTITY_MANIFEST_INSIDE_ARTIFACT_ROOT");
});

test("CLI accepts at most one caller identity manifest path", () => {
  const result = spawnSync(process.execPath, [
    path.join(__dirname, "verify-report.cjs"),
    "--identity-manifest",
    "first.json",
    "--identity-manifest=second.json",
    SAMPLE_REPORT,
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /provide --identity-manifest at most once/);
});

function syntheticG0PassReport() {
  const report = clone(example);
  report.status = "REVIEW";
  report.notRun = report.notRun.filter((item) => !item.includes("Both G0 runtime observation gates"));
  report.g0Runtime.noInteractiveBlockingSpawnSync = {
    name: "noInteractiveBlockingSpawnSync",
    result: "PASS",
    evidence: [],
    observation: {
      requestIds: ["synthetic-spawn-request-1"],
      interactionSequenceByRequestId: {
        "synthetic-spawn-request-1": { startSequence: 10, endSequence: 20 },
      },
      callsByRequestId: { "synthetic-spawn-request-1": [] },
      instrumentedBlockingSpawnSyncCalls: 0,
    },
  };
  report.g0Runtime.noHelperProcessPerInteraction = {
    name: "noHelperProcessPerInteraction",
    result: "PASS",
    evidence: [],
    observation: {
      requestIds: ["synthetic-helper-request-1", "synthetic-helper-request-2"],
      interactionSequenceByRequestId: {
        "synthetic-helper-request-1": { startSequence: 10, endSequence: 20 },
        "synthetic-helper-request-2": { startSequence: 30, endSequence: 40 },
      },
      observationsByRequestId: {
        "synthetic-helper-request-1": {
          helperBefore: { pid: 1200, creationIdentity: "synthetic-helper-created-at-1" },
          helperAfter: { pid: 1200, creationIdentity: "synthetic-helper-created-at-1" },
          helperLaunchCount: 0,
        },
        "synthetic-helper-request-2": {
          helperBefore: { pid: 1200, creationIdentity: "synthetic-helper-created-at-1" },
          helperAfter: { pid: 1200, creationIdentity: "synthetic-helper-created-at-1" },
          helperLaunchCount: 0,
        },
      },
    },
  };
  return report;
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

test("G0 PASS rejects evidence-only claims and validates synthetic structure without runtime evidence", () => {
  const weakReport = syntheticG0PassReport();
  weakReport.g0Runtime.noInteractiveBlockingSpawnSync.evidence = ["tests/tasks/T05/fixture-plan.json"];
  weakReport.g0Runtime.noHelperProcessPerInteraction.evidence = ["tests/tasks/T05/fixture-plan.json"];
  delete weakReport.g0Runtime.noInteractiveBlockingSpawnSync.observation;
  delete weakReport.g0Runtime.noHelperProcessPerInteraction.observation;
  const weakCodes = new Set(errorsFor(weakReport).map((error) => error.code));
  assert.ok(weakCodes.has("G0_BLOCKING_SPAWNSYNC_OBSERVATION_REQUIRED"));
  assert.ok(weakCodes.has("G0_HELPER_REUSE_OBSERVATION_REQUIRED"));

  const acceptedReport = syntheticG0PassReport();
  acceptedReport.dependencyGate = { T03: "accepted", T04: "accepted" };
  const acceptedProgress = clone(context.progress);
  acceptedProgress.tasks.T03.status = "accepted";
  acceptedProgress.tasks.T04.status = "accepted";
  const acceptedCodes = errorsFor(acceptedReport, { progress: acceptedProgress }).map((error) => error.code);
  assert.equal(acceptedCodes.filter((code) => code.startsWith("G0_")).length, 0);
  assert.equal(acceptedCodes.filter((code) => code === "PASS_EVIDENCE_REQUIRED").length, 2);
});

test("G0 PASS recomputes spawn counts, request ID uniqueness, and helper identity across interactions", () => {
  const base = syntheticG0PassReport();
  const mismatches = [
    (report) => { report.g0Runtime.noInteractiveBlockingSpawnSync.observation.instrumentedBlockingSpawnSyncCalls = 1; },
    (report) => { report.g0Runtime.noInteractiveBlockingSpawnSync.observation.requestIds.push("synthetic-spawn-request-1"); },
    (report) => { report.g0Runtime.noHelperProcessPerInteraction.observation.requestIds[1] = "synthetic-helper-request-1"; },
    (report) => { report.g0Runtime.noHelperProcessPerInteraction.observation.observationsByRequestId["synthetic-helper-request-1"].helperLaunchCount = 1; },
    (report) => { report.g0Runtime.noHelperProcessPerInteraction.observation.observationsByRequestId["synthetic-helper-request-1"].helperAfter.pid += 1; },
    (report) => { report.g0Runtime.noHelperProcessPerInteraction.observation.observationsByRequestId["synthetic-helper-request-1"].helperAfter.creationIdentity = "synthetic-helper-created-at-2"; },
    (report) => {
      const observations = report.g0Runtime.noHelperProcessPerInteraction.observation.observationsByRequestId;
      observations["synthetic-helper-request-2"].helperBefore = { pid: 1201, creationIdentity: "synthetic-helper-created-at-2" };
      observations["synthetic-helper-request-2"].helperAfter = { pid: 1201, creationIdentity: "synthetic-helper-created-at-2" };
    },
  ];
  const expectedCodes = [
    "G0_BLOCKING_SPAWNSYNC_COUNT",
    "G0_REQUEST_ID_DUPLICATE",
    "G0_REQUEST_ID_DUPLICATE",
    "G0_HELPER_LAUNCH_COUNT",
    "G0_HELPER_PROCESS_IDENTITY_MISMATCH",
    "G0_HELPER_PROCESS_IDENTITY_MISMATCH",
    "G0_HELPER_PROCESS_IDENTITY_CROSS_INTERACTION",
  ];

  for (const [index, mutate] of mismatches.entries()) {
    const report = clone(base);
    mutate(report);
    assert.ok(errorsFor(report).some((error) => error.code === expectedCodes[index]));
  }
});

test("G0 spawn traces require exact request coverage, empty calls, and bounded fields", () => {
  const base = syntheticG0PassReport();
  const mismatches = [
    [(report) => { delete report.g0Runtime.noInteractiveBlockingSpawnSync.observation.callsByRequestId; }, "G0_BLOCKING_SPAWNSYNC_CALL_MAP_REQUIRED"],
    [(report) => { report.g0Runtime.noInteractiveBlockingSpawnSync.observation.callsByRequestId = {}; }, "G0_BLOCKING_SPAWNSYNC_CALL_IDS_MISMATCH"],
    [(report) => { report.g0Runtime.noInteractiveBlockingSpawnSync.observation.callsByRequestId.extra = []; }, "G0_BLOCKING_SPAWNSYNC_CALL_IDS_MISMATCH"],
    [(report) => { report.g0Runtime.noInteractiveBlockingSpawnSync.observation.callsByRequestId["synthetic-spawn-request-1"] = ["spawnSync"]; }, "G0_BLOCKING_SPAWN_API_CALLS"],
    [(report) => { report.g0Runtime.noInteractiveBlockingSpawnSync.observation.extra = true; }, "G0_BLOCKING_SPAWNSYNC_OBSERVATION_FIELDS"],
    [(report) => { delete report.g0Runtime.noInteractiveBlockingSpawnSync.observation.interactionSequenceByRequestId; }, "G0_INTERACTION_SEQUENCE_MAP_REQUIRED"],
    [(report) => { report.g0Runtime.noInteractiveBlockingSpawnSync.observation.interactionSequenceByRequestId.extra = { startSequence: 50, endSequence: 60 }; }, "G0_INTERACTION_SEQUENCE_IDS_MISMATCH"],
    [(report) => { report.g0Runtime.noInteractiveBlockingSpawnSync.observation.interactionSequenceByRequestId["synthetic-spawn-request-1"].endSequence = 10; }, "G0_INTERACTION_SEQUENCE_BOUNDS_INVALID"],
    [(report) => {
      const longId = "x".repeat(129);
      const observation = report.g0Runtime.noInteractiveBlockingSpawnSync.observation;
      observation.requestIds = [longId];
      observation.callsByRequestId = { [longId]: [] };
    }, "G0_REQUEST_ID_INVALID"],
    [(report) => { report.g0Runtime.noHelperProcessPerInteraction.observation.observationsByRequestId["synthetic-helper-request-1"].helperBefore.extra = true; }, "G0_HELPER_PROCESS_IDENTITY_FIELDS"],
    [(report) => { report.g0Runtime.noHelperProcessPerInteraction.observation.observationsByRequestId["synthetic-helper-request-1"].extra = true; }, "G0_HELPER_OBSERVATION_FIELDS"],
    [(report) => { report.g0Runtime.noHelperProcessPerInteraction.observation.observationsByRequestId["synthetic-helper-request-1"].helperBefore.creationIdentity = "x".repeat(257); }, "G0_HELPER_PROCESS_IDENTITY_INVALID"],
    [(report) => { report.g0Runtime.noHelperProcessPerInteraction.observation.requestIds[1] = "unobserved-request"; }, "G0_HELPER_OBSERVATION_IDS_MISMATCH"],
    [(report) => { report.g0Runtime.noHelperProcessPerInteraction.observation.interactionSequenceByRequestId.extra = { startSequence: 50, endSequence: 60 }; }, "G0_INTERACTION_SEQUENCE_IDS_MISMATCH"],
    [(report) => { report.g0Runtime.noHelperProcessPerInteraction.observation.interactionSequenceByRequestId["synthetic-helper-request-2"].startSequence = 20; }, "G0_INTERACTION_SEQUENCE_ORDER_INVALID"],
  ];

  for (const [mutate, expectedCode] of mismatches) {
    const report = clone(base);
    mutate(report);
    assert.ok(errorsFor(report).some((error) => error.code === expectedCode), `expected ${expectedCode}`);
  }
});

test("G0 string limits count Unicode code points like Draft 2020-12 maxLength", () => {
  const report = syntheticG0PassReport();
  report.g0Runtime.noInteractiveBlockingSpawnSync.details = "😀".repeat(2000);
  const requestIdAtLimit = "😀".repeat(128);
  const spawnObservation = report.g0Runtime.noInteractiveBlockingSpawnSync.observation;
  spawnObservation.requestIds = [requestIdAtLimit];
  spawnObservation.callsByRequestId = { [requestIdAtLimit]: [] };
  spawnObservation.interactionSequenceByRequestId = { [requestIdAtLimit]: { startSequence: 10, endSequence: 20 } };
  const helperObservation = report.g0Runtime.noHelperProcessPerInteraction.observation;
  helperObservation.observationsByRequestId["synthetic-helper-request-1"].helperBefore.creationIdentity = "😀".repeat(256);
  helperObservation.observationsByRequestId["synthetic-helper-request-1"].helperAfter.creationIdentity = "😀".repeat(256);
  helperObservation.observationsByRequestId["synthetic-helper-request-2"].helperBefore.creationIdentity = "😀".repeat(256);
  helperObservation.observationsByRequestId["synthetic-helper-request-2"].helperAfter.creationIdentity = "😀".repeat(256);

  let g0Errors = errorsFor(report).filter((error) => error.code.startsWith("G0_"));
  assert.deepEqual(g0Errors, [], "128/256 astral code points are valid at the schema boundary");

  report.g0Runtime.noInteractiveBlockingSpawnSync.details = "😀".repeat(2001);
  assert.ok(errorsFor(report).some((error) => error.code === "G0_CHECK_DETAILS_INVALID"));

  report.g0Runtime.noInteractiveBlockingSpawnSync.details = "😀".repeat(2000);
  spawnObservation.requestIds = ["😀".repeat(129)];
  spawnObservation.callsByRequestId = { [spawnObservation.requestIds[0]]: [] };
  spawnObservation.interactionSequenceByRequestId = {
    [spawnObservation.requestIds[0]]: { startSequence: 10, endSequence: 20 },
  };
  assert.ok(errorsFor(report).some((error) => error.code === "G0_REQUEST_ID_INVALID"));

  spawnObservation.requestIds = [requestIdAtLimit];
  spawnObservation.callsByRequestId = { [requestIdAtLimit]: [] };
  helperObservation.observationsByRequestId["synthetic-helper-request-1"].helperBefore.creationIdentity = "😀".repeat(257);
  assert.ok(errorsFor(report).some((error) => error.code === "G0_HELPER_PROCESS_IDENTITY_INVALID"));
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

test("root PASS requires a valid rollback helper signature", () => {
  const report = clone(example);
  report.status = "PASS";
  report.dependencyGate = { T03: "accepted", T04: "accepted" };
  const acceptedContext = clone(context);
  acceptedContext.progress.tasks.T03.status = "accepted";
  acceptedContext.progress.tasks.T04.status = "accepted";
  acceptedContext.progress.tasks.T05.status = "in_progress";

  assert.ok(collectReportErrors(report, acceptedContext).some((error) => error.code === "PASS_ROLLBACK_SIGNATURE_STATUS"));
});

test("root PASS recomputes helper identity from expected and actual fields", (t) => {
  const report = clone(example);
  report.status = "PASS";
  report.source.commit = "synthetic-source-commit";
  report.dependencyGate = { T03: "accepted", T04: "accepted" };
  const acceptedContext = clone(context);
  acceptedContext.progress.tasks.T03.status = "accepted";
  acceptedContext.progress.tasks.T04.status = "accepted";
  acceptedContext.progress.tasks.T05.status = "in_progress";
  const artifact = createArtifactFixture(t);
  const helperSha256 = artifact.write(
    "resources/native/clipnest-helper.exe",
    Buffer.from("synthetic helper artifact bytes"),
  );
  acceptedContext.artifactRoot = artifact.root;

  Object.assign(report.packageAndRollback.helperResource, {
    result: "PASS",
    expectedPath: "resources/native/clipnest-helper.exe",
    actualPath: "resources/native/clipnest-helper.exe",
    expectedVersion: "1.0.0",
    actualVersion: "1.0.0",
    expectedProtocol: "1",
    actualProtocol: "1",
    expectedSha256: helperSha256,
    actualSha256: helperSha256,
    identityMatched: true,
    signatureStatus: "valid",
    evidence: ["tests/tasks/T05/fixture-plan.json"],
  });
  assert.ok(
    collectReportErrors(report, acceptedContext).some((error) => error.code === "PASS_IDENTITY_MANIFEST_REQUIRED"),
    "root PASS must reject report-only identity claims without the independent manifest input",
  );
  loadSyntheticIdentityContext(t, acceptedContext, artifact.root, syntheticIdentityManifest({
    sourceCommit: report.source.commit,
    helperSha256,
    helperVersion: "1.0.0",
    helperProtocol: "1",
  }));
  assert.ok(
    !collectReportErrors(report, acceptedContext).some((error) => error.code === "PASS_HELPER_IDENTITY_REQUIRED"),
  );
  assert.ok(
    !collectReportErrors(report, acceptedContext).some((error) => error.code === "PASS_HELPER_TRUSTED_IDENTITY_MISMATCH"),
    "correct helper claims and independently supplied synthetic manifest must agree",
  );
  const wrongSourceManifestContext = clone(acceptedContext);
  loadSyntheticIdentityContext(t, wrongSourceManifestContext, artifact.root, syntheticIdentityManifest({
    sourceCommit: "different-synthetic-commit",
    helperSha256,
    helperVersion: "1.0.0",
    helperProtocol: "1",
  }));
  assert.ok(
    collectReportErrors(report, wrongSourceManifestContext).some((error) => error.code === "PASS_IDENTITY_MANIFEST_SOURCE_MISMATCH"),
    "the independent identity manifest must be pinned to the report source commit",
  );
  const unsignedHelperReport = clone(report);
  unsignedHelperReport.packageAndRollback.helperResource.signatureStatus = "unsigned";
  assert.ok(
    collectReportErrors(unsignedHelperReport, acceptedContext)
      .some((error) => error.code === "PASS_UNSIGNED_SIGNATURE_POLICY_UNRESOLVED"),
  );
  const alternateHelperPath = "resources/alternate/clipnest-helper.exe";
  const alternateHelperSha256 = artifact.write(alternateHelperPath, Buffer.from("different synthetic helper bytes"));
  const alternatePathClaim = clone(report);
  Object.assign(alternatePathClaim.packageAndRollback.helperResource, {
    expectedPath: alternateHelperPath,
    actualPath: alternateHelperPath,
    expectedSha256: alternateHelperSha256,
    actualSha256: alternateHelperSha256,
  });
  assert.ok(
    collectReportErrors(alternatePathClaim, acceptedContext).some((error) => error.code === "PASS_HELPER_PATH_CONTRACT"),
  );
  assert.ok(
    collectReportErrors(alternatePathClaim, acceptedContext).some((error) => error.code === "PASS_HELPER_TRUSTED_IDENTITY_MISMATCH"),
    "a self-consistent alternate path and hash must still disagree with the external manifest",
  );
  const escapedHelperPath = clone(report);
  escapedHelperPath.packageAndRollback.helperResource.actualPath = "../outside/clipnest-helper.exe";
  assert.ok(
    collectReportErrors(escapedHelperPath, acceptedContext).some((error) => error.code === "ARTIFACT_PATH_UNSAFE"),
  );
  const noArtifactRootContext = { ...acceptedContext, artifactRoot: null };
  assert.ok(
    collectReportErrors(report, noArtifactRootContext).some((error) => error.code === "ARTIFACT_ROOT_REQUIRED"),
  );

  const mismatchMutations = [
    (helper) => { helper.actualPath = "resources/other/clipnest-helper.exe"; },
    (helper) => { helper.actualVersion = "1.0.1"; },
    (helper) => { helper.actualProtocol = "2"; },
    (helper) => { helper.actualSha256 = "b".repeat(64); },
    (helper) => { helper.actualSha256 = 123; },
    (helper) => { helper.identityMatched = false; },
  ];
  for (const mutate of mismatchMutations) {
    const forged = clone(report);
    mutate(forged.packageAndRollback.helperResource);
    assert.ok(
      collectReportErrors(forged, acceptedContext).some((error) => error.code === "PASS_HELPER_IDENTITY_REQUIRED"),
    );
  }

  for (const mutate of [
    (helper) => { helper.expectedVersion = helper.actualVersion = "9.9.9"; },
    (helper) => { helper.expectedProtocol = helper.actualProtocol = "9"; },
  ]) {
    const selfFilled = clone(report);
    mutate(selfFilled.packageAndRollback.helperResource);
    assert.ok(
      collectReportErrors(selfFilled, acceptedContext).some((error) => error.code === "PASS_HELPER_TRUSTED_IDENTITY_MISMATCH"),
      "matching expected and actual report fields cannot replace the caller-supplied trusted identity",
    );
  }

  const malformedHash = clone(report);
  malformedHash.packageAndRollback.helperResource.expectedSha256 = 7;
  malformedHash.packageAndRollback.helperResource.actualSha256 = 7;
  assert.ok(
    collectReportErrors(malformedHash, acceptedContext).some((error) => error.code === "PASS_HELPER_TRUSTED_IDENTITY_MISMATCH"),
    "malformed report hash values must fail closed without throwing",
  );

  const forgedHelperSha256 = artifact.write(
    "resources/native/clipnest-helper.exe",
    Buffer.from("self-consistent forged packaged helper bytes"),
  );
  const selfFilledHash = clone(report);
  selfFilledHash.packageAndRollback.helperResource.expectedSha256 = forgedHelperSha256;
  selfFilledHash.packageAndRollback.helperResource.actualSha256 = forgedHelperSha256;
  const selfFilledHashErrors = collectReportErrors(selfFilledHash, acceptedContext);
  assert.ok(selfFilledHashErrors.some((error) => error.code === "PASS_HELPER_TRUSTED_IDENTITY_MISMATCH"),
    "self-consistent helper report hash and artifact bytes must still match the independent manifest");
  assert.ok(!selfFilledHashErrors.some((error) => error.code === "ARTIFACT_SHA256_MISMATCH"),
    "synthetic helper artifact bytes and self-filled report hashes should agree for this negative case");
});

test("root PASS recomputes rollback version and hash identity", (t) => {
  const report = clone(example);
  report.status = "PASS";
  report.source.commit = "synthetic-source-commit";
  report.dependencyGate = { T03: "accepted", T04: "accepted" };
  const acceptedContext = clone(context);
  acceptedContext.progress.tasks.T03.status = "accepted";
  acceptedContext.progress.tasks.T04.status = "accepted";
  acceptedContext.progress.tasks.T05.status = "in_progress";

  const artifact = createArtifactFixture(t);
  const helperSha256 = artifact.write(
    "resources/native/clipnest-helper.exe",
    Buffer.from("synthetic packaged helper artifact bytes"),
  );
  const priorBytes = Buffer.from("synthetic rollback helper artifact bytes");
  const priorPath = "rollback/prior-helper.exe";
  const priorSha256 = artifact.write(priorPath, priorBytes);
  const rollbackSha256 = artifact.write("rollback/restored-helper.exe", priorBytes);
  acceptedContext.artifactRoot = artifact.root;

  Object.assign(report.packageAndRollback.helperResource, {
    result: "PASS",
    expectedPath: "resources/native/clipnest-helper.exe",
    actualPath: "resources/native/clipnest-helper.exe",
    expectedVersion: "1.0.0",
    actualVersion: "1.0.0",
    expectedProtocol: "1",
    actualProtocol: "1",
    expectedSha256: helperSha256,
    actualSha256: helperSha256,
    identityMatched: true,
    signatureStatus: "valid",
    evidence: ["tests/tasks/T05/fixture-plan.json"],
  });
  Object.assign(report.packageAndRollback.rollback, {
    result: "PASS",
    priorPath,
    priorVersion: "0.9.0",
    rollbackPath: "rollback/restored-helper.exe",
    rollbackVersion: "0.9.0",
    priorSha256,
    rollbackSha256,
    identityMatched: true,
    signatureStatus: "valid",
    helperBinaryOnly: { name: "helperBinaryOnly", result: "PASS", evidence: ["tests/tasks/T05/fixture-plan.json"] },
    evidence: ["tests/tasks/T05/fixture-plan.json"],
  });
  loadSyntheticIdentityContext(t, acceptedContext, artifact.root, syntheticIdentityManifest({
    sourceCommit: report.source.commit,
    helperSha256,
    helperVersion: "1.0.0",
    helperProtocol: "1",
    rollbackPath: priorPath,
    rollbackSha256: priorSha256,
    rollbackVersion: "0.9.0",
  }));
  assert.ok(
    !collectReportErrors(report, acceptedContext).some((error) => error.code === "PASS_ROLLBACK_IDENTITY_REQUIRED"),
  );
  assert.ok(
    !collectReportErrors(report, acceptedContext).some((error) => error.code === "PASS_ROLLBACK_ARTIFACT_ALIAS"),
  );
  assert.ok(
    !collectReportErrors(report, acceptedContext).some((error) => error.code === "PASS_ROLLBACK_TRUSTED_IDENTITY_MISMATCH"),
    "rollback prior identity and restored bytes must agree with the external manifest",
  );

  const currentHelperBytes = Buffer.from("synthetic packaged helper artifact bytes");
  const sameAsCurrentPriorPath = "rollback/current-helper-copy.exe";
  const sameAsCurrentRestoredPath = "rollback/restored-current-helper-copy.exe";
  const sameAsCurrentPriorSha256 = artifact.write(sameAsCurrentPriorPath, currentHelperBytes);
  const sameAsCurrentRestoredSha256 = artifact.write(sameAsCurrentRestoredPath, currentHelperBytes);
  assert.equal(sameAsCurrentPriorSha256, helperSha256);
  assert.equal(sameAsCurrentRestoredSha256, helperSha256);

  const sameAsCurrentReport = clone(report);
  Object.assign(sameAsCurrentReport.packageAndRollback.rollback, {
    priorPath: sameAsCurrentPriorPath,
    priorVersion: "1.0.0",
    rollbackPath: sameAsCurrentRestoredPath,
    rollbackVersion: "1.0.0",
    priorSha256: sameAsCurrentPriorSha256,
    rollbackSha256: sameAsCurrentRestoredSha256,
  });
  const sameAsCurrentManifestPath = createIdentityManifestFixture(t, syntheticIdentityManifest({
    sourceCommit: report.source.commit,
    helperSha256,
    helperVersion: "1.0.0",
    helperProtocol: "1",
    rollbackPath: sameAsCurrentPriorPath,
    rollbackSha256: sameAsCurrentPriorSha256,
    rollbackVersion: "1.0.0",
  }));
  const sameAsCurrentContext = clone(acceptedContext);
  Object.assign(sameAsCurrentContext, loadIdentityManifestFile(
    sameAsCurrentManifestPath,
    SAMPLE_REPORT,
    artifact.root,
  ));
  const sameAsCurrentErrors = collectReportErrors(sameAsCurrentReport, sameAsCurrentContext);
  assert.ok(
    sameAsCurrentErrors.some((error) => error.code === "PASS_ROLLBACK_PRIOR_IS_CURRENT_HELPER"),
    "different files and paths containing the current helper bytes cannot demonstrate a binary rollback",
  );
  assert.ok(
    !sameAsCurrentErrors.some((error) => error.code === "PASS_ROLLBACK_ARTIFACT_ALIAS"),
    "the rejection must be based on identical bytes, not a path or filesystem identity alias",
  );
  assert.ok(
    !sameAsCurrentErrors.some((error) => error.code === "PASS_ROLLBACK_TRUSTED_IDENTITY_MISMATCH" ||
      error.code === "PASS_ROLLBACK_IDENTITY_REQUIRED" || error.code === "ARTIFACT_SHA256_MISMATCH"),
    "the negative report, caller manifest, separate files, and artifact bytes must otherwise agree",
  );

  const sameVersionPriorPath = "rollback/same-version-different-bytes.exe";
  const sameVersionRestoredPath = "rollback/restored-same-version-different-bytes.exe";
  const sameVersionPriorSha256 = artifact.write(sameVersionPriorPath, Buffer.from("distinct prior helper bytes"));
  const sameVersionRestoredSha256 = artifact.write(sameVersionRestoredPath, Buffer.from("distinct prior helper bytes"));
  assert.notEqual(sameVersionPriorSha256, helperSha256);
  assert.equal(sameVersionRestoredSha256, sameVersionPriorSha256);
  const sameVersionReport = clone(report);
  Object.assign(sameVersionReport.packageAndRollback.rollback, {
    priorPath: sameVersionPriorPath,
    priorVersion: "1.0.0",
    rollbackPath: sameVersionRestoredPath,
    rollbackVersion: "1.0.0",
    priorSha256: sameVersionPriorSha256,
    rollbackSha256: sameVersionRestoredSha256,
  });
  const sameVersionManifestPath = createIdentityManifestFixture(t, syntheticIdentityManifest({
    sourceCommit: report.source.commit,
    helperSha256,
    helperVersion: "1.0.0",
    helperProtocol: "1",
    rollbackPath: sameVersionPriorPath,
    rollbackSha256: sameVersionPriorSha256,
    rollbackVersion: "1.0.0",
  }));
  const sameVersionContext = clone(acceptedContext);
  Object.assign(sameVersionContext, loadIdentityManifestFile(sameVersionManifestPath, SAMPLE_REPORT, artifact.root));
  const sameVersionErrors = collectReportErrors(sameVersionReport, sameVersionContext);
  assert.ok(
    !sameVersionErrors.some((error) => error.code === "PASS_ROLLBACK_PRIOR_IS_CURRENT_HELPER" ||
      error.code === "PASS_ROLLBACK_TRUSTED_IDENTITY_MISMATCH" || error.code === "PASS_ROLLBACK_IDENTITY_REQUIRED"),
    "a distinct prior binary with the same version string remains eligible for rollback identity checks",
  );

  const unsignedRollbackReport = clone(report);
  unsignedRollbackReport.packageAndRollback.rollback.signatureStatus = "unsigned";
  assert.ok(
    collectReportErrors(unsignedRollbackReport, acceptedContext)
      .some((error) => error.code === "PASS_UNSIGNED_SIGNATURE_POLICY_UNRESOLVED"),
  );
  const samePathReport = clone(report);
  samePathReport.packageAndRollback.rollback.rollbackPath =
    samePathReport.packageAndRollback.rollback.priorPath;
  assert.ok(
    collectReportErrors(samePathReport, acceptedContext).some((error) => error.code === "PASS_ROLLBACK_ARTIFACT_ALIAS"),
  );
  const hardLinkPath = "rollback/prior-hardlink-helper.exe";
  fs.linkSync(
    path.join(artifact.root, ...priorPath.split("/")),
    path.join(artifact.root, ...hardLinkPath.split("/")),
  );
  const hardLinkAliasReport = clone(report);
  hardLinkAliasReport.packageAndRollback.rollback.rollbackPath = hardLinkPath;
  assert.ok(
    collectReportErrors(hardLinkAliasReport, acceptedContext)
      .some((error) => error.code === "PASS_ROLLBACK_ARTIFACT_ALIAS"),
    "different paths to the same filesystem file must not satisfy rollback identity separation",
  );
  const escapedRollbackPath = clone(report);
  escapedRollbackPath.packageAndRollback.rollback.rollbackPath = "../outside/clipnest-helper.exe";
  assert.ok(
    collectReportErrors(escapedRollbackPath, acceptedContext).some((error) => error.code === "ARTIFACT_PATH_UNSAFE"),
  );

  const mismatchMutations = [
    (rollback) => { rollback.rollbackVersion = "1.0.1"; },
    (rollback) => { rollback.rollbackSha256 = "b".repeat(64); },
    (rollback) => { rollback.rollbackSha256 = 123; },
    (rollback) => { rollback.identityMatched = false; },
  ];
  for (const mutate of mismatchMutations) {
    const forged = clone(report);
    mutate(forged.packageAndRollback.rollback);
    assert.ok(
      collectReportErrors(forged, acceptedContext).some((error) => error.code === "PASS_ROLLBACK_IDENTITY_REQUIRED"),
    );
  }

  const forgedBytes = Buffer.from("self-consistent forged prior helper bytes");
  const forgedSha256 = artifact.write("rollback/forged-prior.exe", forgedBytes);
  artifact.write("rollback/forged-restored.exe", forgedBytes);
  const selfFilled = clone(report);
  Object.assign(selfFilled.packageAndRollback.rollback, {
    priorPath: "rollback/forged-prior.exe",
    rollbackPath: "rollback/forged-restored.exe",
    priorVersion: "9.9.9",
    rollbackVersion: "9.9.9",
    priorSha256: forgedSha256,
    rollbackSha256: forgedSha256,
  });
  assert.ok(
    collectReportErrors(selfFilled, acceptedContext).some((error) => error.code === "PASS_ROLLBACK_TRUSTED_IDENTITY_MISMATCH"),
    "self-consistent prior and restored report claims cannot replace the caller-supplied prior identity",
  );

  const malformedHash = clone(report);
  malformedHash.packageAndRollback.rollback.priorSha256 = 7;
  malformedHash.packageAndRollback.rollback.rollbackSha256 = 7;
  assert.ok(
    collectReportErrors(malformedHash, acceptedContext).some((error) => error.code === "PASS_ROLLBACK_TRUSTED_IDENTITY_MISMATCH"),
    "malformed report hash values must fail closed without throwing",
  );
});

test("root PASS rejects rollback paths that are internal symlink aliases", (t) => {
  const artifact = createArtifactFixture(t);
  const helperBytes = Buffer.from("synthetic prior helper bytes");
  const priorPath = "rollback/prior-helper.exe";
  const priorSha256 = artifact.write(priorPath, helperBytes);
  const aliasPath = path.join(artifact.root, "rollback-alias");
  try {
    fs.symlinkSync(path.join(artifact.root, "rollback"), aliasPath, "junction");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(error.code)) {
      t.skip(`directory symlink creation is unavailable (${error.code})`);
      return;
    }
    throw error;
  }

  const report = clone(example);
  report.status = "PASS";
  report.dependencyGate = { T03: "accepted", T04: "accepted" };
  Object.assign(report.packageAndRollback.rollback, {
    result: "PASS",
    priorPath,
    priorVersion: "1.0.0",
    priorSha256,
    rollbackPath: "rollback-alias/prior-helper.exe",
    rollbackVersion: "1.0.0",
    rollbackSha256: priorSha256,
    identityMatched: true,
    signatureStatus: "valid",
    helperBinaryOnly: { name: "helperBinaryOnly", result: "PASS", evidence: ["tests/tasks/T05/fixture-plan.json"] },
    evidence: ["tests/tasks/T05/fixture-plan.json"],
  });
  const acceptedContext = clone(context);
  acceptedContext.progress.tasks.T03.status = "accepted";
  acceptedContext.progress.tasks.T04.status = "accepted";
  acceptedContext.progress.tasks.T05.status = "in_progress";
  acceptedContext.artifactRoot = artifact.root;

  assert.ok(
    collectReportErrors(report, acceptedContext).some((error) => error.code === "PASS_ROLLBACK_ARTIFACT_ALIAS"),
  );
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

test("artifact verifier recomputes helper and rollback SHA-256 from files under the configured root", (t) => {
  const artifact = createArtifactFixture(t);
  const helperBytes = Buffer.from("synthetic helper bytes");
  const helperSha256 = artifact.write("resources/native/clipnest-helper.exe", helperBytes);
  const rollbackBytes = Buffer.from("synthetic rollback helper bytes");
  const rollbackSha256 = artifact.write("rollback/clipnest-helper.exe", rollbackBytes);

  assert.equal(
    validateArtifactFileSha256("resources/native/clipnest-helper.exe", helperSha256, artifact.root),
    null,
  );
  assert.equal(
    validateArtifactFileSha256("rollback/clipnest-helper.exe", rollbackSha256, artifact.root),
    null,
  );
  assert.equal(
    validateArtifactFileSha256("resources/native/clipnest-helper.exe", "0".repeat(64), artifact.root).code,
    "ARTIFACT_SHA256_MISMATCH",
  );
  assert.equal(
    validateArtifactFileSha256("resources/native/missing.exe", helperSha256, artifact.root).code,
    "ARTIFACT_FILE_NOT_FOUND",
  );
  assert.equal(
    validateArtifactFileSha256("../outside/clipnest-helper.exe", helperSha256, artifact.root).code,
    "ARTIFACT_PATH_UNSAFE",
  );
});

test("artifact verifier rejects a symlink that escapes the configured root", (t) => {
  const artifact = createArtifactFixture(t);
  const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clipnest-t05-outside-"));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  const externalFile = path.join(outsideRoot, "clipnest-helper.exe");
  const externalBytes = Buffer.from("synthetic external helper bytes");
  fs.writeFileSync(externalFile, externalBytes);

  try {
    fs.symlinkSync(outsideRoot, path.join(artifact.root, "external"), "junction");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "EINVAL"].includes(error.code)) {
      t.skip(`directory symlink creation is unavailable (${error.code})`);
      return;
    }
    throw error;
  }

  const expectedSha256 = crypto.createHash("sha256").update(externalBytes).digest("hex");
  assert.equal(
    validateArtifactFileSha256("external/clipnest-helper.exe", expectedSha256, artifact.root).code,
    "ARTIFACT_PATH_UNSAFE",
  );
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
