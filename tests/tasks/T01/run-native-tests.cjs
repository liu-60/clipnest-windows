const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../../..");
const manifestPath = path.join(repositoryRoot, "native", "Cargo.toml");
const dryRun = process.argv.slice(2).includes("--dry-run");

if (!fs.existsSync(manifestPath)) {
  process.stderr.write("NOT_RUN: native/Cargo.toml is introduced by T02.\n");
  process.exit(2);
}

const result = spawnSync("cargo", ["test", "--manifest-path", manifestPath], {
  cwd: repositoryRoot,
  env: { ...process.env, CLIPNEST_NATIVE_DRY_RUN: dryRun ? "1" : "0" },
  stdio: "inherit",
});
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
