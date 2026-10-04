const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../../..");
const testsRoot = path.join(repositoryRoot, "tests");
const groups = process.argv.slice(2).filter((argument) => argument !== "--");

function collectTests(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTests(target);
    return entry.isFile() && entry.name.endsWith(".test.cjs") ? [target] : [];
  });
}

const allTests = collectTests(testsRoot).sort();
const selectedTests = groups.length === 0
  ? allTests
  : allTests.filter((file) => groups.some((group) => {
    const normalizedPath = file.toLowerCase().replace(/\\/g, "/");
    const normalizedGroup = group.toLowerCase().replace(/\\/g, "/");
    return normalizedPath.includes(`/${normalizedGroup}/`) || path.basename(file).toLowerCase().includes(normalizedGroup);
  }));

if (selectedTests.length === 0) {
  process.stderr.write(`No unit tests matched groups: ${groups.join(", ") || "all"}\n`);
  process.exit(2);
}

const result = spawnSync(process.execPath, ["--test", ...selectedTests], {
  cwd: repositoryRoot,
  stdio: "inherit",
});
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
