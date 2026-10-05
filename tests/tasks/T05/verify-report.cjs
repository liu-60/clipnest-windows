"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  collectPreparationErrors,
  loadPreparationInputs,
} = require("./validate-preparation.cjs");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SAMPLE_REPORT = path.join(__dirname, "report.not-run.example.json");
const DEPENDENCY_TASKS = ["T03", "T04"];
const OUTCOMES = ["success", "failure", "cancelled", "timeout"];
const ROOT_STATUSES = ["PASS", "FAIL", "REVIEW", "NOT_RUN"];
const CHECK_STATUSES = ["PASS", "FAIL", "NOT_RUN", "BLOCKED"];
const PYTHON_EXECUTABLES = ["python", "python3"];
const MAX_SCHEMA_ERRORS = 100;
const METRIC_CONTRACTS = Object.freeze({
  normalText: {
    metricName: "normalText",
    successResult: "inputSubmitted",
    requiredStageMs: ["selection", "write", "hide", "focus", "modifier", "inputSubmitted"],
  },
  wakeToActionable: {
    metricName: "wakeToActionable",
    successResult: "list_actionable",
    requiredStageMs: ["hotkey", "capture", "show", "firstFrame", "actionable"],
  },
});

const PYTHON_DRAFT202012_VALIDATOR = String.raw`
import importlib.metadata
import json
import sys

def emit(payload):
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))

try:
    from jsonschema import Draft202012Validator
except Exception as exc:
    emit({"kind": "unavailable", "reason": "jsonschema import failed: " + type(exc).__name__})
    raise SystemExit(0)

try:
    payload = json.load(sys.stdin)
    schema = payload["schema"]
    instance = payload["instance"]
except Exception as exc:
    emit({"kind": "unavailable", "reason": "validator input failed: " + type(exc).__name__})
    raise SystemExit(0)

try:
    Draft202012Validator.check_schema(schema)
except Exception as exc:
    emit({"kind": "invalid_schema", "reason": "schema meta-validation failed: " + type(exc).__name__})
    raise SystemExit(0)

def display_path(parts):
    result = "$"
    for part in parts:
        result += "[" + str(part) + "]" if isinstance(part, int) else "." + str(part)
    return result

try:
    validator = Draft202012Validator(schema)
    errors = sorted(
        validator.iter_errors(instance),
        key=lambda error: (display_path(error.absolute_path), str(error.validator), str(error.absolute_schema_path)),
    )
    truncated = len(errors) > int(payload.get("maxErrors", 100))
    errors = errors[:int(payload.get("maxErrors", 100))]
    version = importlib.metadata.version("jsonschema")
    emit({
        "kind": "invalid_instance" if errors else "valid",
        "validator": "jsonschema.Draft202012Validator",
        "validatorVersion": version,
        "truncated": truncated,
        "errors": [
            {
                "path": display_path(error.absolute_path),
                "keyword": str(error.validator),
                "schemaPath": "#/" + "/".join(str(part).replace("~", "~0").replace("/", "~1") for part in error.absolute_schema_path),
            }
            for error in errors
        ],
    })
except Exception as exc:
    emit({"kind": "unavailable", "reason": "validator execution failed: " + type(exc).__name__})
`;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadVerifierContext(repoRoot = REPO_ROOT) {
  const prep = loadPreparationInputs();
  return {
    repoRoot: path.resolve(repoRoot),
    ...prep,
    progress: readJson(path.join(repoRoot, "docs", "progress.json")),
  };
}

// Kept byte-for-byte in behavior with scripts/benchmark/bench-desktop.cjs:
// sorted[Math.ceil(quantile * sorted.length) - 1], rounded to 3 decimals.
function nearestRankPercentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.ceil(quantile * sorted.length) - 1].toFixed(3));
}

function addError(errors, code, location, message) {
  errors.push({ code, location, message });
}

