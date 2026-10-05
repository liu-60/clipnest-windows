import { invokeServerModule } from './modules/index.ts';

/**
 * Compose the server boundary from the disabled module registry.
 * This slice deliberately adds no routes, listeners, or persistent effects.
 */
export function createServerApp() {
  return Object.freeze({
    invokeModule: invokeServerModule,
  });
}
