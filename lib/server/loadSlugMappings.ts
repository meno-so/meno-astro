/**
 * meno-astro/server — `loadSlugMappings`.
 *
 * Scans a converted project's `src/pages/**\/*.astro` files and collects each page's
 * `meta.slugs` (per-locale URL slugs, e.g. `{ en: "about", pl: "o-nas" }`) into the
 * `SlugMap[]` shape meno-core's slug translator consumes. This is the astro-format twin of
 * `PageService.getSlugMappings()` (meno-core), and it mirrors that method's conventions
 * exactly so `buildSlugIndex`/`translatePath`/`getLocaleLinks` behave identically:
 *
 *   - `pageId` is the route path without the leading slash (`/` → `"index"`).
 *   - Pages WITHOUT `meta.slugs` contribute `{ _default: <route path> }` (`""` for the
 *     index page). `_default` entries never match a locale lookup directly — they flow
 *     through `translatePath`'s no-entry fallback (locale-prefix swap, same slug), which
 *     is the SSR behavior for slugless pages.
 *   - The DEFAULT locale's slug is always the filename-derived route path, overriding
 *     any `meta.slugs[defaultLocale]`. In the astro format the file name IS the
 *     default-locale URL (file-based routing, `prefixDefaultLocale: false`) — a meta
 *     entry that disagrees is stale data (e.g. a slug edit that predates the
 *     rename-on-default-slug flow) and honoring it would break every lookup keyed by
 *     the authored href (`/about` would stop resolving the moment `slugs.en` said
 *     anything else, degrading all localized links to the bare prefix fallback).
 *
 * Consumed at build/render time (cwd = project root during `astro dev`/`build`, same
 * contract as `loadI18nConfig`/`loadFontCss`) by:
 *   - the injected `[locale]/[...path]` route's `getStaticPaths` (locale route
 *     enumeration — via the SPLIT loaders, see below),
 *   - `LocaleList.astro` (slug-translated switcher links),
 *   - `BaseLayout.astro` (hreflang alternates),
 *   - `localizeHref` (Link/Embed href rewriting) and the integration's sitemap hook.
 *
 * The public `loadSlugMappings` is the MERGED map: page entries (this file) + CMS item
 * entries (`loadCmsSlugMappings` — `src/pages/**\/[slug].astro` templates ×
 * `src/content/<collection>/*.json` items, flattened to their `SlugMap`s). Every
 * link/hreflang/switcher/sitemap consumer therefore routes CMS item URLs with no
 * signature change. The locale ROUTE is the one consumer that must keep the halves
 * apart (pages render page modules; CMS items render their template module with
 * `cms` props), so it composes `loadPageSlugMappings` + `loadCmsSlugMappings` instead.
 *
 * Excluded from the page scan:
 *   - dynamic routes (any path segment containing `[`) — CMS templates
 *     (`src/pages/<collection>/[slug].astro`) enter the map through
 *     `loadCmsSlugMappings` as one entry PER ITEM, not as page entries; other
 *     dynamic routes (user catch-alls) stay excluded,
 *   - `404.astro` / `500.astro` (error routes have no locale variants).
 *
 * A module-level per-file mtime cache keeps repeated calls cheap (LocaleList + BaseLayout
 * call this on every render): each call re-stats every page file but re-parses only
 * changed/new ones, so editor saves (AstroPageProvider rewrites the `.astro` file) take
 * effect on the next render without any explicit invalidation. Never throws — an
 * unreadable/unparseable page degrades to its `_default` entry.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { readPageMeta } from '../dialect/parse/parseFrontmatter';
import { loadI18nConfig } from './loadI18nConfig';
import { loadCmsSlugMappings, clearCmsSlugMappingsCache } from './loadCmsSlugMappings';
import type { SlugMap } from 'meno-core/shared';

interface CacheEntry {
  mtimeMs: number;
  map: SlugMap;
}

/** projectRoot → (absolute page file path → cached entry). */
const cache = new Map<string, Map<string, CacheEntry>>();

/**
 * Reset BOTH slug-map caches (pages + CMS items) — the public `loadSlugMappings`
 * returns the merged map, so a reset that cleared only the page half would leave
 * callers half-stale (localized CMS links/hreflang serving old slugs). Test seam;
 * runtime invalidation is mtime-driven and needs no explicit reset.
 */
export function clearSlugMappingsCache(): void {
  cache.clear();
  clearCmsSlugMappingsCache();
}

/** `meta.slugs` is usable when it is a non-empty plain record of string slugs. */
function readSlugs(meta: Record<string, unknown> | undefined): Record<string, string> | undefined {
  const slugs = meta?.slugs;
  if (!slugs || typeof slugs !== 'object' || Array.isArray(slugs)) return undefined;
  const entries = Object.entries(slugs as Record<string, unknown>);
  if (entries.length === 0 || entries.some(([, v]) => typeof v !== 'string')) return undefined;
  return slugs as Record<string, string>;
}

