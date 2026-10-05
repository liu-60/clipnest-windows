const fs = require('node:fs');
const path = require('node:path');

const defaultRepoRoot = path.resolve(__dirname, '..');
const requiredGlobs = ['apps/*', 'packages/*'];
const requiredAppNames = new Map([
  ['apps/desktop/package.json', '@clipnest/desktop'],
  ['apps/web/package.json', '@clipnest/web'],
  ['apps/mobile/package.json', '@clipnest/mobile'],
  ['apps/server/package.json', '@clipnest/server'],
]);

function fail(message) {
  console.error(`workspace manifest check failed: ${message}`);
  process.exitCode = 1;
}

function resolveRepoRoot(args) {
  if (args.length === 0) return defaultRepoRoot;
  if (args.length === 2 && args[0] === '--repo-root' && args[1].trim()) {
    return path.resolve(args[1]);
  }
  throw new Error('usage: node scripts/check-pnpm-workspace-manifests.cjs [--repo-root <path>]');
}

function readWorkspaceGlobs(workspaceFile) {
  const source = fs.readFileSync(workspaceFile, 'utf8');
  const lines = source.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => /^packages:\s*(?:#.*)?$/.test(line));

  if (sectionIndex < 0) {
    throw new Error('pnpm-workspace.yaml has no simple packages: section');
  }

  const globs = [];
  for (let index = sectionIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;

    const match = line.match(/^\s*-\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*(?:#.*)?$/);
    if (!match) throw new Error(`unsupported workspace package entry: ${line.trim()}`);
    globs.push(match[1] ?? match[2] ?? match[3]);
  }

  for (const glob of globs) {
    if (!/^(apps|packages)\/\*$/.test(glob)) {
      throw new Error(`unsupported workspace glob: ${glob}`);
    }
  }

  for (const required of requiredGlobs) {
    if (!globs.includes(required)) throw new Error(`required workspace glob is missing: ${required}`);
  }

  return globs;
}

function manifestPaths(repoRoot, globs) {
  const paths = new Set([path.join(repoRoot, 'package.json')]);

  for (const glob of globs) {
    const parent = path.join(repoRoot, glob.slice(0, -2));
    if (!fs.existsSync(parent)) continue;

    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      paths.add(path.join(parent, entry.name, 'package.json'));
    }
  }

  for (const relativePath of requiredAppNames.keys()) {
    paths.add(path.join(repoRoot, relativePath));
  }

  return [...paths].sort((left, right) => left.localeCompare(right));
}

function inspectManifests(repoRoot, paths) {
  const seenNames = new Map();
  const packages = [];

  for (const manifestPath of paths) {
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`workspace package directory has no package.json: ${path.relative(repoRoot, path.dirname(manifestPath))}`);
    }

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw new Error(`cannot parse ${path.relative(repoRoot, manifestPath)}: ${error.message}`);
    }

    if (!manifest || typeof manifest.name !== 'string' || !manifest.name.trim()) {
      throw new Error(`${path.relative(repoRoot, manifestPath)} has no non-empty package name`);
    }

    const relativePath = path.relative(repoRoot, manifestPath).split(path.sep).join('/');
    const expectedName = requiredAppNames.get(relativePath);
    if (expectedName && manifest.name !== expectedName) {
      throw new Error(`${relativePath} must be named ${expectedName} (found ${manifest.name})`);
    }

    const previousPath = seenNames.get(manifest.name);
    if (previousPath) {
      throw new Error(`duplicate package name ${manifest.name}: ${previousPath} and ${relativePath}`);
    }

    seenNames.set(manifest.name, relativePath);
    packages.push({ name: manifest.name, manifest: relativePath, private: manifest.private === true });
  }

  return packages;
}

try {
  const repoRoot = resolveRepoRoot(process.argv.slice(2));
  const workspaceFile = path.join(repoRoot, 'pnpm-workspace.yaml');
  const globs = readWorkspaceGlobs(workspaceFile);
  const packages = inspectManifests(repoRoot, manifestPaths(repoRoot, globs));
  process.stdout.write(`${JSON.stringify({ result: 'PASS_MANIFEST_DISCOVERY_ONLY', globs, packages }, null, 2)}\n`);
} catch (error) {
  fail(error.message);
}
