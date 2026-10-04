"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EXPECTED_CASE_IDS = Array.from({ length: 28 }, (_, index) => `P${String(index + 1).padStart(2, "0")}`);
const EXPECTED_G0_IDS = [
  "g0-no-interactive-blocking-spawnSync",
  "g0-no-helper-process-per-interaction",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectPreparationErrors({ fixturePlan, assertionMap, reportSchema }) {
  const errors = [];
  const add = (code, message) => errors.push({ code, message });

  if (!isRecord(fixturePlan)) {
    add("FIXTURE_SHAPE", "fixturePlan must be a JSON object");
  }
  if (!isRecord(assertionMap)) {
    add("MAP_SHAPE", "assertionMap must be a JSON object");
  }
  if (!isRecord(reportSchema)) {
    add("SCHEMA_SHAPE", "reportSchema must be a JSON object");
  }
  if (!isRecord(fixturePlan) || !isRecord(assertionMap) || !isRecord(reportSchema)) {
    return errors;
  }

  if (fixturePlan.task !== "T05" || assertionMap.task !== "T05") {
    add("TASK_ID", "fixturePlan and assertionMap must identify task T05");
  }
  if (reportSchema.$schema !== "https://json-schema.org/draft/2020-12/schema") {
    add("SCHEMA_DIALECT", "reportSchema must use JSON Schema Draft 2020-12 for contains/maxContains constraints");
  }
  if (reportSchema.type !== "object") {
    add("SCHEMA_ROOT_TYPE", "reportSchema root must be an object");
  }
  if (!Array.isArray(reportSchema.required) || !reportSchema.required.includes("cases")) {
    add("SCHEMA_CASES_REQUIRED", "reportSchema root must require the cases property");
  }
  if (fixturePlan.status !== "preflight_only" || fixturePlan.executionStatus !== "NOT_RUN") {
    add("PREPARATION_STATUS", "fixturePlan must remain preflight_only with executionStatus NOT_RUN");
  }
  if (assertionMap.executionStatus !== "NOT_RUN") {
    add("PREPARATION_STATUS", "assertionMap must remain NOT_RUN");
  }

  const cases = Array.isArray(fixturePlan.cases) ? fixturePlan.cases : [];
  if (!Array.isArray(fixturePlan.cases)) {
    add("FIXTURE_CASES", "fixturePlan.cases must be an array");
  }
  const actualCaseIds = cases.map((item) => (isRecord(item) ? item.id : undefined));
  const seenCaseIds = new Set();
  for (const id of actualCaseIds) {
    if (typeof id === "string" && seenCaseIds.has(id)) {
      add("FIXTURE_CASE_DUPLICATE", `fixturePlan contains duplicate case ID ${id}`);
    }
    if (typeof id === "string") seenCaseIds.add(id);
  }
  if (actualCaseIds.length !== EXPECTED_CASE_IDS.length ||
      actualCaseIds.some((id, index) => id !== EXPECTED_CASE_IDS[index])) {
    add("FIXTURE_CASE_ORDER", "fixturePlan case IDs must be P01-P28 exactly once and in order");
  }

  const expectedAssertions = [];
  for (const [caseIndex, item] of cases.entries()) {
    const caseId = isRecord(item) ? item.id : undefined;
    if (!isRecord(item) || !Array.isArray(item.assert)) {
      add("FIXTURE_ASSERTIONS", `fixturePlan.cases[${caseIndex}].assert must be an array`);
      continue;
    }
    item.assert.forEach((assertionText, assertionIndex) => {
      expectedAssertions.push({
        caseId,
        assertionId: `${String(caseId)}-A${String(assertionIndex + 1).padStart(2, "0")}`,
        assertionText,
        caseIndex,
        assertionIndex,
      });
    });
  }

  const mappedAssertions = Array.isArray(assertionMap.assertions) ? assertionMap.assertions : [];
  if (!Array.isArray(assertionMap.assertions)) {
    add("MAP_ASSERTIONS", "assertionMap.assertions must be an array");
  }
  if (mappedAssertions.length !== expectedAssertions.length) {
    add("MAP_LENGTH", `assertionMap has ${mappedAssertions.length} records; fixturePlan has ${expectedAssertions.length} assertions`);
  }

  const seenAssertionIds = new Set();
  for (const [index, mapped] of mappedAssertions.entries()) {
    if (!isRecord(mapped)) {
      add("MAP_RECORD", `assertionMap.assertions[${index}] must be an object`);
      continue;
    }
    const expected = expectedAssertions[index];
    if (typeof mapped.assertionId === "string" && seenAssertionIds.has(mapped.assertionId)) {
      add("MAP_DUPLICATE_ID", `assertionMap contains duplicate assertion ID ${mapped.assertionId}`);
    }
    if (typeof mapped.assertionId === "string") seenAssertionIds.add(mapped.assertionId);
    if (!expected) continue;

    if (mapped.caseId !== expected.caseId || mapped.assertionId !== expected.assertionId) {
      add("MAP_ID_OR_ORDER", `assertionMap.assertions[${index}] must be ${expected.assertionId} for ${expected.caseId}`);
    }
    if (mapped.assertionText !== expected.assertionText) {
      add("MAP_TEXT", `assertionMap.assertions[${index}] text differs from fixturePlan ${expected.caseId}.assert[${expected.assertionIndex}]`);
    }
    if (mapped.status !== "NOT_RUN" || !Array.isArray(mapped.evidence) || mapped.evidence.length !== 0) {
      add("MAP_EXECUTION_STATE", `assertionMap.assertions[${index}] must remain NOT_RUN with no evidence`);
    }
  }

  if (!isRecord(assertionMap.summary)) {
    add("MAP_SUMMARY", "assertionMap.summary must be an object");
  } else {
    if (assertionMap.summary.caseCount !== EXPECTED_CASE_IDS.length) {
      add("MAP_SUMMARY", "assertionMap.summary.caseCount must be 28");
    }
    if (assertionMap.summary.assertionCount !== expectedAssertions.length) {
      add("MAP_SUMMARY", `assertionMap.summary.assertionCount must be ${expectedAssertions.length}`);
    }
    if (assertionMap.summary.uniqueAssertionIdCount !== seenAssertionIds.size) {
      add("MAP_SUMMARY", "assertionMap.summary.uniqueAssertionIdCount does not match unique assertion IDs");
    }
    if (!isRecord(assertionMap.summary.caseAssertionCounts)) {
      add("MAP_SUMMARY", "assertionMap.summary.caseAssertionCounts must be an object");
    } else {
      for (const id of EXPECTED_CASE_IDS) {
        const actualCount = cases.find((item) => isRecord(item) && item.id === id)?.assert?.length;
        if (assertionMap.summary.caseAssertionCounts[id] !== actualCount) {
          add("MAP_SUMMARY", `assertionMap.summary.caseAssertionCounts.${id} does not match fixturePlan`);
        }
      }
    }
  }

  const g0Gates = Array.isArray(fixturePlan.g0RuntimeGates) ? fixturePlan.g0RuntimeGates : [];
  if (!Array.isArray(fixturePlan.g0RuntimeGates)) {
    add("G0_SHAPE", "fixturePlan.g0RuntimeGates must be an array");
  }
  const actualG0Ids = g0Gates.map((gate) => (isRecord(gate) ? gate.id : undefined));
  if (actualG0Ids.length !== EXPECTED_G0_IDS.length ||
      EXPECTED_G0_IDS.some((id, index) => actualG0Ids[index] !== id) ||
      new Set(actualG0Ids).size !== actualG0Ids.length) {
    add("G0_IDS", "fixturePlan must contain the two planned G0 gates exactly once and in order");
  }
  for (const [index, gate] of g0Gates.entries()) {
    if (!isRecord(gate) || gate.status !== "planned" || gate.executionStatus !== "NOT_RUN") {
      add("G0_EXECUTION_STATE", `fixturePlan.g0RuntimeGates[${index}] must remain planned/NOT_RUN`);
    }
  }

  const casesSchema = reportSchema.properties?.cases;
  if (!isRecord(casesSchema)) {
    add("SCHEMA_CASES", "reportSchema.properties.cases must define the cases array");
  } else {
    if (casesSchema.type !== "array" ||
        casesSchema.minItems !== EXPECTED_CASE_IDS.length ||
        casesSchema.maxItems !== EXPECTED_CASE_IDS.length) {
      add("SCHEMA_CASES_LENGTH", "reportSchema cases must require exactly 28 entries");
    }
    const idClauses = Array.isArray(casesSchema.allOf)
      ? casesSchema.allOf.filter((clause) => typeof clause?.contains?.properties?.id?.const === "string")
      : [];
    const clauseIds = idClauses.map((clause) => clause.contains.properties.id.const);
    for (const id of EXPECTED_CASE_IDS) {
      const matches = idClauses.filter((clause) => clause.contains.properties.id.const === id);
      const exactOnce = matches.length === 1 &&
        matches[0].contains.type === "object" &&
        Array.isArray(matches[0].contains.required) &&
        matches[0].contains.required.includes("id") &&
        matches[0].minContains === 1 &&
        matches[0].maxContains === 1;
      if (!exactOnce) {
        add("SCHEMA_CASE_EXACTLY_ONCE", `reportSchema must constrain ${id} to occur exactly once`);
      }
    }
    const unknownIds = [...new Set(clauseIds.filter((id) => !EXPECTED_CASE_IDS.includes(id)))];
    if (unknownIds.length > 0) {
      add("SCHEMA_CASE_UNKNOWN", `reportSchema contains unexpected case ID constraints: ${unknownIds.join(", ")}`);
    }
    if (casesSchema.items?.$ref !== "#/$defs/caseResult") {
      add("SCHEMA_CASE_ITEM", "reportSchema cases items must reference #/$defs/caseResult");
    }
  }

  return errors;
}

function loadPreparationInputs(directory = __dirname) {
  const readJson = (fileName) => JSON.parse(fs.readFileSync(path.join(directory, fileName), "utf8"));
  return {
    fixturePlan: readJson("fixture-plan.json"),
    assertionMap: readJson("assertion-map.json"),
    reportSchema: readJson("report.schema.json"),
  };
}

function main() {
  let inputs;
  try {
    inputs = loadPreparationInputs();
  } catch (error) {
    console.error(`PREPARATION_ONLY: unable to read T05 preparation JSON: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const errors = collectPreparationErrors(inputs);
  if (errors.length > 0) {
    console.error("PREPARATION_ONLY: T05 static preparation checks failed:");
    for (const error of errors) console.error(`- [${error.code}] ${error.message}`);
    process.exitCode = 1;
    return;
  }

  console.log(`PREPARATION_ONLY: static traceability/schema checks passed (${EXPECTED_CASE_IDS.length} cases, ${inputs.assertionMap.assertions.length} assertions, ${EXPECTED_G0_IDS.length} G0 gates); no behavior was executed and T05 acceptance is not implied.`);
}

if (require.main === module) main();

module.exports = {
  EXPECTED_CASE_IDS,
  collectPreparationErrors,
  loadPreparationInputs,
};
