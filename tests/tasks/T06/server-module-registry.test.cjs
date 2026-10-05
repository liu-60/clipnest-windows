const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const modulePath = path.resolve(__dirname, '../../../apps/server/src/modules/index.ts');
const moduleSource = fs.readFileSync(modulePath, 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`;

test('registers the planned server modules as explicitly disabled', async () => {
  const { SERVER_MODULE_IDS, SERVER_MODULES } = await import(moduleUrl);

  assert.deepEqual(SERVER_MODULE_IDS, [
    'auth',
    'devices',
    'workspaces',
    'keys',
    'sync',
    'attachments',
    'usage',
    'billing',
  ]);
  assert.deepEqual(SERVER_MODULES, SERVER_MODULE_IDS.map((id) => ({ id, enabled: false })));
  assert.equal(Object.isFrozen(SERVER_MODULE_IDS), true);
  assert.equal(Object.isFrozen(SERVER_MODULES), true);
  assert.ok(SERVER_MODULES.every(Object.isFrozen));
});

test('returns FEATURE_NOT_ENABLED for each registered module without success data', async () => {
  const { SERVER_MODULE_IDS, invokeServerModule } = await import(moduleUrl);

  for (const moduleId of SERVER_MODULE_IDS) {
    const result = invokeServerModule(moduleId);

    assert.deepEqual(result, {
      ok: false,
      error: { code: 'FEATURE_NOT_ENABLED', module: moduleId },
    });
    assert.equal('data' in result, false);
  }
});

test('fails closed for unknown module names and does not reuse mutable results', async () => {
  const { invokeServerModule } = await import(moduleUrl);
  const first = invokeServerModule('unknown');

  assert.deepEqual(first, {
    ok: false,
    error: { code: 'FEATURE_NOT_ENABLED', module: null },
  });
  first.error.code = 'MUTATED_BY_CALLER';

  assert.deepEqual(invokeServerModule('auth'), {
    ok: false,
    error: { code: 'FEATURE_NOT_ENABLED', module: 'auth' },
  });
});
