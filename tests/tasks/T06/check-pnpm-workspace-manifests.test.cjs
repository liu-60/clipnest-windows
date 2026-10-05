const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const repoRoot = path.resolve(__dirname, '../../..');
const checkerPath = path.join(repoRoot, 'scripts/check-pnpm-workspace-manifests.cjs');
const appNames = new Map([
  ['desktop', '@clipnest/desktop'],
  ['web', '@clipnest/web'],
  ['mobile', '@clipnest/mobile'],
  ['server', '@clipnest/server'],
]);
const fixtureRoots = [];

function createFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clipnest-t06-workspace-'));
  fixtureRoots.push(fixtureRoot);
  fs.writeFileSync(path.join(fixtureRoot, 'pnpm-workspace.yaml'), 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  writeManifest(fixtureRoot, 'package.json', 'clipnest-fixture');

  for (const [app, name] of appNames) {
    writeManifest(fixtureRoot, `apps/${app}/package.json`, name);
  }
  writeManifest(fixtureRoot, 'packages/contracts/package.json', '@clipnest/contracts');
  return fixtureRoot;
}

function writeManifest(fixtureRoot, relativePath, name) {
  const manifestPath = path.join(fixtureRoot, relativePath);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify({ name, private: true }, null, 2)}\n`);
}

function runChecker(fixtureRoot) {
  return spawnSync(process.execPath, [checkerPath, '--repo-root', fixtureRoot], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

after(() => {
  for (const fixtureRoot of fixtureRoots) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('accepts the four fixed app identities and unique workspace names', () => {
  const fixtureRoot = createFixture();
  const result = runChecker(fixtureRoot);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.result, 'PASS_MANIFEST_DISCOVERY_ONLY');
  for (const [app, name] of appNames) {
    assert.ok(report.packages.some((pkg) => pkg.manifest === `apps/${app}/package.json` && pkg.name === name));
  }
});

test('uses the current repository when no fixture root is provided', () => {
  const result = spawnSync(process.execPath, [checkerPath], { cwd: repoRoot, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  for (const [app, name] of appNames) {
    assert.ok(report.packages.some((pkg) => pkg.manifest === `apps/${app}/package.json` && pkg.name === name));
  }
});

test('rejects a missing registered app manifest', () => {
  const fixtureRoot = createFixture();
  fs.rmSync(path.join(fixtureRoot, 'apps/mobile/package.json'));
  const result = runChecker(fixtureRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no package\.json: apps[\\/]mobile/);
});

test('rejects a registered app manifest with the wrong package name', () => {
  const fixtureRoot = createFixture();
  writeManifest(fixtureRoot, 'apps/desktop/package.json', '@clipnest/renamed');
  const result = runChecker(fixtureRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /apps\/desktop\/package\.json must be named @clipnest\/desktop/);
});

test('rejects a package name duplicated by another workspace manifest', () => {
  const fixtureRoot = createFixture();
  writeManifest(fixtureRoot, 'packages/contracts/package.json', '@clipnest/web');
  const result = runChecker(fixtureRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate package name @clipnest\/web/);
});
