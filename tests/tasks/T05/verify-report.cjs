"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

const {
  EXPECTED_HELPER_RESOURCE_RELATIVE_PATH,
  PASS_SIGNATURE_STATUS,
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
    print(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))

try:
    from jsonschema import Draft202012Validator
except Exception as exc:
    emit({"kind": "unavailable", "reason": "jsonschema import failed: " + type(exc).__name__})
    raise SystemExit(0)

try:
    # Node serializes UTF-8; Windows Python may default stdin to a legacy code page.
    payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
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

function loadVerifierContext(repoRoot = REPO_ROOT, options = {}) {
  const prep = loadPreparationInputs();
  return {
    repoRoot: path.resolve(repoRoot),
    artifactRoot: options.artifactRoot ? path.resolve(options.artifactRoot) : null,
    identityManifest: options.identityManifest ?? null,
    identityManifestPath: options.identityManifestPath ?? null,
    identityManifestSha256: options.identityManifestSha256 ?? null,
    identityManifestPathIndependent: options.identityManifestPathIndependent === true,
    identityManifestError: options.identityManifestError ?? null,
    ...prep,
    progress: readJson(path.join(repoRoot, "docs", "progress.json")),
  };
}

function loadIdentityManifestFile(manifestArgument, reportPath, artifactRoot, repoRoot = REPO_ROOT) {
  if (manifestArgument === null || manifestArgument === undefined) {
    return {
      identityManifest: null,
      identityManifestPath: null,
      identityManifestSha256: null,
      identityManifestPathIndependent: false,
      identityManifestError: null,
    };
  }
  if (typeof manifestArgument !== "string" || manifestArgument.trim() === "" || manifestArgument.includes("\0")) {
    return { identityManifestError: { code: "IDENTITY_MANIFEST_PATH_INVALID", message: "identity manifest path must be a nonempty file path" } };
  }

  let manifestRealPath;
  try {
    manifestRealPath = fs.realpathSync.native(path.resolve(repoRoot, manifestArgument));
    if (!fs.statSync(manifestRealPath).isFile()) {
      return { identityManifestError: { code: "IDENTITY_MANIFEST_NOT_FILE", message: "identity manifest must resolve to a file" } };
    }
  } catch {
    return { identityManifestError: { code: "IDENTITY_MANIFEST_NOT_FOUND", message: "identity manifest must exist and resolve to a file" } };
  }

  try {
    const reportRealPath = fs.realpathSync.native(path.resolve(repoRoot, reportPath));
    if (sameCanonicalArtifactPath(manifestRealPath, reportRealPath)) {
      return { identityManifestError: { code: "IDENTITY_MANIFEST_REPORT_ALIAS", message: "identity manifest must resolve to a different file than the report" } };
    }
  } catch {
    return { identityManifestError: { code: "IDENTITY_MANIFEST_REPORT_UNRESOLVED", message: "report path must resolve before identity manifest independence can be checked" } };
  }

  if (typeof artifactRoot !== "string" || artifactRoot.trim() === "") {
    return { identityManifestError: { code: "IDENTITY_MANIFEST_ARTIFACT_ROOT_REQUIRED", message: "a separate --artifact-root is required to verify identity manifest path independence" } };
  }
  let rootRealPath;
  try {
    rootRealPath = fs.realpathSync.native(path.resolve(repoRoot, artifactRoot));
    if (!fs.statSync(rootRealPath).isDirectory()) {
      return { identityManifestError: { code: "IDENTITY_MANIFEST_ARTIFACT_ROOT_INVALID", message: "--artifact-root must resolve to a directory" } };
    }
  } catch {
    return { identityManifestError: { code: "IDENTITY_MANIFEST_ARTIFACT_ROOT_INVALID", message: "--artifact-root must exist and resolve to a directory" } };
  }
  if (isWithinDirectory(rootRealPath, manifestRealPath)) {
    return { identityManifestError: { code: "IDENTITY_MANIFEST_INSIDE_ARTIFACT_ROOT", message: "identity manifest must resolve outside --artifact-root" } };
  }

  try {
    const bytes = fs.readFileSync(manifestRealPath);
    let identityManifest;
    try {
      identityManifest = JSON.parse(bytes.toString("utf8"));
    } catch {
      return { identityManifestError: { code: "IDENTITY_MANIFEST_JSON_INVALID", message: "identity manifest must contain valid JSON" } };
    }
    return {
      identityManifest,
      identityManifestPath: manifestRealPath,
      identityManifestSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      identityManifestPathIndependent: true,
      identityManifestError: null,
    };
  } catch {
    return { identityManifestError: { code: "IDENTITY_MANIFEST_UNREADABLE", message: "identity manifest bytes could not be read" } };
  }
}