/** Page files under `pagesDir`, excluding dynamic routes (`[`) and 404/500. */
function collectPageFiles(pagesDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.includes('[')) continue; // dynamic route (CMS templates, user catch-alls)
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.astro') && !/^(404|500)\.astro$/.test(e.name)) files.push(p);
    }
  };
  walk(pagesDir);
  return files;
}

/**
 * Collect the PAGE slug mappings for the project rooted at `projectRoot` (no CMS
 * entries). Deterministic order (sorted by pageId); never throws. This is the half the
 * locale route's page enumeration consumes (`enumerateLocaleStaticPaths`) — feeding it
 * the merged map would double-enumerate CMS item URLs with page-style props.
 */
export function loadPageSlugMappings(projectRoot: string): SlugMap[] {
  const mappings: SlugMap[] = [];
  try {
    const pagesDir = join(projectRoot, 'src', 'pages');
    if (!existsSync(pagesDir)) return mappings;

    let fileCache = cache.get(projectRoot);
    if (!fileCache) {
      fileCache = new Map();
      cache.set(projectRoot, fileCache);
    }

    const files = collectPageFiles(pagesDir);
    const seen = new Set<string>();

    for (const file of files) {
      seen.add(file);
      // `about.astro` → "about", `index.astro` → "index", `docs/intro.astro` → "docs/intro".
      const pageId = relative(pagesDir, file).split(sep).join('/').replace(/\.astro$/, '');
      try {
        const mtimeMs = statSync(file).mtimeMs;
        const cached = fileCache.get(file);
        if (cached && cached.mtimeMs === mtimeMs) {
          mappings.push(cached.map);
          continue;
        }
        const slugs = readSlugs(readPageMeta(readFileSync(file, 'utf8')));
        const map: SlugMap = slugs
          ? { pageId, slugs }
          : { pageId, slugs: { _default: pageId === 'index' ? '' : pageId } };
        fileCache.set(file, { mtimeMs, map });
        mappings.push(map);
      } catch {
        // Unreadable/unparseable page → SSR-parity default entry (uncached).
        mappings.push({ pageId, slugs: { _default: pageId === 'index' ? '' : pageId } });
      }
    }

    // Drop cache entries for deleted files.
    for (const file of fileCache.keys()) {
      if (!seen.has(file)) fileCache.delete(file);
    }
  } catch {
    // No pages dir / unreadable tree → empty mappings (single-locale-like degradation).
  }

  // Filename wins for the default locale (see module doc). Applied OUTSIDE the per-file
  // cache because it depends on the i18n config (the default can change at runtime);
  // `_default` entries (slugless pages) already carry the filename and stay untouched.
  const { defaultLocale } = loadI18nConfig(projectRoot);
  const normalized = mappings.map((m) =>
    '_default' in m.slugs
      ? m
      : { ...m, slugs: { ...m.slugs, [defaultLocale]: m.pageId === 'index' ? '' : m.pageId } },
  );
  return normalized.sort((a, b) => a.pageId.localeCompare(b.pageId));
}

/**
 * Whether the project ships a custom 404 page (`src/pages/404.astro`).
 *
 * 404.astro is deliberately EXCLUDED from the slug map (see `collectPageFiles`): the
 * map feeds every advertising surface — hreflang, LocaleList, sitemap, link
 * translation — and an error URL must never appear on any of them. But the injected
 * locale route still needs to know the page EXISTS to build its localized twins
 * (`/pl/404` → `dist/pl/404/index.html`, `enumerate404LocaleStaticPaths`), so its
 * existence is exposed as this separate, slug-map-free check. Plain `existsSync`
 * (no caching): callers are getStaticPaths-time only, never per-render.
 */
export function has404Page(projectRoot: string): boolean {
  try {
    return existsSync(join(projectRoot, 'src', 'pages', '404.astro'));
  } catch {
    return false;
  }
}

/**
 * The full project slug map: page entries + one entry per published CMS item
 * (`loadCmsSlugMappings`, flattened). The single public surface every
 * link/hreflang/switcher/sitemap consumer reads — CMS item URLs slug-translate
 * exactly like page URLs. Deterministic order (sorted by pageId); never throws.
 */
export function loadSlugMappings(projectRoot: string): SlugMap[] {
  return [
    ...loadPageSlugMappings(projectRoot),
    ...loadCmsSlugMappings(projectRoot).map((e) => e.map),
  ].sort((a, b) => a.pageId.localeCompare(b.pageId));
}