function validateDraft202012Instance(instance, schema, options = {}) {
  const pythonExecutables = options.pythonExecutables ?? PYTHON_EXECUTABLES;
  const maxErrors = options.maxErrors ?? MAX_SCHEMA_ERRORS;
  let input;
  try {
    input = JSON.stringify({ schema, instance, maxErrors });
  } catch {
    return {
      kind: "invalid_instance",
      validator: "jsonschema.Draft202012Validator",
      validatorVersion: null,
      truncated: false,
      errors: [{ path: "$", keyword: "serialization", schemaPath: "#" }],
    };
  }
  if (typeof input !== "string") {
    return {
      kind: "invalid_instance",
      validator: "jsonschema.Draft202012Validator",
      validatorVersion: null,
      truncated: false,
      errors: [{ path: "$", keyword: "serialization", schemaPath: "#" }],
    };
  }

  let unavailableReason = "no Python interpreter candidate was available";
  for (const executable of pythonExecutables) {
    const result = spawnSync(executable, ["-c", PYTHON_DRAFT202012_VALIDATOR], {
      input,
      encoding: "utf8",
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result.error?.code === "ENOENT") {
      unavailableReason = `${executable} was not found`;
      continue;
    }
    if (result.error) {
      unavailableReason = `${executable} failed to start or timed out (${result.error.code ?? result.error.name})`;
      continue;
    }
    if (result.status !== 0) {
      unavailableReason = `${executable} exited with code ${String(result.status)}`;
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      unavailableReason = `${executable} returned an unreadable validator response`;
      continue;
    }
    if (parsed?.kind === "unavailable") {
      unavailableReason = parsed.reason ?? `${executable} could not load the Draft 2020-12 validator`;
      continue;
    }
    if (!["valid", "invalid_instance", "invalid_schema"].includes(parsed?.kind)) {
      unavailableReason = `${executable} returned an unsupported validator response`;
      continue;
    }
    return parsed;
  }

  return {
    kind: "unavailable",
    reason: unavailableReason,
  };
}

function addSchemaValidationErrors(validation, errors) {
  if (validation.kind === "valid") return;
  if (validation.kind === "unavailable") {
    addError(
      errors,
      "REPORT_SCHEMA_VALIDATOR_UNAVAILABLE",
      "$",
      `Draft 2020-12 instance validation is unavailable: ${validation.reason}`,
    );
    return;
  }
  if (validation.kind === "invalid_schema") {
    addError(errors, "REPORT_SCHEMA_DEFINITION_INVALID", "$.schema", validation.reason);
    return;
  }

  for (const issue of validation.errors ?? []) {
    addError(
      errors,
      "REPORT_SCHEMA_INSTANCE_INVALID",
      issue.path ?? "$",
      `Draft 2020-12 schema rule ${issue.keyword ?? "unknown"} failed at ${issue.schemaPath ?? "#"}`,
    );
  }
  if (validation.truncated) {
    addError(
      errors,
      "REPORT_SCHEMA_INSTANCE_ERRORS_TRUNCATED",
      "$",
      `More than ${MAX_SCHEMA_ERRORS} Draft 2020-12 instance errors were found; only the first ${MAX_SCHEMA_ERRORS} are listed`,
    );
  }
}

function isWithinDirectory(parent, target) {
  const relative = path.relative(parent, target);
  return relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function validateEvidenceReference(reference, repoRoot) {
  if (typeof reference !== "string" || reference.trim() === "" || reference.includes("\0")) {
    return { code: "EVIDENCE_PATH_INVALID", message: "evidence reference must be a nonempty local path" };
  }
  if (path.isAbsolute(reference) || path.win32.isAbsolute(reference) ||
      path.win32.parse(reference).root !== "" || /^[a-z][a-z0-9+.-]*:\/\//i.test(reference)) {
    return { code: "EVIDENCE_PATH_OUTSIDE_REPO", message: "absolute paths and URLs are not repository-local evidence references" };
  }
  const segments = reference.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    return { code: "EVIDENCE_PATH_OUTSIDE_REPO", message: "evidence reference must not traverse outside the repository" };
  }

  const candidate = path.resolve(repoRoot, reference);
  if (!isWithinDirectory(repoRoot, candidate)) {
    return { code: "EVIDENCE_PATH_OUTSIDE_REPO", message: "evidence reference resolves outside the repository" };
  }
  let realPath;
  try {
    realPath = fs.realpathSync.native(candidate);
  } catch {
    return { code: "EVIDENCE_NOT_FOUND", message: "evidence file does not exist in the repository" };
  }
  if (!isWithinDirectory(repoRoot, realPath)) {
    return { code: "EVIDENCE_PATH_OUTSIDE_REPO", message: "evidence symlink resolves outside the repository" };
  }
  try {
    if (!fs.statSync(realPath).isFile()) {
      return { code: "EVIDENCE_NOT_FILE", message: "evidence reference must resolve to a file" };
    }
  } catch {
    return { code: "EVIDENCE_NOT_FOUND", message: "evidence file does not exist in the repository" };
  }
  return null;
}

function collectEvidenceErrors(report, repoRoot) {
  const errors = [];
  const checkEvidence = (value, location) => {
    if (!Array.isArray(value) || value.length === 0) {
      addError(errors, "PASS_EVIDENCE_REQUIRED", location, "a PASS result requires at least one evidence reference");
      return;
    }
    value.forEach((reference, index) => {
      const invalid = validateEvidenceReference(reference, repoRoot);
      if (invalid) addError(errors, invalid.code, `${location}[${index}]`, invalid.message);
    });
  };

  function visit(value, location, isRoot = false) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    if (!isRecord(value)) return;

    // Raw measurement sample rows have a result field, but are not acceptance checks.
    const isSample = Object.hasOwn(value, "requestId") && Object.hasOwn(value, "outcome");
    const claimsPass = value.result === "PASS" || value.status === "PASS";
    if (!isRoot && !isSample && claimsPass) checkEvidence(value.evidence, `${location}.evidence`);

    for (const [key, child] of Object.entries(value)) {
      if (key === "samples" && Array.isArray(child)) continue;
      visit(child, `${location}.${key}`);
    }
  }

  visit(report, "$", true);
  return errors;
}

