"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { loadPreparationInputs } = require("./validate-preparation.cjs");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const OUTPUT_PATH = path.join(__dirname, "report.not-run.example.json");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function makeCheck(name) {
  return { name, result: "NOT_RUN", evidence: [] };
}

function makeMeasurement() {
  return {
    status: "NOT_RUN",
    observationMode: "not_run",
    targetSampleCount: 100,
    successfulSampleCount: 0,
    failureCount: 0,
    cancellationCount: 0,
    timeoutCount: 0,
    p50Ms: null,
    p95Ms: null,
    maxMs: null,
    evidence: [],
    samples: [],
  };
}

function buildNotRunReport({ fixturePlan, assertionMap, progress }) {
  const taskStatuses = progress?.tasks;
  if (!taskStatuses?.T03?.status || !taskStatuses?.T04?.status) {
    throw new Error("docs/progress.json must contain T03 and T04 statuses");
  }

  const assertionsByCase = new Map();
  for (const assertion of assertionMap.assertions) {
    const list = assertionsByCase.get(assertion.caseId) ?? [];
    list.push(assertion);
    assertionsByCase.set(assertion.caseId, list);
  }

  const lifecycle = Object.fromEntries(
    ["coldStart", "trayAvailability", "appRestart", "normalExit", "helperShutdown"]
      .map((name) => [name, makeCheck(name)]),
  );

  return {
    schemaVersion: 1,
    task: "T05",
    runId: "t05-not-run-example",
    status: "NOT_RUN",
    source: {
      commit: null,
      branch: "not-run-example",
      workingTreeWasDirty: false,
    },
    dependencyGate: {
      T03: taskStatuses.T03.status,
      T04: taskStatuses.T04.status,
    },
    environment: {
      platform: "NOT_RUN",
      osVersion: null,
      architecture: "other",
      buildMode: "debug",
      dataProfile: "isolated_synthetic",
      datasetSeed: "not-run-example",
      displayConfiguration: null,
      powerMode: null,
      networkCondition: null,
      cacheState: "not_applicable",
    },
    cases: fixturePlan.cases.map((fixtureCase) => ({
      id: fixtureCase.id,
      mode: "fake",
      result: "NOT_RUN",
      assertions: (assertionsByCase.get(fixtureCase.id) ?? []).map((assertion) =>
        makeCheck(assertion.assertionId)),
      evidence: [],
    })),
    g0Runtime: {
      noInteractiveBlockingSpawnSync: makeCheck("noInteractiveBlockingSpawnSync"),
      noHelperProcessPerInteraction: makeCheck("noHelperProcessPerInteraction"),
    },
    measurements: {
      normalText: makeMeasurement(),
      wakeToActionable: makeMeasurement(),
    },
    packageAndRollback: {
      localPackage: makeCheck("localPackage"),
      helperResource: {
        result: "NOT_RUN",
        expectedPath: null,
        actualPath: null,
        expectedVersion: null,
        actualVersion: null,
        expectedProtocol: null,
        actualProtocol: null,
        expectedSha256: null,
        actualSha256: null,
        identityMatched: false,
        signatureStatus: "not_checked",
        evidence: [],
      },
      lifecycle,
      rollback: {
        result: "NOT_RUN",
        priorPath: null,
        priorVersion: null,
        priorSha256: null,
        rollbackPath: null,
        rollbackVersion: null,
        rollbackSha256: null,
        identityMatched: false,
        signatureStatus: "not_checked",
        helperBinaryOnly: makeCheck("helperBinaryOnly"),
        evidence: [],
      },
      dataCompatibility: {
        oldJsonReadable: makeCheck("oldJsonReadable"),
        appDataPreserved: makeCheck("appDataPreserved"),
      },
      autoPaste: {
        disabled: makeCheck("disabled"),
        copyAvailable: makeCheck("copyAvailable"),
      },
      evidence: [],
      publication: "NOT_PUBLISHED",
    },
    notRun: [
      "P01-P28 behavior assertions have not been run.",
      "Both G0 runtime observation gates remain NOT_RUN.",
      "The 100-sample controlled-live measurements remain NOT_RUN.",
      "Package, helper lifecycle, rollback, and data compatibility checks remain NOT_RUN.",
    ],
  };
}

function main() {
  const inputs = loadPreparationInputs();
  const progress = readJson(path.join(REPO_ROOT, "docs", "progress.json"));
  const report = buildNotRunReport({ ...inputs, progress });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`PREPARATION_ONLY: wrote a NOT_RUN example with ${report.cases.length} cases and ${inputs.assertionMap.assertions.length} assertion names; no behavior was executed.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`PREPARATION_ONLY: unable to generate NOT_RUN report example: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { buildNotRunReport };
