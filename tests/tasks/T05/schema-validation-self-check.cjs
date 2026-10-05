"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  collectReportErrors,
  loadVerifierContext,
  validateDraft202012Instance,
} = require("./verify-report.cjs");

const context = loadVerifierContext();
const examplePath = path.join(__dirname, "report.not-run.example.json");
const example = JSON.parse(fs.readFileSync(examplePath, "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

function reportWithSuccessfulSample(metricName, sampleOverrides) {
  const report = clone(example);
  report.status = "REVIEW";
  const metric = report.measurements[metricName];
  const sample = {
    requestId: `${metricName}-schema-self-check`,
    outcome: "success",
    result: "inputSubmitted",
    valueMs: 12,
    stageMs: {},
    ...sampleOverrides,
  };
  metric.status = "FAIL";
  metric.observationMode = "fake";
  metric.successfulSampleCount = 1;
  metric.failureCount = 0;
  metric.cancellationCount = 0;
  metric.timeoutCount = 0;
  metric.p50Ms = 12;
  metric.p95Ms = 12;
  metric.maxMs = 12;
  metric.samples = [sample];
  return report;
}

function reportWithSyntheticG0Pass() {
  const report = clone(example);
  report.status = "REVIEW";
  const evidence = ["PREPARATION_ONLY synthetic structure; not runtime evidence"];
  const spawnRequestId = "😀".repeat(128);
  report.g0Runtime.noInteractiveBlockingSpawnSync = {
    name: "noInteractiveBlockingSpawnSync",
    result: "PASS",
    details: "😀".repeat(2000),
    evidence,
    observation: {
      requestIds: [spawnRequestId],
      interactionSequenceByRequestId: {
        [spawnRequestId]: { startSequence: 10, endSequence: 20 },
      },
      callsByRequestId: { [spawnRequestId]: [] },
      instrumentedBlockingSpawnSyncCalls: 0,
    },
  };
  const helperRequestIds = ["synthetic-helper-request-1", "synthetic-helper-request-2"];
  const helperIdentity = { pid: 1200, creationIdentity: "😀".repeat(256) };
  report.g0Runtime.noHelperProcessPerInteraction = {
    name: "noHelperProcessPerInteraction",
    result: "PASS",
    evidence,
    observation: {
      requestIds: helperRequestIds,
      interactionSequenceByRequestId: {
        [helperRequestIds[0]]: { startSequence: 10, endSequence: 20 },
        [helperRequestIds[1]]: { startSequence: 30, endSequence: 40 },
      },
      observationsByRequestId: Object.fromEntries(helperRequestIds.map((requestId) => [requestId, {
        helperBefore: helperIdentity,
        helperAfter: helperIdentity,
        helperLaunchCount: 0,
      }])),
    },
  };
  return report;
}

function expectInvalidInstance(instance, label) {
  const result = validateDraft202012Instance(instance, context.reportSchema);
  assert.equal(result.kind, "invalid_instance", label);
  assert.ok(result.errors.length > 0, label);
  return result;
}

function expectInvalidManifest(manifest, label) {
  const result = validateDraft202012Instance(manifest, context.identityManifestSchema);
  assert.equal(result.kind, "invalid_instance", label);
  assert.ok(result.errors.length > 0, label);
  return result;
}

function syntheticIdentityManifest() {
  return {
    schemaVersion: 1,
    task: "T05",
    sourceCommit: "synthetic-source-commit",
    artifactRootKind: "windows_x64_unpacked_app_root",
    helper: {
      relativePath: "resources/native/clipnest-helper.exe",
      sha256: "a".repeat(64),
      version: "synthetic-helper-version",
      protocol: "synthetic-protocol",
    },
    rollbackPrior: {
      relativePath: "rollback/synthetic-prior-helper.exe",
      sha256: "b".repeat(64),
      version: "synthetic-prior-version",
    },
  };
}

function main() {
  const valid = validateDraft202012Instance(example, context.reportSchema);
  if (valid.kind === "unavailable") {
    console.error(`PREPARATION_ONLY: Draft 2020-12 validator unavailable: ${valid.reason}`);
    process.exitCode = 2;
    return;
  }
  assert.equal(valid.kind, "valid", "current NOT_RUN example must satisfy the complete schema");

  const identityManifest = syntheticIdentityManifest();
  const identityManifestValid = validateDraft202012Instance(identityManifest, context.identityManifestSchema);
  assert.equal(identityManifestValid.kind, "valid",
    `synthetic caller identity manifest must satisfy its schema: ${JSON.stringify(identityManifestValid.errors ?? [])}`);
  const wrongHelperPathManifest = clone(identityManifest);
  wrongHelperPathManifest.helper.relativePath = "resources/alternate/clipnest-helper.exe";
  expectInvalidManifest(wrongHelperPathManifest, "identity manifest must pin the fixed packaged helper path");
  const missingProtocolManifest = clone(identityManifest);
  delete missingProtocolManifest.helper.protocol;
  expectInvalidManifest(missingProtocolManifest, "identity manifest must include helper protocol");

  for (const status of ["FAIL", "REVIEW", "NOT_RUN"]) {
    const unsignedNonPass = clone(example);
    unsignedNonPass.status = status;
    unsignedNonPass.packageAndRollback.helperResource.signatureStatus = "unsigned";
    unsignedNonPass.packageAndRollback.rollback.signatureStatus = "unsigned";
    const unsignedValidation = validateDraft202012Instance(unsignedNonPass, context.reportSchema);
    assert.equal(unsignedValidation.kind, "valid",
      `${status} reports must be able to record unsigned helper signatures: ${JSON.stringify(unsignedValidation.errors ?? [])}`);
    const unsignedCodes = collectReportErrors(unsignedNonPass, context).map((error) => error.code);
    assert.equal(unsignedCodes.includes("PASS_UNSIGNED_SIGNATURE_POLICY_UNRESOLVED"), false,
      `${status} reports must not trigger the root PASS-only unsigned signature guard`);
  }

  const helperPass = clone(example);
  Object.assign(helperPass.packageAndRollback.helperResource, {
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
    evidence: ["synthetic schema fixture; not runtime evidence"],
  });
  assert.equal(validateDraft202012Instance(helperPass, context.reportSchema).kind, "valid",
    "schema must permit helper PASS to record signatureStatus=valid");
  helperPass.packageAndRollback.helperResource.signatureStatus = "unsigned";
  expectInvalidInstance(helperPass, "schema must reject helper PASS with unresolved unsigned signature policy");

  const rollbackPass = clone(example);
  Object.assign(rollbackPass.packageAndRollback.rollback, {
    result: "PASS",
    priorPath: "rollback/prior-helper.exe",
    priorVersion: "1.0.0",
    priorSha256: "a".repeat(64),
    rollbackPath: "rollback/restored-helper.exe",
    rollbackVersion: "1.0.0",
    rollbackSha256: "a".repeat(64),
    identityMatched: true,
    signatureStatus: "valid",
    helperBinaryOnly: {
      name: "helperBinaryOnly",
      result: "PASS",
      evidence: ["synthetic schema fixture; not runtime evidence"],
    },
    evidence: ["synthetic schema fixture; not runtime evidence"],
  });
  assert.equal(validateDraft202012Instance(rollbackPass, context.reportSchema).kind, "valid",
    "schema must permit rollback PASS to record signatureStatus=valid");
  rollbackPass.packageAndRollback.rollback.signatureStatus = "unsigned";
  expectInvalidInstance(rollbackPass, "schema must reject rollback PASS with unresolved unsigned signature policy");

  const syntheticG0Pass = reportWithSyntheticG0Pass();
  const syntheticG0Valid = validateDraft202012Instance(syntheticG0Pass, context.reportSchema);
  assert.equal(syntheticG0Valid.kind, "valid",
    `synthetic G0 observation structure at Unicode limits must satisfy Draft 2020-12: ${JSON.stringify(syntheticG0Valid.errors ?? [])}`);
  const syntheticNodeReport = clone(syntheticG0Pass);
  syntheticNodeReport.g0Runtime.noInteractiveBlockingSpawnSync.evidence = [];
  syntheticNodeReport.g0Runtime.noHelperProcessPerInteraction.evidence = [];
  const syntheticNodeCodes = collectReportErrors(syntheticNodeReport, context).map((error) => error.code);
  assert.equal(syntheticNodeCodes.filter((code) => code.startsWith("G0_")).length, 0);
  assert.equal(syntheticNodeCodes.filter((code) => code === "PASS_EVIDENCE_REQUIRED").length, 2,
    "default Node consistency validation must still block acceptance because synthetic G0 checks have empty evidence");

  const missingSpawnMap = clone(syntheticG0Pass);
  delete missingSpawnMap.g0Runtime.noInteractiveBlockingSpawnSync.observation.callsByRequestId;
  expectInvalidInstance(missingSpawnMap, "G0 PASS without per-request spawn trace map must fail the schema");

  const missingInteractionBounds = clone(syntheticG0Pass);
  delete missingInteractionBounds.g0Runtime.noHelperProcessPerInteraction.observation.interactionSequenceByRequestId;
  expectInvalidInstance(missingInteractionBounds, "G0 PASS without interaction sequence boundaries must fail the schema");

  const missingInteractionEnd = clone(syntheticG0Pass);
  const helperSequenceRequestId = missingInteractionEnd.g0Runtime.noHelperProcessPerInteraction.observation.requestIds[0];
  delete missingInteractionEnd.g0Runtime.noHelperProcessPerInteraction.observation.interactionSequenceByRequestId[helperSequenceRequestId].endSequence;
  expectInvalidInstance(missingInteractionEnd, "G0 PASS without an interaction end sequence must fail the schema");

  const negativeInteractionSequence = clone(syntheticG0Pass);
  const schemaSpawnRequestId = negativeInteractionSequence.g0Runtime.noInteractiveBlockingSpawnSync.observation.requestIds[0];
  negativeInteractionSequence.g0Runtime.noInteractiveBlockingSpawnSync.observation.interactionSequenceByRequestId[schemaSpawnRequestId].startSequence = -1;
  expectInvalidInstance(negativeInteractionSequence, "G0 PASS with a negative interaction sequence must fail the schema");

  const unsafeInteractionSequence = clone(syntheticG0Pass);
  const unsafeSpawnRequestId = unsafeInteractionSequence.g0Runtime.noInteractiveBlockingSpawnSync.observation.requestIds[0];
  unsafeInteractionSequence.g0Runtime.noInteractiveBlockingSpawnSync.observation.interactionSequenceByRequestId[unsafeSpawnRequestId].endSequence = Number.MAX_SAFE_INTEGER + 1;
  expectInvalidInstance(unsafeInteractionSequence, "G0 PASS with an unsafe interaction sequence must fail the schema");

  const nonemptySpawnTrace = clone(syntheticG0Pass);
  const spawnRequestId = nonemptySpawnTrace.g0Runtime.noInteractiveBlockingSpawnSync.observation.requestIds[0];
  nonemptySpawnTrace.g0Runtime.noInteractiveBlockingSpawnSync.observation.callsByRequestId[spawnRequestId] = ["spawnSync"];
  const nonemptyTraceValidation = expectInvalidInstance(nonemptySpawnTrace, "G0 PASS with a blocking spawn trace must fail the schema");
  const expectedUnicodeErrorPath = `$.g0Runtime.noInteractiveBlockingSpawnSync.observation.callsByRequestId.${spawnRequestId}`;
  assert.ok(nonemptyTraceValidation.errors.some((issue) => issue.path === expectedUnicodeErrorPath),
    "Draft bridge must preserve non-ASCII request IDs in invalid-instance paths");

  const extraHelperField = clone(syntheticG0Pass);
  extraHelperField.g0Runtime.noHelperProcessPerInteraction.observation.observationsByRequestId["synthetic-helper-request-1"].helperBefore.extra = true;
  expectInvalidInstance(extraHelperField, "G0 helper identity with an extra field must fail the schema");

  const overlongUnicodeRequestId = clone(syntheticG0Pass);
  const longUnicodeRequestId = "😀".repeat(129);
  overlongUnicodeRequestId.g0Runtime.noInteractiveBlockingSpawnSync.observation.requestIds = [longUnicodeRequestId];
  overlongUnicodeRequestId.g0Runtime.noInteractiveBlockingSpawnSync.observation.callsByRequestId = { [longUnicodeRequestId]: [] };
  expectInvalidInstance(overlongUnicodeRequestId, "129 astral code points must exceed the 128-code-point request ID limit");

  const overlongUnicodeCreationIdentity = clone(syntheticG0Pass);
  overlongUnicodeCreationIdentity.g0Runtime.noHelperProcessPerInteraction.observation.observationsByRequestId["synthetic-helper-request-1"].helperBefore.creationIdentity = "😀".repeat(257);
  expectInvalidInstance(overlongUnicodeCreationIdentity, "257 astral code points must exceed the 256-code-point helper identity limit");

  const overlongUnicodeDetails = clone(syntheticG0Pass);
  overlongUnicodeDetails.g0Runtime.noInteractiveBlockingSpawnSync.details = "😀".repeat(2001);
  expectInvalidInstance(overlongUnicodeDetails, "2001 astral code points must exceed the 2000-code-point G0 details limit");

  const missingRunId = clone(example);
  delete missingRunId.runId;
  expectInvalidInstance(missingRunId, "missing runId must fail the schema");

  const missingDirtyState = clone(example);
  delete missingDirtyState.source.workingTreeWasDirty;
  expectInvalidInstance(missingDirtyState, "missing workingTreeWasDirty must fail the schema");

  const normalWrongResult = reportWithSuccessfulSample("normalText", {
    result: "copiedOnly",
    stageMs: {
      selection: 1,
      write: 1,
      hide: 1,
      focus: 1,
      modifier: 1,
      inputSubmitted: 1,
    },
  });
  expectInvalidInstance(normalWrongResult, "normalText success must mean inputSubmitted");

  const normalMissingStage = reportWithSuccessfulSample("normalText", {
    result: "inputSubmitted",
    stageMs: { selection: 1, write: 1, hide: 1, focus: 1, modifier: 1 },
  });
  expectInvalidInstance(normalMissingStage, "normalText success must report every §04 stage");

  const normalMissingResultField = reportWithSuccessfulSample("normalText", {
    stageMs: {
      selection: 1,
      write: 1,
      hide: 1,
      focus: 1,
      modifier: 1,
      inputSubmitted: 1,
    },
  });
  delete normalMissingResultField.measurements.normalText.samples[0].result;
  expectInvalidInstance(normalMissingResultField, "every raw sample must include its result field");

  const normalMissingStageObject = reportWithSuccessfulSample("normalText", { result: "inputSubmitted" });
  delete normalMissingStageObject.measurements.normalText.samples[0].stageMs;
  expectInvalidInstance(normalMissingStageObject, "every raw sample must include its stageMs object");

  const wakeWrongResult = reportWithSuccessfulSample("wakeToActionable", {
    result: "shown",
    stageMs: { hotkey: 1, capture: 1, show: 1, firstFrame: 1, actionable: 1 },
  });
  expectInvalidInstance(wakeWrongResult, "wake success must mean list_actionable");

  const wakeMissingStage = reportWithSuccessfulSample("wakeToActionable", {
    result: "list_actionable",
    stageMs: { hotkey: 1, capture: 1, show: 1, firstFrame: 1 },
  });
  expectInvalidInstance(wakeMissingStage, "wake success must report every §04 stage");

  const brokenSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "not-a-json-schema-type",
  };
  const invalidSchema = validateDraft202012Instance(example, brokenSchema);
  assert.equal(invalidSchema.kind, "invalid_schema");
  const invalidSchemaErrors = collectReportErrors(
    example,
    { ...context, reportSchema: brokenSchema },
    { validateSchema: true },
  );
  assert.ok(invalidSchemaErrors.some((error) => error.code === "REPORT_SCHEMA_DEFINITION_INVALID"));
  assert.ok(!invalidSchemaErrors.some((error) => error.code === "REPORT_SCHEMA_VALIDATOR_UNAVAILABLE"));
  assert.ok(!invalidSchemaErrors.some((error) => error.code === "REPORT_SCHEMA_INSTANCE_INVALID"));

  const unavailableOptions = { validateSchema: true, pythonExecutables: ["clipnest-python-not-installed"] };
  const unavailable = validateDraft202012Instance(example, context.reportSchema, unavailableOptions);
  assert.equal(unavailable.kind, "unavailable");
  const unavailableErrors = collectReportErrors(example, context, unavailableOptions);
  assert.ok(unavailableErrors.some((error) => error.code === "REPORT_SCHEMA_VALIDATOR_UNAVAILABLE"));
  assert.ok(!unavailableErrors.some((error) => error.code === "REPORT_SCHEMA_INSTANCE_INVALID"));

  const invalidReportErrors = collectReportErrors(missingRunId, context, { validateSchema: true });
  assert.ok(invalidReportErrors.some((error) => error.code === "REPORT_SCHEMA_INSTANCE_INVALID"));

  console.log(JSON.stringify({
    result: "PREPARATION_ONLY",
    validator: valid.validator,
    validatorVersion: valid.validatorVersion,
    validNotRunReport: "PASS",
    schemaInvalidInstanceCases: 20,
    signaturePolicyCases: {
      nonPassUnsignedRecordable: ["FAIL", "REVIEW", "NOT_RUN"],
      helperPassUnsignedRejected: true,
      rollbackPassUnsignedRejected: true,
      authenticodeVerificationPerformed: false,
    },
    identityManifestCases: {
      positive: "PASS_SYNTHETIC_ONLY",
      negative: 2,
      callerTrustRequired: true,
      authenticodeVerificationPerformed: false,
    },
    syntheticG0DraftSchemaCases: {
      positive: "PASS_AT_UNICODE_CODE_POINT_LIMITS; SYNTHETIC_ONLY",
      negative: 10,
      nodeAcceptanceBlockedByEmptyEvidence: "PASS_EVIDENCE_REQUIRED",
    },
    metricContractInvalidCases: 6,
    invalidSchemaDefinition: "DISTINCT_FROM_INSTANCE_INVALID",
    missingValidator: "DISTINCT_UNAVAILABLE_ERROR",
    behaviorExecuted: false,
    benchmarkExecuted: false,
    packageBuilt: false,
    desktopClipboardOrInputUsed: false,
    t05AcceptanceImplied: false,
  }));
}

try {
  main();
} catch (error) {
  console.error(`PREPARATION_ONLY: schema instance self-check failed: ${error.message}`);
  process.exitCode = 1;
}
