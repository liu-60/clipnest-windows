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

function expectInvalidInstance(instance, label) {
  const result = validateDraft202012Instance(instance, context.reportSchema);
  assert.equal(result.kind, "invalid_instance", label);
  assert.ok(result.errors.length > 0, label);
  return result;
}

function main() {
  const valid = validateDraft202012Instance(example, context.reportSchema);
  if (valid.kind === "unavailable") {
    console.error(`PREPARATION_ONLY: Draft 2020-12 validator unavailable: ${valid.reason}`);
    process.exitCode = 2;
    return;
  }
  assert.equal(valid.kind, "valid", "current NOT_RUN example must satisfy the complete schema");

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
    schemaInvalidInstanceCases: 8,
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
