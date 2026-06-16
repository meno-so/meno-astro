/**
 * meno-astro — locale middleware factory.
 *
 * ── Why middleware (and not BaseLayout) ────────────────────────────────────────
 * In Astro, the `i18n(...)` calls in a *page body* execute in the page component's
 * render scope, NOT inside `BaseLayout`'s frontmatter — so BaseLayout cannot wrap them
 * in `runWithLocale`. Astro **middleware**, by contrast, wraps the whole page render per
 * request (SSR) / per prerender (static): `onRequest(context, next)` runs `next()` to
 * render the matched route, and anything we establish around that `next()` call is in
 * scope for the entire page + all its components.
 *
 * So the locale seam is: `onRequest = (ctx, next) =>
 *   runWithLocale(deriveLocale(ctx, config), config, () => next())`. The
 * `AsyncLocalStorage` context that `runWithLocale` opens is then read by every `i18n()`
 * call anywhere in that render tree (see `runtime/i18n.ts`).
 *
 * This module exports a **pure, testable factory** `createLocaleMiddleware(config)` plus
 * the `deriveLocale` policy it uses. The actual module Astro injects
 * (`runtime/localeMiddleware.ts`) wraps this factory, loading the project config once.
 *
 * ── Typing without the `astro` dependency ──────────────────────────────────────
 * `meno-astro` does not (yet) depend on `astro`, and no Astro toolchain is wired into
 * this package's test/type-check. Rather than import `MiddlewareHandler` /
 * `APIContext` from `astro` (which would not resolve here), we type against a **minimal
 * structural slice** of Astro's documented middleware contract:
 *   - `context.currentLocale?: string`  — Astro's own i18n-routing answer.
 *   - `context.url?: URL`               — the request URL (for path-prefix fallback).
 *   - `next(): Promise<Response> | Response` — render the matched route.
 * Astro's real `MiddlewareHandler` is assignable to this shape, so the injected module
 * (`onRequest`) is correct-by-design against the documented API. The unit tests drive a
 * mock context with exactly this surface.
 */

import { runWithLocale, localeFromAstro } from './i18n';
import type { I18nConfig } from 'meno-core/shared';

/**
 * The minimal slice of Astro's middleware `APIContext` this middleware reads.
 * Astro's real `APIContext` is structurally assignable to this.
 */
export interface LocaleMiddlewareContext {
  /** Astro's resolved locale for the current route (from its native i18n routing). */
  currentLocale?: string | null;
  /** The request URL — used for the `/pl/…` path-prefix fallback. */
  url?: URL | { pathname?: string } | null;
}

/**
 * The minimal slice of Astro's `MiddlewareHandler` signature this factory returns.
 * `next` renders the matched route and yields its `Response`; the return value of the
 * handler is that same `Response`. Astro's real `MiddlewareHandler` is assignable here.
 */
export type LocaleMiddleware = (
  context: LocaleMiddlewareContext,
  next: () => Promise<Response> | Response,
) => Promise<Response> | Response;

/**
 * Derive the active locale for a request from its Astro context, against `config`:
 *   1. `context.currentLocale` — trust Astro's native i18n routing when it has an answer,
 *   2. else `localeFromAstro(context, config)` — the `/<locale>/…` URL path-prefix
 *      (which itself falls back to `config.defaultLocale`),
 *   3. else `config.defaultLocale` — a final guard (e.g. a falsy `currentLocale` AND a
 *      missing/blank URL).
 *
 * Exported for direct unit testing of the policy in isolation.
 */
export function deriveLocale(context: LocaleMiddlewareContext, config: I18nConfig): string {
  if (context?.currentLocale) return context.currentLocale;
  // localeFromAstro reads `{ currentLocale, url: { pathname } }`; our context matches.
  const fromAstro = localeFromAstro(
    context as { currentLocale?: string | null; url?: { pathname?: string } | null },
    config,
  );
  return fromAstro || config.defaultLocale;
}

/**
 * Build a locale middleware bound to a concrete {@link I18nConfig}. The returned handler
 * derives the request's locale (via {@link deriveLocale}) and runs the rest of the render
 * (`next`) inside `runWithLocale(locale, config, …)`, so every `i18n()` call in the page +
 * its components resolves to that locale.
 *
 * Pure and synchronous to construct (no filesystem / no Astro coupling), so a test can
 * call it with a mock `context` + mock `next` and assert end-to-end resolution.
 */
export function createLocaleMiddleware(config: I18nConfig): LocaleMiddleware {
  return (context, next) => {
    const locale = deriveLocale(context ?? {}, config);
    return runWithLocale(locale, config, () => next());
  };
}