function validateMeasurement(measurement, location = "measurement", errors = [], metricContract = null) {
  if (!isRecord(measurement)) {
    addError(errors, "MEASUREMENT_SHAPE", location, "measurement must be an object");
    return errors;
  }
  if (!["PASS", "FAIL", "NOT_RUN", "BLOCKED"].includes(measurement.status)) {
    addError(errors, "MEASUREMENT_STATUS", `${location}.status`, "measurement status is unsupported");
  }
  if (!Number.isInteger(measurement.targetSampleCount) || measurement.targetSampleCount < 100) {
    addError(errors, "MEASUREMENT_TARGET", `${location}.targetSampleCount`, "targetSampleCount must be an integer of at least 100");
  }
  if (!Array.isArray(measurement.samples)) {
    addError(errors, "MEASUREMENT_SAMPLES", `${location}.samples`, "samples must be an array");
    return errors;
  }

  const seenRequestIds = new Set();
  const actualCounts = { success: 0, failure: 0, cancelled: 0, timeout: 0 };
  const successfulValues = [];
  for (const [index, sample] of measurement.samples.entries()) {
    const sampleLocation = `${location}.samples[${index}]`;
    if (!isRecord(sample)) {
      addError(errors, "MEASUREMENT_SAMPLE_SHAPE", sampleLocation, "sample must be an object");
      continue;
    }
    if (typeof sample.requestId !== "string" || sample.requestId.trim() === "") {
      addError(errors, "SAMPLE_REQUEST_ID", `${sampleLocation}.requestId`, "sample requires a nonempty requestId");
    } else if (seenRequestIds.has(sample.requestId)) {
      addError(errors, "SAMPLE_REQUEST_ID_DUPLICATE", `${sampleLocation}.requestId`, `duplicate requestId ${sample.requestId}`);
    } else {
      seenRequestIds.add(sample.requestId);
    }
    if (!OUTCOMES.includes(sample.outcome)) {
      addError(errors, "SAMPLE_OUTCOME", `${sampleLocation}.outcome`, "sample outcome must be success, failure, cancelled, or timeout");
    } else {
      actualCounts[sample.outcome] += 1;
    }
    if (sample.outcome === "success" && metricContract) {
      if (sample.result !== metricContract.successResult) {
        addError(
          errors,
          "SAMPLE_SUCCESS_RESULT_MISMATCH",
          `${sampleLocation}.result`,
          `successful ${metricContract.metricName} samples must report ${metricContract.successResult}`,
        );
      }
      const stageMs = isRecord(sample.stageMs) ? sample.stageMs : {};
      const missingStages = metricContract.requiredStageMs.filter((stage) => !Object.hasOwn(stageMs, stage));
      if (missingStages.length > 0) {
        addError(
          errors,
          "SAMPLE_STAGE_TIMING_MISSING",
          `${sampleLocation}.stageMs`,
          `successful ${metricContract.metricName} samples require stage timings: ${missingStages.join(", ")}`,
        );
      }
      for (const stage of metricContract.requiredStageMs) {
        if (Object.hasOwn(stageMs, stage) &&
            (typeof stageMs[stage] !== "number" || !Number.isFinite(stageMs[stage]) || stageMs[stage] < 0)) {
          addError(
            errors,
            "SAMPLE_STAGE_TIMING_INVALID",
            `${sampleLocation}.stageMs.${stage}`,
            "required stage timing must be a finite nonnegative number",
          );
        }
      }
    }
    if (typeof sample.valueMs !== "number" || !Number.isFinite(sample.valueMs) || sample.valueMs < 0) {
      addError(errors, "SAMPLE_VALUE", `${sampleLocation}.valueMs`, "sample valueMs must be a finite nonnegative number");
    } else if (sample.outcome === "success") {
      successfulValues.push(sample.valueMs);
    }
  }

  const expectedFields = {
    successfulSampleCount: actualCounts.success,
    failureCount: actualCounts.failure,
    cancellationCount: actualCounts.cancelled,
    timeoutCount: actualCounts.timeout,
  };
  for (const [field, actual] of Object.entries(expectedFields)) {
    if (measurement[field] !== actual) {
      addError(errors, "MEASUREMENT_COUNT_MISMATCH", `${location}.${field}`, `expected ${actual} from samples; found ${measurement[field]}`);
    }
  }

  const expectedStats = {
    p50Ms: nearestRankPercentile(successfulValues, 0.5),
    p95Ms: nearestRankPercentile(successfulValues, 0.95),
    maxMs: nearestRankPercentile(successfulValues, 1),
  };
  for (const [field, expected] of Object.entries(expectedStats)) {
    if (measurement[field] !== expected) {
      addError(errors, "MEASUREMENT_STAT_MISMATCH", `${location}.${field}`, `expected ${String(expected)} from successful sample valueMs; found ${String(measurement[field])}`);
    }
  }

  if (measurement.status === "NOT_RUN") {
    if (measurement.observationMode !== "not_run" || measurement.samples.length !== 0 ||
        Object.values(expectedFields).some((count) => count !== 0) ||
        !Array.isArray(measurement.evidence) || measurement.evidence.length !== 0) {
      addError(errors, "NOT_RUN_MEASUREMENT_HAS_DATA", location, "NOT_RUN measurement must have no samples, counts, or evidence and must use observationMode=not_run");
    }
  }
  if (measurement.status === "PASS") {
    if (measurement.observationMode !== "controlled_live") {
      addError(errors, "PASS_METRIC_NOT_CONTROLLED_LIVE", `${location}.observationMode`, "PASS metrics require controlled_live observations");
    }
    if (actualCounts.success < 100) {
      addError(errors, "PASS_METRIC_SAMPLE_COUNT", location, "PASS metrics require at least 100 successful samples");
    }
    if (!Array.isArray(measurement.evidence) || measurement.evidence.length === 0) {
      addError(errors, "PASS_EVIDENCE_REQUIRED", `${location}.evidence`, "PASS metric requires evidence");
    }
  }
  return errors;
}

