"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  collectPreparationErrors,
  loadPreparationInputs,
} = require("./validate-preparation.cjs");

const baseline = loadPreparationInputs();
const clone = (value) => JSON.parse(JSON.stringify(value));

function codesFor(changes) {
  const inputs = {
    fixturePlan: clone(baseline.fixturePlan),
    assertionMap: clone(baseline.assertionMap),
    reportSchema: clone(baseline.reportSchema),
  };
  changes(inputs);
  return collectPreparationErrors(inputs).map((error) => error.code);
}

test("current T05 materials pass static preparation checks", () => {
  assert.deepEqual(collectPreparationErrors(baseline), []);
});

test("requires the runtime helper resource path in the fixture plan", () => {
  const codes = codesFor(({ fixturePlan }) => {
    fixturePlan.packageResourceContract.helperRelativePath = "resources/alternate/clipnest-helper.exe";
  });
  assert.ok(codes.includes("PACKAGE_HELPER_PATH_CONTRACT"));
});

test("requires the report schema PASS path to match the runtime helper resource", () => {
  const codes = codesFor(({ reportSchema }) => {
    reportSchema.properties.packageAndRollback.properties.helperResource.allOf[0]
      .then.properties.expectedPath.const = "resources/alternate/clipnest-helper.exe";
  });
  assert.ok(codes.includes("SCHEMA_HELPER_PATH_CONTRACT"));
});

test("requires rollback artifact paths to identify distinct canonical files", () => {
  const codes = codesFor(({ fixturePlan }) => {
    fixturePlan.packageResourceContract.rollbackRequiresDistinctCanonicalFiles = false;
  });
  assert.ok(codes.includes("ROLLBACK_DISTINCT_FILE_CONTRACT"));
});

test("rejects changed source assertion text", () => {
  const codes = codesFor(({ assertionMap }) => {
    assertionMap.assertions[0].assertionText = "invented assertion";
  });
  assert.ok(codes.includes("MAP_TEXT"));
});

test("rejects reordered mapped assertions", () => {
  const codes = codesFor(({ assertionMap }) => {
    [assertionMap.assertions[0], assertionMap.assertions[1]] =
      [assertionMap.assertions[1], assertionMap.assertions[0]];
  });
  assert.ok(codes.includes("MAP_ID_OR_ORDER"));
});

test("rejects a changed assertion ID", () => {
  const codes = codesFor(({ assertionMap }) => {
    assertionMap.assertions[0].assertionId = "P99-A01";
  });
  assert.ok(codes.includes("MAP_ID_OR_ORDER"));
});

test("rejects duplicate assertion IDs", () => {
  const codes = codesFor(({ assertionMap }) => {
    assertionMap.assertions[1].assertionId = assertionMap.assertions[0].assertionId;
  });
  assert.ok(codes.includes("MAP_DUPLICATE_ID"));
});

test("rejects duplicate or out-of-order fixture case IDs", () => {
  const codes = codesFor(({ fixturePlan }) => {
    fixturePlan.cases[1].id = fixturePlan.cases[0].id;
  });
  assert.ok(codes.includes("FIXTURE_CASE_DUPLICATE"));
  assert.ok(codes.includes("FIXTURE_CASE_ORDER"));
});

test("rejects a missing case ID constraint in report schema", () => {
  const codes = codesFor(({ reportSchema }) => {
    reportSchema.properties.cases.allOf = reportSchema.properties.cases.allOf
      .filter((clause) => clause.contains?.properties?.id?.const !== "P15");
  });
  assert.ok(codes.includes("SCHEMA_CASE_EXACTLY_ONCE"));
});

test("requires cases to be present in every report", () => {
  const codes = codesFor(({ reportSchema }) => {
    reportSchema.required = reportSchema.required.filter((key) => key !== "cases");
  });
  assert.ok(codes.includes("SCHEMA_CASES_REQUIRED"));
});

test("requires an object report at the schema root", () => {
  const codes = codesFor(({ reportSchema }) => {
    reportSchema.type = "array";
  });
  assert.ok(codes.includes("SCHEMA_ROOT_TYPE"));
});

test("requires Draft 2020-12 for exact case occurrence constraints", () => {
  const codes = codesFor(({ reportSchema }) => {
    reportSchema.$schema = "http://json-schema.org/draft-04/schema#";
  });
  assert.ok(codes.includes("SCHEMA_DIALECT"));
});

test("rejects duplicate case ID constraints in report schema", () => {
  const codes = codesFor(({ reportSchema }) => {
    const clauses = reportSchema.properties.cases.allOf;
    clauses.push(clone(clauses.find((clause) => clause.contains?.properties?.id?.const === "P01")));
  });
  assert.ok(codes.includes("SCHEMA_CASE_EXACTLY_ONCE"));
});

test("rejects a schema case constraint that allows more than one occurrence", () => {
  const codes = codesFor(({ reportSchema }) => {
    const clause = reportSchema.properties.cases.allOf
      .find((item) => item.contains?.properties?.id?.const === "P21");
    clause.maxContains = 2;
  });
  assert.ok(codes.includes("SCHEMA_CASE_EXACTLY_ONCE"));
});

test("requires both G0 observation gates to remain planned and NOT_RUN", () => {
  const codes = codesFor(({ fixturePlan }) => {
    fixturePlan.g0RuntimeGates[0].executionStatus = "PASS";
  });
  assert.ok(codes.includes("G0_EXECUTION_STATE"));
});

test("rejects execution or evidence status in the preparation assertion map", () => {
  const codes = codesFor(({ assertionMap }) => {
    assertionMap.assertions[0].status = "PASS";
    assertionMap.assertions[0].evidence = ["invented.json"];
  });
  assert.ok(codes.includes("MAP_EXECUTION_STATE"));
});

test("keeps the fixture explicitly preflight-only", () => {
  const codes = codesFor(({ fixturePlan }) => {
    fixturePlan.executionStatus = "PASS";
  });
  assert.ok(codes.includes("PREPARATION_STATUS"));
});
