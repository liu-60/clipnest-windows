const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const packagePath = path.resolve(__dirname, '../../../apps/server/package.json');

test('server package points to an ESM entry without adding dependencies', () => {
  const packageJson = require(packagePath);

  assert.equal(packageJson.name, '@clipnest/server');
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.type, 'module');
  assert.equal(packageJson.main, './src/main.ts');
  assert.deepEqual(Object.keys(packageJson).sort(), ['main', 'name', 'private', 'type']);
});

test('server entry composes the existing disabled module registry', async () => {
  const entryPath = path.resolve(__dirname, '../../../apps/server/src/main.ts');
  const { serverApp } = await import(pathToFileURL(entryPath));

  assert.equal(typeof serverApp.invokeModule, 'function');
  for (const moduleId of [
    'auth',
    'devices',
    'workspaces',
    'keys',
    'sync',
    'attachments',
    'usage',
    'billing',
  ]) {
    assert.deepEqual(serverApp.invokeModule(moduleId), {
      ok: false,
      error: { code: 'FEATURE_NOT_ENABLED', module: moduleId },
    });
  }
  assert.deepEqual(serverApp.invokeModule('unknown'), {
    ok: false,
    error: { code: 'FEATURE_NOT_ENABLED', module: null },
  });
});