function collectReportErrors(report, context = loadVerifierContext(), validationOptions = {}) {
  const errors = [];
  if (!isRecord(report)) {
    addError(errors, "REPORT_SHAPE", "$", "report must be a JSON object");
    return errors;
  }

  for (const error of collectPreparationErrors(context)) {
    addError(errors, `PREPARATION_${error.code}`, "preparation", error.message);
  }
  if (validationOptions.validateSchema === true) {
    addSchemaValidationErrors(
      validateDraft202012Instance(report, context.reportSchema, validationOptions),
      errors,
    );
  }
  if (report.schemaVersion !== 1 || report.task !== "T05") {
    addError(errors, "REPORT_IDENTITY", "$", "report must have schemaVersion=1 and task=T05");
  }
  if (!ROOT_STATUSES.includes(report.status)) {
    addError(errors, "REPORT_STATUS", "$.status", "report status is unsupported");
  }

  const taskStatuses = context.progress?.tasks;
  for (const taskId of DEPENDENCY_TASKS) {
    const actual = taskStatuses?.[taskId]?.status;
    if (typeof actual !== "string") {
      addError(errors, "PROGRESS_STATUS_MISSING", `progress.tasks.${taskId}.status`, "current progress must contain the dependency status");
    } else if (report.dependencyGate?.[taskId] !== actual) {
      addError(errors, "DEPENDENCY_MISMATCH", `$.dependencyGate.${taskId}`, `report says ${String(report.dependencyGate?.[taskId])}; docs/progress.json says ${actual}`);
    }
  }

  const caseRecords = Array.isArray(report.cases) ? report.cases : [];
  const expectedCaseIds = context.fixturePlan.cases.map((fixtureCase) => fixtureCase.id);
  const actualCaseIds = caseRecords.map((item) => isRecord(item) ? item.id : undefined);
  if (actualCaseIds.length !== expectedCaseIds.length ||
      actualCaseIds.some((caseId, index) => caseId !== expectedCaseIds[index])) {
    addError(errors, "CASE_IDS_MISMATCH", "$.cases", "report must contain P01-P28 exactly once in fixture order");
  }

  const mappedByCase = new Map();
  for (const assertion of context.assertionMap.assertions) {
    const records = mappedByCase.get(assertion.caseId) ?? [];
    records.push(assertion);
    mappedByCase.set(assertion.caseId, records);
  }
  for (const [index, caseResult] of caseRecords.entries()) {
    if (!isRecord(caseResult)) continue;
    const caseId = expectedCaseIds[index] ?? String(caseResult.id);
    const expectedNames = (mappedByCase.get(caseId) ?? []).map((assertion) => assertion.assertionId);
    const assertionResults = Array.isArray(caseResult.assertions) ? caseResult.assertions : [];
    const actualNames = assertionResults.map((assertion) => isRecord(assertion) ? assertion.name : undefined);
    if (actualNames.length !== expectedNames.length ||
        actualNames.some((name, assertionIndex) => name !== expectedNames[assertionIndex])) {
      addError(errors, "ASSERTION_NAMES_MISMATCH", `$.cases[${index}].assertions`, `${caseId} must list every mapped assertion ID exactly once and in order`);
    }
    for (const [assertionIndex, assertion] of assertionResults.entries()) {
      if (!isRecord(assertion) || !CHECK_STATUSES.includes(assertion.result)) {
        addError(errors, "ASSERTION_RESULT", `$.cases[${index}].assertions[${assertionIndex}]`, "assertion requires a supported result");
      }
    }
  }

  for (const [name, measurement] of Object.entries(report.measurements ?? {})) {
    validateMeasurement(measurement, `$.measurements.${name}`, errors, METRIC_CONTRACTS[name] ?? null);
  }
  const requestIdsByMetric = new Map();
  for (const [metricName, measurement] of Object.entries(report.measurements ?? {})) {
    if (!Array.isArray(measurement?.samples)) continue;
    for (const [sampleIndex, sample] of measurement.samples.entries()) {
      if (typeof sample?.requestId !== "string" || sample.requestId.trim() === "") continue;
      const previousMetric = requestIdsByMetric.get(sample.requestId);
      if (previousMetric && previousMetric !== metricName) {
        addError(errors, "SAMPLE_REQUEST_ID_DUPLICATE_REPORT", `$.measurements.${metricName}.samples[${sampleIndex}].requestId`, `requestId ${sample.requestId} is already used by ${previousMetric}`);
      } else {
        requestIdsByMetric.set(sample.requestId, metricName);
      }
    }
  }
  for (const requiredMetric of ["normalText", "wakeToActionable"]) {
    if (!isRecord(report.measurements) || !Object.hasOwn(report.measurements, requiredMetric)) {
      addError(errors, "MEASUREMENT_MISSING", `$.measurements.${requiredMetric}`, "required T05 measurement is missing");
    }
  }

  if (report.status === "NOT_RUN") {
    const nonRootStatuses = [];
    function gather(value, location, isRoot = false) {
      if (Array.isArray(value)) {
        value.forEach((item, index) => gather(item, `${location}[${index}]`));
      } else if (isRecord(value)) {
        const isSample = Object.hasOwn(value, "requestId") && Object.hasOwn(value, "outcome");
        if (!isRoot && !isSample) {
          for (const field of ["result", "status"]) {
            if (CHECK_STATUSES.includes(value[field])) nonRootStatuses.push({ location, status: value[field] });
          }
        }
        for (const [key, child] of Object.entries(value)) {
          if (key !== "samples") gather(child, `${location}.${key}`);
        }
      }
    }
    gather(report, "$", true);
    const executed = nonRootStatuses.find((entry) => entry.status !== "NOT_RUN");
    if (executed) {
      addError(errors, "NOT_RUN_REPORT_HAS_EXECUTION_RESULT", executed.location, `NOT_RUN report contains ${executed.status}`);
    }
    if (!Array.isArray(report.notRun) || report.notRun.length === 0) {
      addError(errors, "NOT_RUN_REASON_REQUIRED", "$.notRun", "NOT_RUN report must list what has not been run");
    }
  }

  const passedStatus = ROOT_STATUSES.includes(report.status) && report.status === "PASS";
  const dependencyAccepted = DEPENDENCY_TASKS.every((taskId) => taskStatuses?.[taskId]?.status === "accepted");
  const nestedPass = collectPassNodes(report).length > 0;
  if ((passedStatus || nestedPass) && !dependencyAccepted) {
    addError(errors, "PASS_BLOCKED_UNACCEPTED_DEPENDENCY", "$.dependencyGate", "T05 behavior/package PASS claims are prohibited until both T03 and T04 are accepted in docs/progress.json");
  }
  if (nestedPass) {
    errors.push(...collectEvidenceErrors(report, context.repoRoot));
  }

  if (report.status === "PASS") validateRootPassRequirements(report, context, errors);
  return deduplicateErrors(errors);
}

