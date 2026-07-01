/**
 * meno-astro — locale route enumeration + locale-aware link helpers (pure).
 *
 * The fs-free half of meno-astro's i18n routing. `loadSlugMappings(projectRoot)`
 * (server) collects each page's `meta.slugs`; the functions here turn that `SlugMap[]`
 * into:
 *
 *   - the `getStaticPaths()` entries for the injected `/[locale]/[...path]` route
 *     (`LocaleRoute.astro`) — one path per (non-default locale × page), using the page's
 *     localized slug when it has one (SSR parity: every page exists in every locale),
 *     plus one per (non-default locale × published CMS item) carrying the item as
 *     `props.cms` (`enumerateCmsLocaleStaticPaths` over `loadCmsSlugMappings`),
 *   - hreflang alternate links for `BaseLayout` (`buildHreflangLinks` — the dialect twin
 *     of meno-core's `metaTagGenerator` hreflang block),
 *   - slug-translated locale-switcher items for `LocaleList` (`localeListItems`).
 *
 * Everything composes meno-core's slug translator (`buildSlugIndex`/`getLocaleLinks`/
 * `resolveSlugToPageId`) — no translation logic is reinvented here. Pure functions, no
 * filesystem, no Astro coupling: unit-testable under bun:test (this package has no Astro
 * toolchain; the `.astro` consumers stay thin shells over these).
 */

import {
  buildSlugIndex,
  getLocaleLinks,
  resolveSlugToPageId,
  extractLocaleFromPath,
  resolveI18nInProps,
} from 'meno-core/shared';
import type { I18nConfig } from 'meno-core/shared';
import type { SlugMap, LocaleLink } from 'meno-core/shared';

/**
 * A `SlugMap` whose `slugs` may carry the CMS loader's exactness marker.
 *
 * Pages and CMS items advertise locales differently, and the difference is real build
 * output, not taste:
 *   - PAGE maps may omit a locale; the page is still BUILT there (the locale route's
 *     page enumeration falls back to the default slug — every page exists in every
 *     locale, SSR parity). Fallback-advertising `/de/about` is therefore correct.
 *   - CMS item maps (`loadCmsSlugMappings`) list EXACTLY the locales the item is
 *     published in: every non-draft locale gets an explicit (fallback-resolved) entry,
 *     and a locale hidden via `_draftLocales` is omitted — that URL is deliberately
 *     never built, so advertising a fallback URL for it would point crawlers at a 404.
 *
 * `exactLocales: true` tells `buildHreflangLinks` to trust the entry's key set as the
 * complete list of existing locale variants instead of applying the page fallback.
 */
export interface CmsAwareSlugMap extends SlugMap {
  exactLocales?: boolean;
}

/**
 * One CMS item as the locale route consumes it — produced by `loadCmsSlugMappings`
 * (server; fs + mtime cache) and enumerated by {@link enumerateCmsLocaleStaticPaths}
 * (pure). Defined here, next to its consumer, so the pure half stays fs-free.
 */
export interface CmsSlugEntry {
  /**
   * The item's merged-map entry: `pageId` is its default-locale URL path
   * (`blog/my-post`), `slugs` are FULL path-after-locale slugs per published locale
   * (`{ en: "blog/my-post", pl: "blog/moj-post" }`), `exactLocales` is always true.
   */
  map: CmsAwareSlugMap;
  /**
   * The CMS TEMPLATE's module id in `pageModuleKey` form — e.g. `"blog/[slug]"` →
   * `/src/pages/blog/[slug].astro`. The locale route renders the TEMPLATE module for
   * every localized item URL (`props.pageId` carries this, not the item's pageId).
   */
  templateId: string;
  /** The raw stored item JSON (i18n values unresolved; resolved per locale at enumeration). */
  item: Record<string, unknown>;
}

/**
 * One `getStaticPaths()` entry of the injected locale route. `params.path` is the rest
 * segment after `/[locale]/` — `undefined` encodes the empty rest param (Astro's required
 * shape for `/pl/`). `props.pageId` tells `LocaleRoute.astro` which page module to render,
 * so the component never reverse-looks-up slugs. CMS item entries additionally carry
 * `props.cms` (the locale-resolved item) and point `pageId` at the item's TEMPLATE module.
 */
