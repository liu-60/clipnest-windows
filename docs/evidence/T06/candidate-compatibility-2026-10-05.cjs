const fs = require("node:fs");
const z = require("zod");
const Ajv2020 = require("ajv/dist/2020").default;

const Nested = z.strictObject({ code: z.string().min(1) });
const Root = z.strictObject({
  protocol: z.literal(1),
  enabled: z.literal(true),
  numericConst: z.literal(7),
  decimalId: z.string().regex(/^(0|[1-9][0-9]*)$/),
  nested: Nested
});

const schema = z.toJSONSchema(Root, { target: "draft-2020-12" });
const nestedSchema = schema.properties.nested;
schema.properties.nested = { $ref: "#/$defs/Nested" };
schema.$defs = Object.assign({}, schema.$defs, { Nested: nestedSchema });

const valid = {
  protocol: 1,
  enabled: true,
  numericConst: 7,
  decimalId: "9007199254740993",
  nested: { code: "A1" }
};
const withoutProtocol = Object.assign({}, valid);
delete withoutProtocol.protocol;
const cases = [
  { id: "valid", value: valid },
  { id: "protocol-missing", value: withoutProtocol },
  { id: "boolean-const-mismatch", value: Object.assign({}, valid, { enabled: false }) },
  { id: "numeric-const-mismatch", value: Object.assign({}, valid, { numericConst: 8 }) },
  { id: "root-extra", value: Object.assign({}, valid, { extra: true }) },
  { id: "nested-extra", value: Object.assign({}, valid, { nested: { code: "A1", extra: true } }) },
  { id: "nested-missing-code", value: Object.assign({}, valid, { nested: {} }) }
];

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validate = ajv.compile(schema);
const observations = cases.map(({ id, value }) => {
  const zod = Root.safeParse(value);
  const ajvAccepted = validate(value);
  const errors = (validate.errors || []).map((error) => ({
    instancePath: error.instancePath,
    keyword: error.keyword,
    params: error.params
  }));
  return {
    id,
    zodAccepted: zod.success,
    zodIssues: zod.success ? [] : zod.error.issues.map((issue) => ({
      path: issue.path,
      code: issue.code
    })),
    ajvAccepted,
    ajvErrors: errors
  };
});

const expectedAccepted = {
  valid: true,
  "protocol-missing": false,
  "boolean-const-mismatch": false,
  "numeric-const-mismatch": false,
  "root-extra": false,
  "nested-extra": false,
  "nested-missing-code": false
};
for (const observation of observations) {
  const expected = expectedAccepted[observation.id];
  if (observation.zodAccepted !== expected || observation.ajvAccepted !== expected) {
    throw new Error("accept/reject mismatch in " + observation.id);
  }
}
const expectedErrors = {
  "protocol-missing": { instancePath: "", keyword: "required" },
  "boolean-const-mismatch": { instancePath: "/enabled", keyword: "const" },
  "numeric-const-mismatch": { instancePath: "/numericConst", keyword: "const" },
  "root-extra": { instancePath: "", keyword: "additionalProperties" },
  "nested-extra": { instancePath: "/nested", keyword: "additionalProperties" },
  "nested-missing-code": { instancePath: "/nested", keyword: "required" }
};
for (const [caseId, expected] of Object.entries(expectedErrors)) {
  const observation = observations.find((entry) => entry.id === caseId);
  if (!observation.ajvErrors.some((error) =>
    error.instancePath === expected.instancePath && error.keyword === expected.keyword
  )) {
    throw new Error("expected Ajv error path/keyword missing for " + caseId);
  }
}
const decimalRoundTrip = JSON.parse(JSON.stringify(valid)).decimalId;
if (typeof decimalRoundTrip !== "string" || decimalRoundTrip !== "9007199254740993") {
  throw new Error("decimal string > 2^53 changed during JSON round-trip");
}

fs.writeFileSync("schema.json", JSON.stringify(schema, null, 2) + "\n");
fs.writeFileSync("probe-results.json", JSON.stringify({
  assertionsPassed: true,
  zodVersion: require("zod/package.json").version,
  ajvVersion: require("ajv/package.json").version,
  schemaDialect: schema.$schema,
  schemaHasRootAdditionalPropertiesFalse: schema.additionalProperties === false,
  schemaHasNestedRef: schema.properties.nested.$ref,
  schemaHasNestedAdditionalPropertiesFalse: schema.$defs.Nested.additionalProperties === false,
  schemaConstValues: {
    protocol: schema.properties.protocol.const,
    enabled: schema.properties.enabled.const,
    numericConst: schema.properties.numericConst.const
  },
  decimalStringRoundTrip: {
    value: decimalRoundTrip,
    type: typeof decimalRoundTrip,
    exact: true
  },
  cases: observations
}, null, 2) + "\n");