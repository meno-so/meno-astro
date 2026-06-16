/**
 * meno-astro — the injected locale-middleware entrypoint.
 *
 * This is the module the `meno()` integration points Astro at via
 * `addMiddleware({ entrypoint: 'meno-astro/runtime/localeMiddleware', order: 'pre' })`.
 * Astro imports it once and calls its `onRequest` export around every page render
 * (request for SSR, prerender for static), so the `runWithLocale(...)` context it opens
 * is in scope for the whole page + all its components — see `runtime/middleware.ts` for
 * the architecture rationale.
 *
 * Config is loaded **once at module load** from the project root (`process.cwd()`, which
 * Astro sets to the project directory during build/dev) via `loadI18nConfig`, then the
 * pure `createLocaleMiddleware` factory is bound to it. Loading once (not per request) is
 * correct: the project's i18n config is static for the lifetime of a build/server.
 *
 * `onRequest` is the name Astro's `addMiddleware`/`defineMiddleware` contract expects for
 * a middleware module's handler export.
 */

import { createLocaleMiddleware } from './middleware';
import { loadI18nConfig } from '../server/loadI18nConfig';

// Resolve config from the project root once. `process.cwd()` is the Astro project dir
// during `astro build` / `astro dev`; a missing/legacy config degrades to defaults inside
// `loadI18nConfig`, so this never throws at import time.
const config = loadI18nConfig(process.cwd());

/** Astro middleware handler — establishes the per-render locale context. */
export const onRequest = createLocaleMiddleware(config);