function validateIdentityManifestShape(manifest) {
  const hasExactKeys = (value, expected) => isRecord(value) &&
    Object.keys(value).sort().join("\n") === [...expected].sort().join("\n");
  const hasText = (value) => typeof value === "string" && value.trim() !== "";
  const hasSha256 = (value) => typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value);
  if (!hasExactKeys(manifest, ["schemaVersion", "task", "sourceCommit", "artifactRootKind", "helper", "rollbackPrior"]) ||
      manifest.schemaVersion !== 1 || manifest.task !== "T05" || !hasText(manifest.sourceCommit) ||
      manifest.artifactRootKind !== "windows_x64_unpacked_app_root") {
    return "manifest must identify T05, a source commit, and an unpacked Windows x64 app root";
  }
  if (!hasExactKeys(manifest.helper, ["relativePath", "sha256", "version", "protocol"]) ||
      manifest.helper.relativePath !== EXPECTED_HELPER_RESOURCE_RELATIVE_PATH ||
      !hasSha256(manifest.helper.sha256) || !hasText(manifest.helper.version) || !hasText(manifest.helper.protocol)) {
    return "manifest.helper must pin the fixed packaged helper path, SHA-256, version, and protocol";
  }
  if (!hasExactKeys(manifest.rollbackPrior, ["relativePath", "sha256", "version"]) ||
      !hasText(manifest.rollbackPrior.relativePath) || !hasSha256(manifest.rollbackPrior.sha256) ||
      !hasText(manifest.rollbackPrior.version)) {
    return "manifest.rollbackPrior must pin the prior helper path, SHA-256, and version";
  }
  return null;
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
      input: Buffer.from(input, "utf8"),
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

function inspectArtifactFileSha256(reference, expectedSha256, artifactRoot) {
  if (typeof artifactRoot !== "string" || artifactRoot.trim() === "") {
    return { code: "ARTIFACT_ROOT_REQUIRED", message: "a package artifact root is required to verify the file bytes" };
  }
  if (typeof reference !== "string" || reference.trim() === "" || reference.includes("\0")) {
    return { code: "ARTIFACT_PATH_INVALID", message: "artifact file path must be a nonempty relative path" };
  }
  if (reference.includes("\\") || reference.includes(":") || path.posix.isAbsolute(reference) || path.win32.isAbsolute(reference) ||
      path.win32.parse(reference).root !== "" || /^[a-z][a-z0-9+.-]*:\/\//i.test(reference)) {
    return { code: "ARTIFACT_PATH_UNSAFE", message: "artifact file path must be relative and use forward slashes" };
  }
  const segments = reference.split("/");
  const hasUnsafeSegment = segments.some((segment) =>
    segment === "" || segment === "." || segment === ".." || /[. ]$/.test(segment) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment));
  if (hasUnsafeSegment) {
    return { code: "ARTIFACT_PATH_UNSAFE", message: "artifact file path contains an unsafe or non-portable segment" };
  }
  if (typeof expectedSha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(expectedSha256)) {
    return { code: "ARTIFACT_SHA256_INVALID", message: "reported artifact SHA-256 must contain exactly 64 hexadecimal characters" };
  }

  let rootRealPath;
  try {
    rootRealPath = fs.realpathSync.native(path.resolve(artifactRoot));
    if (!fs.statSync(rootRealPath).isDirectory()) {
      return { code: "ARTIFACT_ROOT_INVALID", message: "artifact root must resolve to a directory" };
    }
  } catch {
    return { code: "ARTIFACT_ROOT_INVALID", message: "artifact root must exist and resolve to a directory" };
  }

  const candidate = path.resolve(rootRealPath, ...segments);
  if (!isWithinDirectory(rootRealPath, candidate)) {
    return { code: "ARTIFACT_PATH_UNSAFE", message: "artifact file path resolves outside the artifact root" };
  }

  let realPath;
  try {
    realPath = fs.realpathSync.native(candidate);
  } catch {
    return { code: "ARTIFACT_FILE_NOT_FOUND", message: "artifact file does not exist under the artifact root" };
  }
  if (!isWithinDirectory(rootRealPath, realPath)) {
    return { code: "ARTIFACT_PATH_UNSAFE", message: "artifact file or symlink resolves outside the artifact root" };
  }
  try {
    if (!fs.statSync(realPath).isFile()) {
      return { code: "ARTIFACT_FILE_NOT_FILE", message: "artifact path must resolve to a file" };
    }
  } catch {
    return { code: "ARTIFACT_FILE_NOT_FOUND", message: "artifact file does not exist under the artifact root" };
  }

  let actualSha256;
  let fileIdentity = null;
  try {
    const descriptor = fs.openSync(realPath, "r");
    try {
      const fileStats = fs.fstatSync(descriptor, { bigint: true });
      if (!fileStats.isFile()) {
        return { code: "ARTIFACT_FILE_NOT_FILE", message: "artifact path must resolve to a file" };
      }
      if (fileStats.ino !== 0n) {
        fileIdentity = { device: fileStats.dev.toString(), file: fileStats.ino.toString() };
      }
      const hash = crypto.createHash("sha256");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let bytesRead;
      do {
        bytesRead = fs.readSync(descriptor, chunk, 0, chunk.length, null);
        if (bytesRead > 0) hash.update(chunk.subarray(0, bytesRead));
      } while (bytesRead > 0);
      actualSha256 = hash.digest("hex");
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return { code: "ARTIFACT_FILE_UNREADABLE", message: "artifact file bytes could not be read" };
  }
  if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    return { code: "ARTIFACT_SHA256_MISMATCH", message: "reported SHA-256 does not match the artifact file bytes" };
  }
  return { realPath, actualSha256, fileIdentity };
}