function collectPassNodes(report) {
  const matches = [];
  function visit(value, location, isRoot = false) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    if (!isRecord(value)) return;
    const isSample = Object.hasOwn(value, "requestId") && Object.hasOwn(value, "outcome");
    if (!isRoot && !isSample && (value.result === "PASS" || value.status === "PASS")) {
      matches.push({ value, location });
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "samples" && Array.isArray(child)) continue;
      visit(child, `${location}.${key}`);
    }
  }
  visit(report, "$", true);
  return matches;
}

function requirePass(value, location, errors) {
  if (!isRecord(value) || value.result !== "PASS") {
    addError(errors, "PASS_REQUIREMENT_MISSING", location, "top-level PASS requires this check to be PASS");
  }
}

function validateRootPassRequirements(report, context, errors) {
  if (!isRecord(report.source) || typeof report.source.commit !== "string" || report.source.commit.trim() === "" ||
      typeof report.source.branch !== "string" || report.source.branch.trim() === "") {
    addError(errors, "PASS_SOURCE_REQUIRED", "$.source", "PASS requires a nonempty source commit and branch");
  }
  const environment = report.environment;
  const hasEnvironmentDetails = [
    environment?.osVersion,
    environment?.datasetSeed,
    environment?.displayConfiguration,
    environment?.powerMode,
    environment?.networkCondition,
  ].every((value) => typeof value === "string" && value.trim() !== "");
  if (!isRecord(environment) || environment.platform !== "Windows" ||
      environment.architecture !== "x64" ||
      !["debug", "release", "packaged"].includes(environment.buildMode) ||
      environment.dataProfile !== "isolated_synthetic" ||
      !["cold", "warm", "mixed", "not_applicable"].includes(environment.cacheState) ||
      !hasEnvironmentDetails || environment.datasetSeed.length > 128) {
    addError(errors, "PASS_ENVIRONMENT_REQUIRED", "$.environment", "PASS requires a recorded Windows x64 environment");
  }
  if (!context.progress?.tasks?.T05 || context.progress.tasks.T05.status === "not_started") {
    addError(errors, "PASS_T05_NOT_STARTED", "progress.tasks.T05.status", "a T05 PASS report cannot be reviewed while progress still says not_started");
  }

  const expectedCaseIds = context.fixturePlan.cases.map((fixtureCase) => fixtureCase.id);
  const passCases = Array.isArray(report.cases) ? report.cases : [];
  for (const [index, caseResult] of passCases.entries()) {
    if (caseResult?.id !== expectedCaseIds[index] || caseResult?.result !== "PASS") {
      addError(errors, "PASS_CASE_REQUIRED", `$.cases[${index}]`, "top-level PASS requires every P01-P28 case to PASS");
    }
    for (const [assertionIndex, assertion] of (Array.isArray(caseResult?.assertions) ? caseResult.assertions : []).entries()) {
      if (assertion?.result !== "PASS") {
        addError(errors, "PASS_ASSERTION_REQUIRED", `$.cases[${index}].assertions[${assertionIndex}]`, "top-level PASS requires every mapped assertion to PASS");
      }
    }
  }

  const g0 = report.g0Runtime;
  requirePass(g0?.noInteractiveBlockingSpawnSync, "$.g0Runtime.noInteractiveBlockingSpawnSync", errors);
  requirePass(g0?.noHelperProcessPerInteraction, "$.g0Runtime.noHelperProcessPerInteraction", errors);

  for (const metricName of ["normalText", "wakeToActionable"]) {
    const metric = report.measurements?.[metricName];
    if (metric?.status !== "PASS") {
      addError(errors, "PASS_METRIC_REQUIRED", `$.measurements.${metricName}`, "top-level PASS requires both controlled-live metrics to PASS");
    }
  }
  if (report.measurements?.normalText?.p95Ms >= 150) {
    addError(errors, "NORMAL_TEXT_TARGET_MISSED", "$.measurements.normalText.p95Ms", "normalText PASS requires p95 below 150ms");
  }
  if (report.measurements?.normalText?.textAppearanceIndependentlyVerified !== true) {
    addError(errors, "NORMAL_TEXT_APPEARANCE_UNVERIFIED", "$.measurements.normalText.textAppearanceIndependentlyVerified", "normalText PASS requires independent text-appearance verification");
  }
  if (report.measurements?.wakeToActionable?.p95Ms >= 100) {
    addError(errors, "WAKE_TARGET_MISSED", "$.measurements.wakeToActionable.p95Ms", "wakeToActionable PASS requires p95 below 100ms");
  }

  const packageChecks = report.packageAndRollback;
  requirePass(packageChecks?.localPackage, "$.packageAndRollback.localPackage", errors);
  requirePass(packageChecks?.lifecycle?.coldStart, "$.packageAndRollback.lifecycle.coldStart", errors);
  requirePass(packageChecks?.lifecycle?.trayAvailability, "$.packageAndRollback.lifecycle.trayAvailability", errors);
  requirePass(packageChecks?.lifecycle?.appRestart, "$.packageAndRollback.lifecycle.appRestart", errors);
  requirePass(packageChecks?.lifecycle?.normalExit, "$.packageAndRollback.lifecycle.normalExit", errors);
  requirePass(packageChecks?.lifecycle?.helperShutdown, "$.packageAndRollback.lifecycle.helperShutdown", errors);
  requirePass(packageChecks?.dataCompatibility?.oldJsonReadable, "$.packageAndRollback.dataCompatibility.oldJsonReadable", errors);
  requirePass(packageChecks?.dataCompatibility?.appDataPreserved, "$.packageAndRollback.dataCompatibility.appDataPreserved", errors);
  requirePass(packageChecks?.autoPaste?.disabled, "$.packageAndRollback.autoPaste.disabled", errors);
  requirePass(packageChecks?.autoPaste?.copyAvailable, "$.packageAndRollback.autoPaste.copyAvailable", errors);

  const helper = packageChecks?.helperResource;
  if (!isRecord(helper) || helper.result !== "PASS" || helper.identityMatched !== true ||
      !["expectedPath", "actualPath", "expectedVersion", "actualVersion", "expectedProtocol", "actualProtocol"]
        .every((field) => typeof helper[field] === "string" && helper[field].trim() !== "") ||
      helper.expectedPath !== helper.actualPath || helper.expectedVersion !== helper.actualVersion ||
      helper.expectedProtocol !== helper.actualProtocol ||
      typeof helper.expectedSha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(helper.expectedSha256) ||
      typeof helper.actualSha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(helper.actualSha256) ||
      helper.expectedSha256.toLowerCase() !== helper.actualSha256.toLowerCase()) {
    addError(errors, "PASS_HELPER_IDENTITY_REQUIRED", "$.packageAndRollback.helperResource", "top-level PASS requires matching packaged helper path, version, protocol, and SHA-256");
  }
  if (helper && !["valid", "unsigned"].includes(helper.signatureStatus)) {
    addError(errors, "PASS_HELPER_SIGNATURE_STATUS", "$.packageAndRollback.helperResource.signatureStatus", "helper signature must be explicitly recorded as valid or unsigned");
  }

  const rollback = packageChecks?.rollback;
  if (!isRecord(rollback) || rollback.result !== "PASS" || rollback.identityMatched !== true ||
      typeof rollback.priorVersion !== "string" || rollback.priorVersion.trim() === "" ||
      typeof rollback.rollbackVersion !== "string" || rollback.rollbackVersion.trim() === "" ||
      rollback.priorVersion !== rollback.rollbackVersion ||
      typeof rollback.priorSha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(rollback.priorSha256) ||
      typeof rollback.rollbackSha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(rollback.rollbackSha256) ||
      rollback.priorSha256.toLowerCase() !== rollback.rollbackSha256.toLowerCase()) {
    addError(errors, "PASS_ROLLBACK_IDENTITY_REQUIRED", "$.packageAndRollback.rollback", "top-level PASS requires rollback identity to match the recorded prior helper");
  }
  if (!isRecord(rollback) || !["valid", "unsigned"].includes(rollback.signatureStatus)) {
    addError(errors, "PASS_ROLLBACK_SIGNATURE_STATUS", "$.packageAndRollback.rollback.signatureStatus", "rollback helper signature must be explicitly recorded as valid or unsigned");
  }
  requirePass(rollback?.helperBinaryOnly, "$.packageAndRollback.rollback.helperBinaryOnly", errors);

  if (!Array.isArray(packageChecks?.evidence) || packageChecks.evidence.length === 0) {
    addError(errors, "PASS_PACKAGE_EVIDENCE_REQUIRED", "$.packageAndRollback.evidence", "top-level PASS requires package and rollback evidence");
  } else {
    for (const [index, reference] of packageChecks.evidence.entries()) {
      const invalid = validateEvidenceReference(reference, context.repoRoot);
      if (invalid) addError(errors, invalid.code, `$.packageAndRollback.evidence[${index}]`, invalid.message);
    }
  }
  if (!Array.isArray(report.notRun) || report.notRun.length !== 0) {
    addError(errors, "PASS_HAS_NOT_RUN_ITEMS", "$.notRun", "top-level PASS requires an empty notRun list");
  }
  if (packageChecks?.publication !== "NOT_PUBLISHED") {
    addError(errors, "PASS_PUBLICATION_STATE", "$.packageAndRollback.publication", "T05 report must remain local and not published");
  }
}

