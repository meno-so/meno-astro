/**
 * meno-astro — i18n runtime resolver.
 *
 * Emitted `.astro` markup carries i18n values verbatim and wraps them in a single-arg
 * `i18n({ _i18n: true, en: "About", pl: "O nas" })` call (see the dialect spec §9). This
 * module implements that `i18n()` resolver plus the locale-context seam the future
 * `BaseLayout`/middleware will drive per route/locale.
 *
 * It reuses meno-core's primitives wholesale (`isI18nValue`, `resolveI18nValue`,
 * `extractLocaleFromPath`, `DEFAULT_I18N_CONFIG`) — no resolution logic is reinvented
 * here. The only new machinery is the `AsyncLocalStorage`-backed locale context.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { isI18nValue, resolveI18nValue, extractLocaleFromPath, DEFAULT_I18N_CONFIG } from 'meno-core/shared';
import type { I18nConfig, I18nValue } from 'meno-core/shared';

/** The per-render locale context: the active locale + the project's i18n config. */
export interface LocaleContextValue {
  locale: string;
  config: I18nConfig;
}

// ---------------------------------------------------------------------------
// Locale context store.
//
// SSR is concurrent: two requests for different locales can be in flight at once,
// so a plain module variable would race. `AsyncLocalStorage` (node:async_hooks)
// scopes the context to the async call tree of `runWithLocale`, so it survives the
// `await` boundaries of an async render and every `i18n()` call in that tree reads
// its own request's locale.
//
// ALS is a HARD dependency: it is unconditionally available in Node 18+ (this
// package's build target) and in Bun, so we import it statically and `store` is
// always defined. (An earlier version loaded it via `require('node:async_hooks')`
// in a try/catch with a synchronous module-variable fallback. In the published ESM
// bundle esbuild compiled that `require` to a shim that THREW, so the fallback took
// over — and because it restored its variable synchronously, before the async
// render promise resolved, every render leaked back to the default locale. The
// static import removes that failure mode and the fallback entirely.)
// ---------------------------------------------------------------------------

const store = new AsyncLocalStorage<LocaleContextValue>();

/**
 * Run `fn` with `{ locale, config }` as the active locale context. This is the seam the
 * future `BaseLayout`/middleware calls once per route/locale; everything rendered inside
 * (and `i18n()` calls within it) sees this locale. Returns `fn`'s return value.
 */
export function runWithLocale<T>(locale: string, config: I18nConfig, fn: () => T): T {
  return store.run({ locale, config }, fn);
}

/** Read the current locale context, or `undefined` if none is active. */
export function getLocaleContext(): LocaleContextValue | undefined {
  return store.getStore();
}

// ---------------------------------------------------------------------------
// Astro-global → locale derivation.
// ---------------------------------------------------------------------------

/** The slice of the Astro global this module reads. */
export interface AstroLike {
  currentLocale?: string | null;
  url?: { pathname?: string } | null;
}

/**
 * Derive the active locale from an Astro global:
 *   1. `astro.currentLocale` (Astro's own i18n routing answer), else
 *   2. the locale prefix on `astro.url.pathname` (e.g. `/pl/about` → `pl`), else
 *   3. `config.defaultLocale`.
 */
export function localeFromAstro(astro: AstroLike | null | undefined, config: I18nConfig): string {
  if (astro?.currentLocale) return astro.currentLocale;
  const pathname = astro?.url?.pathname;
  if (typeof pathname === 'string') {
    const { locale } = extractLocaleFromPath(pathname, config);
    if (locale) return locale;
  }
  return config.defaultLocale;
}

// ---------------------------------------------------------------------------
// i18n() — the emitter-facing resolver.
// ---------------------------------------------------------------------------

/**
 * Accepted second argument to `i18n()`. The single-arg call shape stays primary; this
 * override only narrows the locale/config when a caller already has them:
 *   - a bare locale string (`"pl"`),
 *   - `{ locale?, config? }`,
 *   - an Astro-like `{ currentLocale?, url? }` (normalized via `localeFromAstro`).
 */
export type I18nOverride = string | { locale?: string; config?: I18nConfig } | AstroLike;

/** Resolve `override` (if any) to a concrete `{ locale, config }`, falling back to context/defaults. */
function resolveLocaleAndConfig(override?: I18nOverride): LocaleContextValue {
  const ctx = getLocaleContext();
  const baseConfig = ctx?.config ?? DEFAULT_I18N_CONFIG;
  const baseLocale = ctx?.locale ?? baseConfig.defaultLocale;

  if (override === undefined) {
    return { locale: baseLocale, config: baseConfig };
  }

  if (typeof override === 'string') {
    return { locale: override, config: baseConfig };
  }

  // Plain { locale?, config? } override.
  if ('locale' in override || 'config' in override) {
    const config = override.config ?? baseConfig;
    const locale = override.locale ?? ctx?.locale ?? config.defaultLocale;
    return { locale, config };
  }

  // Astro-like override ({ currentLocale?, url? }).
  const config = baseConfig;
  return { locale: localeFromAstro(override as AstroLike, config), config };
}

/**
 * Resolve an i18n value to the active locale's string (or array, for list props).
 *
 * - Non-i18n values pass through unchanged (so the emitter can wrap any prop/attr/href
 *   value uniformly).
 * - i18n values resolve via meno-core's `resolveI18nValue` fallback chain
 *   (exact locale → defaultLocale → first available → empty string/array).
 * - Locale/config come from `override` if given, else the active `runWithLocale` context,
 *   else `DEFAULT_I18N_CONFIG`'s default locale — a no-context call never throws.
 *
 * Single-arg `i18n(value)` is the primary call shape; `override` is optional.
 */
export function i18n<V>(value: V, override?: I18nOverride): V extends I18nValue ? string | unknown[] : V;
export function i18n(value: unknown, override?: I18nOverride): unknown {
  if (!isI18nValue(value)) return value;
  const { locale, config } = resolveLocaleAndConfig(override);
  return resolveI18nValue(value, locale, config);
}