function validateArtifactFileSha256(reference, expectedSha256, artifactRoot) {
  const inspection = inspectArtifactFileSha256(reference, expectedSha256, artifactRoot);
  return inspection.code ? inspection : null;
}

function sameCanonicalArtifactPath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const normalize = process.platform === "win32"
    ? (value) => path.win32.normalize(value).toLowerCase()
    : (value) => path.normalize(value);
  return normalize(left) === normalize(right);
}

function sameArtifactFileIdentity(left, right) {
  return left?.fileIdentity !== null && left?.fileIdentity !== undefined &&
    right?.fileIdentity !== null && right?.fileIdentity !== undefined &&
    left.fileIdentity.device === right.fileIdentity.device &&
    left.fileIdentity.file === right.fileIdentity.file;
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

  validateG0Runtime(report.g0Runtime, errors);

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

function validateG0Runtime(g0Runtime, errors) {
  if (!isRecord(g0Runtime)) return;

  const blockingSpawnSync = g0Runtime.noInteractiveBlockingSpawnSync;
  if (isRecord(blockingSpawnSync) && blockingSpawnSync.result === "PASS") {
    const location = "$.g0Runtime.noInteractiveBlockingSpawnSync";
    validateG0CheckFields(blockingSpawnSync, location, errors);
    const observation = blockingSpawnSync.observation;
    if (!isRecord(observation)) {
      addError(errors, "G0_BLOCKING_SPAWNSYNC_OBSERVATION_REQUIRED", `${location}.observation`, "PASS requires structured interaction and instrumented-call observations");
    } else {
      const observationLocation = `${location}.observation`;
      validateExactFields(
        observation,
        ["requestIds", "interactionSequenceByRequestId", "callsByRequestId", "instrumentedBlockingSpawnSyncCalls"],
        observationLocation,
        "G0_BLOCKING_SPAWNSYNC_OBSERVATION_FIELDS",
        errors,
      );
      const requestIds = validateG0RequestIds(
        observation.requestIds,
        `${observationLocation}.requestIds`,
        1,
        errors,
      );
      validateG0InteractionSequenceMap(
        observation.requestIds,
        observation.interactionSequenceByRequestId,
        `${observationLocation}.interactionSequenceByRequestId`,
        errors,
      );
      const callsByRequestId = observation.callsByRequestId;
      if (!isRecord(callsByRequestId)) {
        addError(errors, "G0_BLOCKING_SPAWNSYNC_CALL_MAP_REQUIRED", `${observationLocation}.callsByRequestId`, "PASS requires a blocking API trace map keyed by request ID");
      } else {
        const traceRequestIds = Object.keys(callsByRequestId);
        if (traceRequestIds.length < 1) {
          addError(errors, "G0_BLOCKING_SPAWNSYNC_CALL_MAP_COUNT", `${observationLocation}.callsByRequestId`, "PASS requires at least one per-request trace entry");
        }
        validateG0RequestIdSet(requestIds, traceRequestIds, `${observationLocation}.callsByRequestId`, "G0_BLOCKING_SPAWNSYNC_CALL_IDS_MISMATCH", errors);
        let spawnSyncCallCount = 0;
        for (const [requestId, calls] of Object.entries(callsByRequestId)) {
          const traceLocation = `${observationLocation}.callsByRequestId.${requestId}`;
          validateG0RequestId(requestId, traceLocation, errors);
          if (!Array.isArray(calls)) {
            addError(errors, "G0_BLOCKING_SPAWNSYNC_TRACE_INVALID", traceLocation, "each request ID must map to an array of blocking API calls");
            continue;
          }
          for (const [index, apiName] of calls.entries()) {
            if (!isG0String(apiName, 128)) {
              addError(errors, "G0_BLOCKING_SPAWNSYNC_TRACE_INVALID", `${traceLocation}[${index}]`, "blocking API trace entries must be nonempty strings of at most 128 characters");
            }
            if (apiName === "spawnSync") spawnSyncCallCount += 1;
          }
          if (calls.length > 0) {
            addError(errors, "G0_BLOCKING_SPAWN_API_CALLS", traceLocation, "PASS requires an empty blocking process-spawn API trace for every interaction");
          }
        }
        if (observation.instrumentedBlockingSpawnSyncCalls !== spawnSyncCallCount) {
          addError(errors, "G0_BLOCKING_SPAWNSYNC_COUNT_MISMATCH", `${observationLocation}.instrumentedBlockingSpawnSyncCalls`, `counter must equal the ${spawnSyncCallCount} spawnSync call(s) in the per-request traces`);
        }
      }
      if (observation.instrumentedBlockingSpawnSyncCalls !== 0) {
        addError(errors, "G0_BLOCKING_SPAWNSYNC_COUNT", `${observationLocation}.instrumentedBlockingSpawnSyncCalls`, "PASS requires zero instrumented blocking spawnSync calls");
      }
    }
  }

  const helperReuse = g0Runtime.noHelperProcessPerInteraction;
  if (isRecord(helperReuse) && helperReuse.result === "PASS") {
    const location = "$.g0Runtime.noHelperProcessPerInteraction";
    validateG0CheckFields(helperReuse, location, errors);
    const observation = helperReuse.observation;
    if (!isRecord(observation)) {
      addError(errors, "G0_HELPER_REUSE_OBSERVATION_REQUIRED", `${location}.observation`, "PASS requires structured per-interaction helper identity observations");
      return;
    }

    const observationLocation = `${location}.observation`;
    validateExactFields(
      observation,
      ["requestIds", "interactionSequenceByRequestId", "observationsByRequestId"],
      observationLocation,
      "G0_HELPER_REUSE_OBSERVATION_FIELDS",
      errors,
    );
    const requestIds = validateG0RequestIds(
      observation.requestIds,
      `${observationLocation}.requestIds`,
      2,
      errors,
    );
    validateG0InteractionSequenceMap(
      observation.requestIds,
      observation.interactionSequenceByRequestId,
      `${observationLocation}.interactionSequenceByRequestId`,
      errors,
    );
    const observations = observation.observationsByRequestId;
    if (!isRecord(observations)) {
      addError(errors, "G0_HELPER_OBSERVATIONS_REQUIRED", `${observationLocation}.observationsByRequestId`, "PASS requires a per-request helper observation map");
      return;
    }

    const observationIds = Object.keys(observations);
    if (observationIds.length < 2) {
      addError(errors, "G0_HELPER_OBSERVATION_COUNT", `${observationLocation}.observationsByRequestId`, "PASS requires at least two interaction observations");
    }
    validateG0RequestIdSet(requestIds, observationIds, `${observationLocation}.observationsByRequestId`, "G0_HELPER_OBSERVATION_IDS_MISMATCH", errors);

    let sharedIdentity = null;
    for (const [requestId, item] of Object.entries(observations)) {
      const itemLocation = `${observationLocation}.observationsByRequestId.${requestId}`;
      validateG0RequestId(requestId, itemLocation, errors);
      if (!isRecord(item)) {
        addError(errors, "G0_HELPER_OBSERVATION_SHAPE", itemLocation, "helper observation must be an object");
        continue;
      }
      validateExactFields(item, ["helperBefore", "helperAfter", "helperLaunchCount"], itemLocation, "G0_HELPER_OBSERVATION_FIELDS", errors);
      const before = item.helperBefore;
      const after = item.helperAfter;
      const beforeValid = validateHelperProcessIdentity(before, `${itemLocation}.helperBefore`, errors);
      const afterValid = validateHelperProcessIdentity(after, `${itemLocation}.helperAfter`, errors);
      if (beforeValid && afterValid &&
          (before.pid !== after.pid || before.creationIdentity !== after.creationIdentity)) {
        addError(errors, "G0_HELPER_PROCESS_IDENTITY_MISMATCH", itemLocation, "helper PID and creation identity must remain unchanged across the interaction");
      }
      if (beforeValid && afterValid) {
        sharedIdentity ??= before;
        if (before.pid !== sharedIdentity.pid || before.creationIdentity !== sharedIdentity.creationIdentity ||
            after.pid !== sharedIdentity.pid || after.creationIdentity !== sharedIdentity.creationIdentity) {
          addError(errors, "G0_HELPER_PROCESS_IDENTITY_CROSS_INTERACTION", itemLocation,
            "helper PID and creation identity must remain unchanged across all observed interactions");
        }
      }
      if (item.helperLaunchCount !== 0) {
        addError(errors, "G0_HELPER_LAUNCH_COUNT", `${itemLocation}.helperLaunchCount`, "PASS requires zero helper launches during each interaction");
      }
    }
  }
}

function validateG0CheckFields(check, location, errors) {
  validateExactFields(check, ["name", "result", "details", "evidence", "observation"], location, "G0_CHECK_FIELDS", errors);
  if (!isG0String(check.name, 256)) {
    addError(errors, "G0_CHECK_NAME_INVALID", `${location}.name`, "G0 PASS check requires a nonempty name of at most 256 characters");
  }
  if (check.details !== undefined &&
      (typeof check.details !== "string" || unicodeCodePointLength(check.details) > 2000)) {
    addError(errors, "G0_CHECK_DETAILS_INVALID", `${location}.details`, "G0 check details must be a string of at most 2000 characters");
  }
}

function validateExactFields(value, allowedFields, location, errorCode, errors) {
  const extras = Object.keys(value).filter((field) => !allowedFields.includes(field));
  if (extras.length > 0) {
    addError(errors, errorCode, location, `unexpected field(s): ${extras.join(", ")}`);
  }
}

function validateG0RequestIdSet(requestIds, observedIds, location, errorCode, errors) {
  if (requestIds === null) return;
  const observed = new Set(observedIds);
  if (requestIds.size !== observedIds.length || observedIds.some((requestId) => !requestIds.has(requestId)) || observed.size !== observedIds.length) {
    addError(errors, errorCode, location, "per-request observations must match each request ID exactly once with no extra IDs");
  }
}

function validateG0InteractionSequenceMap(requestIds, sequenceByRequestId, location, errors) {
  if (!Array.isArray(requestIds)) return;
  if (!isRecord(sequenceByRequestId)) {
    addError(errors, "G0_INTERACTION_SEQUENCE_MAP_REQUIRED", location,
      "PASS requires start/end event sequence boundaries for every request ID");
    return;
  }

  const sequenceRequestIds = Object.keys(sequenceByRequestId);
  validateG0RequestIdSet(new Set(requestIds), sequenceRequestIds, location,
    "G0_INTERACTION_SEQUENCE_IDS_MISMATCH", errors);

  let previousEnd = null;
  for (const [index, requestId] of requestIds.entries()) {
    const range = sequenceByRequestId[requestId];
    const rangeLocation = `${location}.${requestId}`;
    if (!isRecord(range)) {
      addError(errors, "G0_INTERACTION_SEQUENCE_BOUNDS_REQUIRED", rangeLocation,
        "each request ID must have interaction start/end sequence boundaries");
      continue;
    }
    validateExactFields(range, ["startSequence", "endSequence"], rangeLocation,
      "G0_INTERACTION_SEQUENCE_FIELDS", errors);
    const startValid = Number.isSafeInteger(range.startSequence) && range.startSequence >= 0;
    const endValid = Number.isSafeInteger(range.endSequence) && range.endSequence >= 0;
    if (!startValid || !endValid || range.endSequence <= range.startSequence) {
      addError(errors, "G0_INTERACTION_SEQUENCE_BOUNDS_INVALID", rangeLocation,
        "interaction bounds require safe nonnegative integers with endSequence greater than startSequence");
      continue;
    }
    if (index > 0 && previousEnd !== null && range.startSequence <= previousEnd) {
      addError(errors, "G0_INTERACTION_SEQUENCE_ORDER_INVALID", rangeLocation,
        "request IDs must be chronological and interaction sequence ranges must not overlap");
    }
    previousEnd = range.endSequence;
  }
}

function validateG0RequestIds(requestIds, location, minimumCount, errors) {
  if (!Array.isArray(requestIds)) {
    addError(errors, "G0_REQUEST_IDS_REQUIRED", location, "PASS requires a request ID array for observed interactions");
    return null;
  }
  if (requestIds.length < minimumCount) {
    addError(errors, "G0_REQUEST_ID_COUNT", location, `PASS requires at least ${minimumCount} interaction request${minimumCount === 1 ? "" : "s"}`);
  }

  const seen = new Set();
  for (const [index, requestId] of requestIds.entries()) {
    if (!isG0String(requestId, 128)) {
      addError(errors, "G0_REQUEST_ID_INVALID", `${location}[${index}]`, "interaction request IDs must be nonempty strings of at most 128 characters");
      continue;
    }
    if (seen.has(requestId)) {
      addError(errors, "G0_REQUEST_ID_DUPLICATE", `${location}[${index}]`, `duplicate interaction request ID ${requestId}`);
    }
    seen.add(requestId);
  }
  return seen;
}

function validateG0RequestId(requestId, location, errors) {
  if (!isG0String(requestId, 128)) {
    addError(errors, "G0_REQUEST_ID_INVALID", location, "interaction request IDs must be nonempty strings of at most 128 characters");
  }
}

function isG0String(value, maxLength) {
  return typeof value === "string" && unicodeCodePointLength(value) <= maxLength && value.trim() !== "";
}

function unicodeCodePointLength(value) {
  return [...value].length;
}

function validateHelperProcessIdentity(value, location, errors) {
  if (!isRecord(value)) {
    addError(errors, "G0_HELPER_PROCESS_IDENTITY_INVALID", location, "helper process identity must be an object");
    return false;
  }
  validateExactFields(value, ["pid", "creationIdentity"], location, "G0_HELPER_PROCESS_IDENTITY_FIELDS", errors);
  const valid = Number.isInteger(value.pid) && value.pid >= 1 && value.pid <= 0xffffffff &&
    isG0String(value.creationIdentity, 256);
  if (!valid) {
    addError(errors, "G0_HELPER_PROCESS_IDENTITY_INVALID", location, "helper identity requires a positive 32-bit PID and a nonempty creation identity of at most 256 characters");
  }
  return valid;
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
  if (helper?.result === "PASS" && helper.expectedPath !== EXPECTED_HELPER_RESOURCE_RELATIVE_PATH) {
    addError(
      errors,
      "PASS_HELPER_PATH_CONTRACT",
      "$.packageAndRollback.helperResource.expectedPath",
      `top-level PASS requires expectedPath=${EXPECTED_HELPER_RESOURCE_RELATIVE_PATH}`,
    );
  }
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
  if (helper?.result === "PASS") {
    const invalidArtifact = validateArtifactFileSha256(helper.actualPath, helper.actualSha256, context.artifactRoot);
    if (invalidArtifact) {
      addError(errors, invalidArtifact.code, "$.packageAndRollback.helperResource.actualPath", invalidArtifact.message);
    }
  }
  if (helper?.signatureStatus === "unsigned") {
    addError(
      errors,
      "PASS_UNSIGNED_SIGNATURE_POLICY_UNRESOLVED",
      "$.packageAndRollback.helperResource.signatureStatus",
      "root PASS is blocked while unsigned package signature policy is unresolved",
    );
  } else if (helper && helper.signatureStatus !== PASS_SIGNATURE_STATUS) {
    addError(errors, "PASS_HELPER_SIGNATURE_STATUS", "$.packageAndRollback.helperResource.signatureStatus", `helper signatureStatus must be ${PASS_SIGNATURE_STATUS} for root PASS`);
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
  if (rollback?.result === "PASS") {
    const priorArtifact = inspectArtifactFileSha256(rollback.priorPath, rollback.priorSha256, context.artifactRoot);
    const rollbackArtifact = inspectArtifactFileSha256(rollback.rollbackPath, rollback.rollbackSha256, context.artifactRoot);
    if (priorArtifact.code) {
      addError(errors, priorArtifact.code, "$.packageAndRollback.rollback.priorPath", priorArtifact.message);
    }
    if (rollbackArtifact.code) {
      addError(errors, rollbackArtifact.code, "$.packageAndRollback.rollback.rollbackPath", rollbackArtifact.message);
    }
    if (!priorArtifact.code && !rollbackArtifact.code &&
        (sameCanonicalArtifactPath(priorArtifact.realPath, rollbackArtifact.realPath) ||
          sameArtifactFileIdentity(priorArtifact, rollbackArtifact))) {
      addError(
        errors,
        "PASS_ROLLBACK_ARTIFACT_ALIAS",
        "$.packageAndRollback.rollback",
        "priorPath and rollbackPath must resolve to different filesystem files",
      );
    } else if (!priorArtifact.code && !rollbackArtifact.code &&
        (!priorArtifact.fileIdentity || !rollbackArtifact.fileIdentity)) {
      addError(
        errors,
        "PASS_ROLLBACK_FILE_IDENTITY_UNAVAILABLE",
        "$.packageAndRollback.rollback",
        "filesystem identity is required to prove priorPath and rollbackPath are different files",
      );
    }
  }
  if (rollback?.signatureStatus === "unsigned") {
    addError(
      errors,
      "PASS_UNSIGNED_SIGNATURE_POLICY_UNRESOLVED",
      "$.packageAndRollback.rollback.signatureStatus",
      "root PASS is blocked while unsigned package signature policy is unresolved",
    );
  } else if (!isRecord(rollback) || rollback.signatureStatus !== PASS_SIGNATURE_STATUS) {
    addError(errors, "PASS_ROLLBACK_SIGNATURE_STATUS", "$.packageAndRollback.rollback.signatureStatus", `rollback signatureStatus must be ${PASS_SIGNATURE_STATUS} for root PASS`);
  }
  requirePass(rollback?.helperBinaryOnly, "$.packageAndRollback.rollback.helperBinaryOnly", errors);

  validateRootPassIdentityManifest(report, context, helper, rollback, errors);

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

function validateRootPassIdentityManifest(report, context, helper, rollback, errors) {
  if (context.identityManifestError) {
    addError(
      errors,
      "PASS_IDENTITY_MANIFEST_INVALID",
      "--identity-manifest",
      `${context.identityManifestError.code}: ${context.identityManifestError.message}`,
    );
    return;
  }
  if (!context.identityManifestPath || !/^[a-fA-F0-9]{64}$/.test(context.identityManifestSha256 ?? "") ||
      context.identityManifestPathIndependent !== true || !isRecord(context.identityManifest)) {
    addError(
      errors,
      "PASS_IDENTITY_MANIFEST_REQUIRED",
      "--identity-manifest",
      "root PASS requires a separate caller-supplied identity manifest outside the report and --artifact-root",
    );
    return;
  }

  const manifest = context.identityManifest;
  const shapeError = validateIdentityManifestShape(manifest);
  if (shapeError) {
    addError(errors, "PASS_IDENTITY_MANIFEST_INVALID", "--identity-manifest", shapeError);
    return;
  }
  if (manifest.sourceCommit !== report.source?.commit) {
    addError(
      errors,
      "PASS_IDENTITY_MANIFEST_SOURCE_MISMATCH",
      "--identity-manifest.sourceCommit",
      "identity manifest sourceCommit must equal report.source.commit",
    );
  }

  const sha256Matches = (actual, expected) =>
    typeof actual === "string" && actual.toLowerCase() === expected.toLowerCase();
  if (sha256Matches(manifest.rollbackPrior.sha256, manifest.helper.sha256)) {
    addError(
      errors,
      "PASS_ROLLBACK_PRIOR_IS_CURRENT_HELPER",
      "--identity-manifest.rollbackPrior.sha256",
      "rollback prior helper SHA-256 must differ from the currently packaged helper for a binary rollback",
    );
  }

  const helperMatchesManifest = isRecord(helper) &&
    helper.expectedPath === manifest.helper.relativePath &&
    helper.actualPath === manifest.helper.relativePath &&
    sha256Matches(helper.expectedSha256, manifest.helper.sha256) &&
    sha256Matches(helper.actualSha256, manifest.helper.sha256) &&
    helper.expectedVersion === manifest.helper.version &&
    helper.actualVersion === manifest.helper.version &&
    helper.expectedProtocol === manifest.helper.protocol &&
    helper.actualProtocol === manifest.helper.protocol;
  if (!helperMatchesManifest) {
    addError(
      errors,
      "PASS_HELPER_TRUSTED_IDENTITY_MISMATCH",
      "$.packageAndRollback.helperResource",
      "helper expected/actual path, SHA-256, version, and protocol must match the caller-supplied identity manifest",
    );
  }

  const rollbackMatchesManifest = isRecord(rollback) &&
    rollback.priorPath === manifest.rollbackPrior.relativePath &&
    sha256Matches(rollback.priorSha256, manifest.rollbackPrior.sha256) &&
    sha256Matches(rollback.rollbackSha256, manifest.rollbackPrior.sha256) &&
    rollback.priorVersion === manifest.rollbackPrior.version &&
    rollback.rollbackVersion === manifest.rollbackPrior.version;
  if (!rollbackMatchesManifest) {
    addError(
      errors,
      "PASS_ROLLBACK_TRUSTED_IDENTITY_MISMATCH",
      "$.packageAndRollback.rollback",
      "rollback prior path, SHA-256, and version, plus restored rollback identity, must match the caller-supplied identity manifest",
    );
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
  const args = process.argv.slice(2);
  let schemaValidationRequested = false;
  let artifactRootArgument = null;
  let identityManifestArgument = null;
  let identityManifestOptionSeen = false;
  let reportArgument = null;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--validate-schema") {
      schemaValidationRequested = true;
    } else if (argument === "--artifact-root") {
      artifactRootArgument = args[index + 1] ?? null;
      if (artifactRootArgument === null || artifactRootArgument.startsWith("--")) {
        console.error("PREPARATION_ONLY: --artifact-root requires a directory path.");
        process.exitCode = 1;
        return;
      }
      index += 1;
    } else if (argument.startsWith("--artifact-root=")) {
      artifactRootArgument = argument.slice("--artifact-root=".length);
      if (artifactRootArgument === "") {
        console.error("PREPARATION_ONLY: --artifact-root requires a directory path.");
        process.exitCode = 1;
        return;
      }
    } else if (argument === "--identity-manifest") {
      if (identityManifestOptionSeen) {
        console.error("PREPARATION_ONLY: provide --identity-manifest at most once.");
        process.exitCode = 1;
        return;
      }
      identityManifestOptionSeen = true;
      identityManifestArgument = args[index + 1] ?? null;
      if (identityManifestArgument === null || identityManifestArgument.startsWith("--")) {
        console.error("PREPARATION_ONLY: --identity-manifest requires a file path.");
        process.exitCode = 1;
        return;
      }
      index += 1;
    } else if (argument.startsWith("--identity-manifest=")) {
      if (identityManifestOptionSeen) {
        console.error("PREPARATION_ONLY: provide --identity-manifest at most once.");
        process.exitCode = 1;
        return;
      }
      identityManifestOptionSeen = true;
      identityManifestArgument = argument.slice("--identity-manifest=".length);
      if (identityManifestArgument === "") {
        console.error("PREPARATION_ONLY: --identity-manifest requires a file path.");
        process.exitCode = 1;
        return;
      }
    } else if (argument.startsWith("--")) {
      console.error(`PREPARATION_ONLY: unsupported option ${argument}.`);
      process.exitCode = 1;
      return;
    } else if (reportArgument === null) {
      reportArgument = argument;
    } else {
      console.error("PREPARATION_ONLY: provide at most one report path.");
      process.exitCode = 1;
      return;
    }
  }
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
  const artifactRoot = artifactRootArgument === null ? null : path.resolve(REPO_ROOT, artifactRootArgument);
  const identityManifestInput = loadIdentityManifestFile(
    identityManifestArgument,
    reportPath,
    artifactRoot,
    REPO_ROOT,
  );
  const context = loadVerifierContext(REPO_ROOT, {
    artifactRoot,
    ...identityManifestInput,
  });

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
  const identityNote = context.identityManifestSha256
    ? `; caller-supplied identity manifest SHA-256=${context.identityManifestSha256}`
    : "";
  console.log(`PREPARATION_ONLY: report consistency checks passed; ${schemaNote}${identityNote} (${report.cases.length} cases, ${context.assertionMap.assertions.length} assertion names, T03=${report.dependencyGate.T03}, T04=${report.dependencyGate.T04}, status=${report.status}); behavior acceptance is not implied.`);
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
  loadIdentityManifestFile,
  loadVerifierContext,
  nearestRankPercentile,
  validateEvidenceReference,
  validateArtifactFileSha256,
  validateDraft202012Instance,
  validateIdentityManifestShape,
  validateMeasurement,
};