function deduplicateErrors(errors) {
  const seen = new Set();
  return errors.filter((error) => {
    const key = `${error.code}\n${error.location}\n${error.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function main() {
  const context = loadVerifierContext();
  const args = process.argv.slice(2);
  const schemaValidationRequested = args.includes("--validate-schema");
  const reportArgument = args.find((argument) => argument !== "--validate-schema");
  const reportPath = reportArgument
    ? path.resolve(REPO_ROOT, reportArgument)
    : SAMPLE_REPORT;
  let report;
  try {
    report = readJson(reportPath);
  } catch (error) {
    console.error(`PREPARATION_ONLY: cannot read report ${path.relative(REPO_ROOT, reportPath)}: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const errors = collectReportErrors(report, context, { validateSchema: schemaValidationRequested });
  if (errors.length > 0) {
    console.error(`PREPARATION_ONLY: T05 report consistency check failed (${errors.length} issue(s)); no acceptance decision was made:`);
    for (const error of errors) console.error(`- [${error.code}] ${error.location}: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const schemaNote = schemaValidationRequested
    ? "Draft 2020-12 instance validation passed"
    : "Draft 2020-12 instance validation was not requested";
  console.log(`PREPARATION_ONLY: report consistency checks passed; ${schemaNote} (${report.cases.length} cases, ${context.assertionMap.assertions.length} assertion names, T03=${report.dependencyGate.T03}, T04=${report.dependencyGate.T04}, status=${report.status}); behavior acceptance is not implied.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`PREPARATION_ONLY: T05 report verifier could not complete: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  REPO_ROOT,
  SAMPLE_REPORT,
  collectEvidenceErrors,
  collectReportErrors,
  loadVerifierContext,
  nearestRankPercentile,
  validateEvidenceReference,
  validateDraft202012Instance,
  validateMeasurement,
};