export interface LocaleStaticPath {
  params: { locale: string; path: string | undefined };
  props: { pageId: string; cms?: Record<string, unknown> };
}

/**
 * Enumerate every (non-default locale × page) route the injected `/[locale]/[...path]`
 * route serves. Slug preference per page+locale mirrors `translatePath`'s chain:
 * the locale's own slug → the default locale's slug → `_default` (slugless pages) →
 * the pageId itself. The default locale is never enumerated (it lives un-prefixed,
 * `prefixDefaultLocale: false`). Single-locale configs yield `[]` (the integration also
 * skips injecting the route then — defense in depth).
 */
export function enumerateLocaleStaticPaths(mappings: SlugMap[], config: I18nConfig): LocaleStaticPath[] {
  if (!config.locales || config.locales.length <= 1) return [];
  const paths: LocaleStaticPath[] = [];
  for (const { code } of config.locales) {
    if (code === config.defaultLocale) continue;
    for (const { pageId, slugs } of mappings) {
      const slug = (
        slugs[code] ??
        slugs[config.defaultLocale] ??
        slugs._default ??
        (pageId === 'index' ? '' : pageId)
      ).replace(/^\/+/, '');
      paths.push({
        params: { locale: code, path: slug === '' ? undefined : slug },
        props: { pageId },
      });
    }
  }
  return paths;
}

/**
 * Enumerate every (non-default locale × published CMS item) route the injected
 * `/[locale]/[...path]` route serves — the CMS twin of
 * {@link enumerateLocaleStaticPaths}, with two deliberate differences:
 *
 *   - **No fallback chain.** Only locales explicitly present in the entry's slug map
 *     are enumerated. The loader already resolved fallbacks into explicit entries
 *     (`resolveI18nValue`: locale → default → first available — JSON static-build
 *     parity, `buildCMSItemPath`), so an absent locale means *hidden for that locale*
 *     (`_draftLocales`) and must not be built. This is also what makes the
 *     default-slug-under-prefix URL (`/pl/blog/my-post` when a `pl` slug exists) 404 —
 *     canonical URLs only, the same policy as pages.
 *   - **Props carry the item.** Each entry renders the CMS TEMPLATE module
 *     (`props.pageId = entry.templateId`, e.g. `blog/[slug]`) with `props.cms` set to
 *     the item resolved for the target locale (`resolveI18nInProps` — the SSR
 *     renderer's per-locale CMS value resolution) plus the JSON build's `_url`
 *     convention (the UNprefixed localized item path, `/blog/moj-post`).
 *
 * The default locale is never enumerated here: the template's own emitted
 * `getStaticPaths()` boilerplate serves it (static file routes outrank this route).
 */
export function enumerateCmsLocaleStaticPaths(entries: CmsSlugEntry[], config: I18nConfig): LocaleStaticPath[] {
  if (!config.locales || config.locales.length <= 1) return [];
  const paths: LocaleStaticPath[] = [];
  for (const { code } of config.locales) {
    if (code === config.defaultLocale) continue;
    for (const entry of entries) {
      const slug = entry.map.slugs[code];
      if (!slug) continue; // hidden for this locale (draft) → deliberately not built
      paths.push({
        params: { locale: code, path: slug },
        props: {
          pageId: entry.templateId,
          cms: {
            ...resolveI18nInProps(entry.item, code, config),
            _url: `/${slug}`,
          },
        },
      });
    }
  }
  return paths;
}

/**
 * The 404 page's route segment AND pageId (`src/pages/404.astro` → route `/404`).
 * Shared by {@link enumerate404LocaleStaticPaths} and its consumers so the magic
 * string exists exactly once.
 */
export const NOT_FOUND_PAGE_ID = '404';

