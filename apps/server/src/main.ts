import { createServerApp } from './app.ts';

/** Entry composition only; no network listener is started. */
export const serverApp = createServerApp();
