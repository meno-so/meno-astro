/**
 * SSR page helpers — the single source of truth for "is this page an SSR (dynamic) page?"
 * and the derived `loadPageData` frontmatter boilerplate. The runtime sibling of
 * `cmsRoute.ts`: a CMS template page is parameterized over a content collection, an SSR
 * page over a live per-request fetch.
 *
 * An SSR page is a normal page model whose `meta.source === 'ssr'` and which carries a
 * `meta.data` config (named declarative data sources). Its body binds the fetched data via
 * `{{<source>.field}}` templates; on disk it becomes an on-demand route
 * (`export const prerender = false`) whose frontmatter destructures the sources from
 * `loadPageData(meta.data, Astro)`. See docs/meno-astro-ssr-page-type.md.
 */

/** Minimal shape of the `meta.data` config this module reads. */
export interface SsrDataMetaLike {
  sources?: Record<string, unknown>;
}

interface PageLike {
  meta?: { source?: unknown; data?: SsrDataMetaLike; routeParams?: unknown } | Record<string, unknown>;
}

/** True when `page` is an SSR page (`meta.source === 'ssr'` + a `meta.data` config). */
export function isSsrPage(page: unknown): page is { meta: { source: 'ssr'; data: SsrDataMetaLike } } {
  if (!page || typeof page !== 'object') return false;
  const meta = (page as PageLike).meta as Record<string, unknown> | undefined;
  return !!meta && meta.source === 'ssr' && !!meta.data && typeof meta.data === 'object';
}

/** The data-source names declared on an SSR page's `meta.data.sources` (in declared order). */
export function ssrSourceNames(data: SsrDataMetaLike | undefined): string[] {
  const sources = data?.sources;
  if (!sources || typeof sources !== 'object') return [];
  return Object.keys(sources);
}

/**
 * The `const { … } = await loadPageData(meta.data, Astro);` destructure for an SSR page —
 * deterministic, derived solely from the source names. Emit-only: the parser recognizes and
 * SKIPS it (frontmatterScan), regenerating it from `meta.data`. References `meta`, so the
 * emitter places it AFTER `const meta = …`.
 */
export function buildLoadPageData(names: string[]): string {
  const destructure = names.length ? `{ ${names.join(', ')} }` : '{}';
  return `const ${destructure} = await loadPageData(meta.data, Astro);`;
}

/**
 * Declared dynamic-route param names (`meta.routeParams`) for an SSR page that lives at a
 * `[param]` path — non-empty ⇒ the page is a dynamic route. Used to emit the `params` scope.
 */
export function ssrRouteParams(meta: { routeParams?: unknown } | undefined): string[] {
  const p = meta?.routeParams;
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * The `const params = Astro.params;` boilerplate that exposes the dynamic-route params to the
 * body (`{{params.slug}}`). Emit-only (frontmatterScan covers it, the parser regenerates it
 * from `meta.routeParams`). The whole object is bound (param names are informational), so this
 * is constant regardless of which params are declared.
 */
export const SSR_PARAMS_CONST = 'const params = Astro.params;';
