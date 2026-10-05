/** @typedef {'auth' | 'devices' | 'workspaces' | 'keys' | 'sync' | 'attachments' | 'usage' | 'billing'} ServerModuleId */

/** @type {ReadonlyArray<ServerModuleId>} */
export const SERVER_MODULE_IDS = Object.freeze([
  'auth',
  'devices',
  'workspaces',
  'keys',
  'sync',
  'attachments',
  'usage',
  'billing',
]);

/** @type {ReadonlyArray<Readonly<{ id: ServerModuleId; enabled: false }>>} */
export const SERVER_MODULES = Object.freeze(
  SERVER_MODULE_IDS.map((id) => Object.freeze({ id, enabled: false })),
);

/**
 * Return the stable disabled-feature result used until a module is implemented.
 * This registry intentionally provides no success path or persistent side effect.
 * @param {string} moduleId
 */
export function invokeServerModule(moduleId) {
  const registeredModule = SERVER_MODULES.find((module) => module.id === moduleId);

  return {
    ok: false,
    error: {
      code: 'FEATURE_NOT_ENABLED',
      module: registeredModule?.id ?? null,
    },
  };
}
