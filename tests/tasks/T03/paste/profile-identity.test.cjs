const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");
const { createNativeHelperEnvironment } = require("../../../../dist-electron/main/native/profile-identity.js");

test("helper profile identity is stable and overrides inherited untrusted values", () => {
  const userDataPath = "C:\\Users\\Alice\\AppData\\Roaming\\ClipNest";
  const env = createNativeHelperEnvironment(userDataPath, {
    PATH: "safe-path",
    CLIPNEST_STABLE_PROFILE_ID: "f".repeat(64),
  });
  const expected = createHash("sha256").update(userDataPath.toLowerCase(), "utf8").digest("hex");
  assert.equal(env.CLIPNEST_STABLE_PROFILE_ID, expected);
  assert.match(env.CLIPNEST_STABLE_PROFILE_ID, /^[0-9a-f]{64}$/);
  assert.equal(env.PATH, "safe-path");
  assert.throws(() => createNativeHelperEnvironment("relative\\profile", {}), /native_profile_path_invalid/);
});