/**
 * Enumerate the localized twins of the project's `src/pages/404.astro` — one
 * `/[locale]/404` entry per non-default locale, so a static build emits
 * `dist/pl/404/index.html` rendered in the `pl` locale context (the URL prefix drives
 * the middleware/`Astro.currentLocale` exactly like every other locale-route render).
 * Without these, a multi-locale static build ships exactly ONE `dist/404.html`,
 * prerendered at `/404` = the default locale — a Polish visitor's 404 is English.
 *
 * `has404Page` is the server-side existence check (`src/pages/404.astro` on disk,
 * see `loadSlugMappings.has404Page`), kept a parameter so this stays pure/fs-free
 * like the rest of this module. Without a 404 page there is nothing to localize —
 * `[]`, a zero-cost no-op (same for single-locale configs, where the locale route
 * isn't even injected).
 *
 * Why a SEPARATE enumerator instead of a slug-map entry: the slug map feeds every
 * *advertising* surface — hreflang alternates, the LocaleList switcher, sitemap
 * alternates, link translation — and an error URL must never be advertised on any of
 * them. Keeping 404 out of the map (it is excluded from the page scan) preserves that
 * invariant for free: `buildHreflangLinks('/pl/404', …)` resolves to no known page →
 * `[]`, and the sitemap's error-route exclusion drops the built `<locale>/404` paths.
 * `meta.slugs` on a 404 page is also meaningless — an error page has one canonical
 * name per locale (`/<locale>/404`), nothing slug-translatable.
 *
 * The DEFAULT locale is never enumerated: Astro itself builds `dist/404.html` from the
 * file route (its reserved error page). Static hosts then need locale-scoped 404 rules
 * to actually SERVE `/pl/404/index.html` for unmatched `/pl/*` URLs — those live in a
 * managed netlify.toml marker block (meno-core `shared/netlifyLocale404.ts`), written by
 * the converter scaffold and re-synced by the studio save-config route on locale changes.
 */
export function enumerate404LocaleStaticPaths(has404Page: boolean, config: I18nConfig): LocaleStaticPath[] {
  if (!has404Page || !config.locales || config.locales.length <= 1) return [];
  const paths: LocaleStaticPath[] = [];
  for (const { code } of config.locales) {
    if (code === config.defaultLocale) continue;
    paths.push({
      params: { locale: code, path: NOT_FOUND_PAGE_ID },
      props: { pageId: NOT_FOUND_PAGE_ID },
    });
  }
  return paths;
}

/**
 * The `import.meta.glob('/src/pages/**\/*.astro')` key for a pageId — the glob-key
 * normalization seam between `loadSlugMappings`' pageIds and `LocaleRoute.astro`'s
 * page-module map. Also used for CMS template ids (`blog/[slug]` →
 * `/src/pages/blog/[slug].astro` — bracket filenames are matched by the glob).
 */
export function pageModuleKey(pageId: string): string {
  return `/src/pages/${pageId}.astro`;
}

/**
 * De-duplicate locale-route entries by their `{locale, path}` params, keeping the
 * FIRST occurrence. `LocaleRoute.astro` concatenates three independent enumerations
 * (pages, CMS items, 404 twins) that CAN collide — e.g. a static page at
 * `blog/my-post.astro` next to a CMS item whose plain-string slug is `my-post`, or a
 * page whose locale slug is literally `404`. Astro's behavior for duplicate
 * getStaticPaths params is nondeterministic across dev/build, so the composition
 * order IS the precedence: pages > CMS items > 404 — mirroring the default-locale
 * world, where the static file route outranks the `[slug]` template.
 */
export function dedupeLocaleStaticPaths(paths: LocaleStaticPath[]): LocaleStaticPath[] {
  const seen = new Set<string>();
  return paths.filter(({ params }) => {
    const key = `${params.locale} ${params.path ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One hreflang alternate for BaseLayout's `<head>`. */
export interface HreflangLink {
  hreflang: string;
  href: string;
}

/**
 * Strip a trailing slash (keeping the root `/`). Astro's rendered pathnames carry one
 * under its default `build.format: 'directory'` (`/pl/o-nas/`), but meno-core's
 * `translatePath` extracts slugs by bare string surgery — `o-nas/` would miss the slug
 * index and silently degrade every link to the prefix-swap fallback.
 *
 * Exported because it is also the canonical-URL normalization (`BaseLayout` emits
 * `<link rel="canonical" href={siteUrl + normalizePathname(pathname)}>`): the canonical
 * form of `/about/` is `/about`, while the root stays `/`.
 */
export function normalizePathname(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') || '/' : pathname;
}

/**
 * Percent-decode a rendered pathname for SLUG LOOKUPS. `Astro.url.pathname` is always
 * percent-encoded (WHATWG URL), while the slug index is keyed by the raw UTF-8 slugs
 * authored in `meta.slugs`/CMS items — a German `über-uns` page renders at
 * `/de/%C3%BCber-uns` and would never match `de:über-uns` without decoding (hreflang
 * silently vanishes, the switcher degrades to the prefix swap). Output paths stay in
 * the raw form the rest of the map uses; only the LOOKUP needs decoding. Malformed
 * sequences (`%zz`) fall back to the raw string rather than throwing mid-render.
 */
function decodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

/**
 * Memoized slug lookup keyed on the mappings ARRAY IDENTITY: the meno-core reverse
 * index (`buildSlugIndex`) plus a pageId → mapping map (the index entries don't carry
 * the `exactLocales` marker, and an O(n) `mappings.find` per href would defeat the
 * point). Every Link on a page (plus hreflang + the LocaleList) needs the same lookup;
 * rebuilding it per href is O(entries) Map churn × links × pages across a build. The
 * WeakMap makes the rebuild free whenever the loader returns a stable array (and
 * harmless — one build per fresh array — when it doesn't).
 */
export interface SlugLookup {
  index: ReturnType<typeof buildSlugIndex>;
  byPageId: Map<string, CmsAwareSlugMap>;
}
const slugLookupMemo = new WeakMap<SlugMap[], SlugLookup>();
export function slugLookupFor(mappings: SlugMap[]): SlugLookup {
  let lookup = slugLookupMemo.get(mappings);
  if (!lookup) {
    lookup = {
      index: buildSlugIndex(mappings),
      byPageId: new Map(mappings.map((m) => [m.pageId, m as CmsAwareSlugMap])),
    };
    slugLookupMemo.set(mappings, lookup);
  }
  return lookup;
}

/**
 * Resolve the locale-stripped `pathname` to a known pageId, or undefined. The slug-index
 * lookup is tried for the current locale then the default locale (the same fallback
 * `translatePath` uses); `_default` entries never match a locale lookup, so slugless
 * pages resolve via the bare path-as-pageId check.
 */
function resolveCurrentPage(
  pathname: string,
  currentLocale: string,
  config: I18nConfig,
  mappings: SlugMap[],
  index: Map<string, { pageId: string; slugs: Record<string, string> }>,
): string | undefined {
  const { pathWithoutLocale } = extractLocaleFromPath(pathname, config);
  const slug = pathWithoutLocale.replace(/^\/+|\/+$/g, '');
  const byLocale =
    resolveSlugToPageId(slug, currentLocale, index) ?? resolveSlugToPageId(slug, config.defaultLocale, index);
  if (byLocale) return byLocale;
  const asPageId = slug === '' ? 'index' : slug;
  return mappings.some((m) => m.pageId === asPageId) ? asPageId : undefined;
}

/**
 * The shared link pipeline behind hreflang AND the LocaleList switcher: normalize +
 * percent-decode the rendered pathname, resolve the current page through the slug
 * index, translate per locale (`getLocaleLinks`), and apply the `exactLocales`
 * visibility filter (CMS items advertise/link ONLY the locales they're published in —
 * a draft-hidden locale's URL was never built). One pipeline, so the two surfaces can
 * never disagree about which locale URLs exist.
 */
function routableLocaleLinks(
  pathname: string,
  currentLocale: string,
  config: I18nConfig,
  mappings: SlugMap[],
): { resolved: boolean; links: LocaleLink[] } {
  const { index, byPageId } = slugLookupFor(mappings);
  const path = decodePathname(normalizePathname(pathname));
  const pageId = resolveCurrentPage(path, currentLocale, config, mappings, index);
  let links = getLocaleLinks(path, currentLocale, config, index);
  const entry = pageId ? byPageId.get(pageId) : undefined;
  if (entry?.exactLocales) links = links.filter((l) => entry.slugs[l.locale] !== undefined);
  return { resolved: pageId !== undefined, links };
}

/**
 * Hreflang alternates for the page at `pathname` — the dialect twin of meno-core's
 * `metaTagGenerator` hreflang block (one `<link rel="alternate">` per locale, `langTag`
 * values, plus `x-default` → the default-locale path).
 *
 * `baseUrl` (the project's `siteUrl`, no trailing slash) prefixes every href —
 * `https://example.com/pl/o-nas` instead of `/pl/o-nas` — mirroring `metaTagGenerator`'s
 * `baseUrl` option. Omitted, hrefs stay relative (the pre-siteUrl behavior; SSR also
 * emits relative without a baseUrl). The same alternates feed BaseLayout's `<head>` and
 * the integration's `sitemap.xml` `<xhtml:link>` entries, so the two surfaces can never
 * disagree.
 *
 * Returns `[]` when the project is single-locale, `mappings` is empty, or the current
 * path doesn't resolve to a known page. The last guard is a deliberate (small) deviation
 * from SSR: paths this module can't route (e.g. an unknown URL) must not advertise
 * `/pl/…` URLs that 404 in static output. CMS items are routable since the slug map
 * gained their entries (`loadCmsSlugMappings`), so they pass this guard naturally and
 * get real localized alternates.
 *
 * Entries marked `exactLocales` (CMS items) additionally advertise ONLY the locales
 * their slug map lists: a locale hidden via `_draftLocales` was never built, so the
 * page-style fallback alternate (default slug under the locale prefix) would 404 —
 * see {@link CmsAwareSlugMap}.
 */
export function buildHreflangLinks(
  pathname: string,
  currentLocale: string,
  config: I18nConfig,
  mappings: SlugMap[],
  baseUrl?: string,
): HreflangLink[] {
  if (!config.locales || config.locales.length <= 1 || mappings.length === 0) return [];
  const { resolved, links } = routableLocaleLinks(pathname, currentLocale, config, mappings);
  if (!resolved) return [];

  const prefix = baseUrl ?? '';
  const out: HreflangLink[] = links.map((l) => ({ hreflang: l.langTag, href: prefix + l.path }));
  const defaultLink = links.find((l) => l.locale === config.defaultLocale);
  if (defaultLink) out.push({ hreflang: 'x-default', href: prefix + defaultLink.path });
  return out;
}

/** One LocaleList switcher item (pre-translated href; label = nativeName ?? code). */
export interface LocaleListItem {
  locale: string;
  href: string;
  label: string;
  langTag: string;
  isCurrent: boolean;
  icon?: string;
}

/**
 * Slug-translated locale-switcher items for `LocaleList.astro` — `getLocaleLinks` over
 * the slug index (so `/pl/o-nas`, not a naive `/pl/about` prefix swap), with the
 * component's `showCurrent` filter applied. For unknown paths `translatePath` degrades to
 * the locale-prefix swap, which matches the previous LocaleList behavior.
 *
 * Pages marked `exactLocales` (CMS items) list ONLY the locales their slug map carries —
 * the same filter `buildHreflangLinks` applies, for the same reason: a locale hidden via
 * `_draftLocales` was never built, so its switcher link would 404 in static output. This
 * deliberately EXCEEDS JSON-SSR parity (SSR listed the link and served a fallback; a
 * static build has nothing to serve). See {@link CmsAwareSlugMap}.
 */
export function localeListItems(
  pathname: string,
  currentLocale: string,
  config: I18nConfig,
  mappings: SlugMap[],
  showCurrent: boolean,
): LocaleListItem[] {
  const byCode = new Map(config.locales.map((l) => [l.code, l]));
  // Unlike hreflang, the switcher renders even on unresolved paths (prefix-swap
  // degrade — the previous LocaleList behavior); the shared pipeline still applies
  // the exactLocales draft filter when the page does resolve.
  const { links } = routableLocaleLinks(pathname, currentLocale, config, mappings);
  return links
    .filter((l: LocaleLink) => showCurrent || !l.isCurrent)
    .map((l: LocaleLink) => ({
      locale: l.locale,
      href: l.path,
      label: l.nativeName || l.locale,
      langTag: l.langTag,
      isCurrent: l.isCurrent,
      icon: byCode.get(l.locale)?.icon,
    }));
}
