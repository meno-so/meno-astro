/**
 * meno-astro/server — `loadCmsSlugMappings` + `resolveCmsEntrySlug`.
 *
 * The CMS half of the slug map (`loadSlugMappings` merges this with the page half):
 * scans a converted project's CMS TEMPLATE pages (`src/pages/**\/[slug].astro` with
 * `meta.source === 'cms'` + a `meta.cms` schema — exactly the files the page loader
 * EXCLUDES via its `[`-segment filter) and their items
 * (`src/content/<collection>/*.json`, Astro's content-layer location, the
 * `AstroCMSProvider` storage contract) into one entry per published item:
 *
 *   { map:        { pageId: "blog/my-post",
 *                   slugs: { en: "blog/my-post", pl: "blog/moj-post" },
 *                   exactLocales: true },
 *     templateId: "blog/[slug]",          // pageModuleKey() form of the template
 *     item:       <raw stored JSON> }
 *
 * Slugs are FULL path-after-locale (translatePath semantics, like page slugs): route
 * dir + the item's slug for that locale. Per locale the slug resolves exactly like the
 * JSON static build's `buildCMSItemPath` (meno-core build-static.ts): the schema's
 * `slugField` value, `resolveI18nValue`-resolved when it is an `I18nValue`
 * (fallback: locale → default → first available), else the item's filename.
 *
 * ── No filename-wins rule (unlike pages) ────────────────────────────────────────────
 * For pages the FILE is the default-locale route, so `loadSlugMappings` force-overrides
 * the default slug with the filename. A CMS item has no file route of its own — its
 * default-locale URL is produced by the template's emitted `getStaticPaths()`
 * boilerplate (`params: { slug: entry.data.<slugField> ?? entry.id }`), i.e. the
 * urlPattern-resolved slug. The map's default entry therefore mirrors THAT contract,
 * and must stay in lockstep with `resolveCmsEntrySlug` (the content-layer transform
 * that feeds the boilerplate) — the slug map has to describe URLs the build actually
 * emits, or hreflang/sitemap would advertise 404s.
 *
 * ── Route dir comes from the FILE location, not the urlPattern ─────────────────────
 * In file-based routing `src/pages/blog/[slug].astro` IS the `/blog/<slug>` route
 * whatever `meta.cms.urlPattern` says (the same philosophy as the pages' filename
 * invariant). This also resolves the `/{{locale}}/blog/{{slug}}` pattern degrade
 * documented in `cmsRoute.ts`: such patterns already emitted to the pages ROOT
 * (`src/pages/[slug].astro`) — their items route at `/<slug>` and `/pl/<pl-slug>`,
 * and this loader maps what actually exists on disk. Locale-positioned URL patterns
 * remain unsupported (they would need an emit change; see docs/meno-astro-i18n.md).
 *
 * ── Draft semantics (JSON static-build parity, meno-core build-static.ts ~437) ─────
 *   - `*.draft.json` siblings are WIP versions, never published → skipped entirely
 *     (the `AstroCMSProvider.getItems` contract).
 *   - `_draftLocales` is per-locale visibility (`isItemDraftForLocale`, meno-core
 *     shared/types/cms.ts): a hidden locale is OMITTED from `slugs`, so it is neither
 *     enumerated (`enumerateCmsLocaleStaticPaths` has no fallback chain) nor advertised
 *     (`buildHreflangLinks` honors `exactLocales`).
 *   - EXCEPTION: the DEFAULT locale is never omitted. The template's emitted
 *     boilerplate enumerates every content entry unconditionally (it is frozen,
 *     round-trip-sacred dialect output), so the default-locale page is built
 *     regardless — omitting it from the map would just make a real page unroutable.
 *     Hiding an item for the default locale is a documented astro-format limitation.
 *
 * Same operational contract as the page loader: cwd-based consumers, never throws,
 * per-file mtime caches (template metas + item JSONs) so editor saves take effect on
 * the next render without explicit invalidation; unparseable items are skipped.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { readPageMeta } from '../dialect/parse/parseFrontmatter';
import { loadI18nConfig } from './loadI18nConfig';
import { CMS_ROUTE_FILE } from '../dialect/cmsRoute';
import { isI18nValue, resolveI18nValue, isItemDraftForLocale } from 'meno-core/shared';
import { isValidIdentifier, CMS_DRAFT_SUFFIX } from 'meno-core/shared';
import type { I18nConfig } from 'meno-core/shared';
import type { CMSItem } from 'meno-core/shared';
import type { CmsSlugEntry } from '../runtime/localeRoutes';

const DRAFT_FILE_SUFFIX = `${CMS_DRAFT_SUFFIX}.json`;

/** What one CMS template `[slug].astro` contributes to routing. */
interface CmsTemplateInfo {
  /** `pageModuleKey`-form id of the template file, e.g. `"blog/[slug]"`. */
  templateId: string;
  /** Route dir relative to `src/pages` (`"blog"`, `"docs/guides"`, `""` = pages root). */
  routeDir: string;
  /** `meta.cms.id` — the content collection (`src/content/<id>/`). */
  collectionId: string;
  /** `meta.cms.slugField` (default `"slug"`). */
  slugField: string;
}

interface TemplateCacheEntry {
  mtimeMs: number;
  /** null = the file is not a CMS template (no `meta.source==='cms'` + `meta.cms`). */
  info: CmsTemplateInfo | null;
}

interface ItemCacheEntry {
  mtimeMs: number;
  /** null = unparseable / not a JSON object → the item is skipped. */
  item: Record<string, unknown> | null;
}

/** projectRoot → (absolute template file path → cached entry). */
const templateCache = new Map<string, Map<string, TemplateCacheEntry>>();
/** projectRoot → (absolute item file path → cached entry). */
const itemCache = new Map<string, Map<string, ItemCacheEntry>>();

/** Reset the caches (test seam). */
export function clearCmsSlugMappingsCache(): void {
  templateCache.clear();
  itemCache.clear();
}

function subCache<T>(store: Map<string, Map<string, T>>, projectRoot: string): Map<string, T> {
  let m = store.get(projectRoot);
  if (!m) {
    m = new Map();
    store.set(projectRoot, m);
  }
  return m;
}

/** Drop cache entries for files no longer on disk. */
function pruneCache<T>(cache: Map<string, T>, seen: Set<string>): void {
  for (const file of cache.keys()) {
    if (!seen.has(file)) cache.delete(file);
  }
}

/** All `[slug].astro` files under `pagesDir` (recursive). */
function collectTemplateFiles(pagesDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === CMS_ROUTE_FILE) files.push(p);
    }
  };
  walk(pagesDir);
  return files;
}

/** Parse one template file's `meta.cms` into a {@link CmsTemplateInfo} (null = not CMS). */
function readTemplateInfo(file: string, pagesDir: string): CmsTemplateInfo | null {
  const meta = readPageMeta(readFileSync(file, 'utf8'));
  if (meta?.source !== 'cms') return null;
  const cms = meta.cms as Record<string, unknown> | undefined;
  if (!cms || typeof cms !== 'object') return null;
  const collectionId = cms.id;
  // A collection id is also a path segment under src/content — refuse anything that
  // is not a plain identifier (defense in depth against `../` in authored meta).
  if (typeof collectionId !== 'string' || !isValidIdentifier(collectionId)) return null;
  const rel = relative(pagesDir, file).split(sep).join('/');
  const relDir = dirname(rel);
  return {
    templateId: rel.replace(/\.astro$/, ''),
    routeDir: relDir === '.' ? '' : relDir,
    collectionId,
    slugField: typeof cms.slugField === 'string' && cms.slugField ? cms.slugField : 'slug',
  };
}

/**
 * The project's CMS templates (mtime-cached per file). Never throws; an unreadable
 * or non-CMS `[slug].astro` contributes nothing.
 */
function scanCmsTemplates(projectRoot: string): CmsTemplateInfo[] {
  const out: CmsTemplateInfo[] = [];
  try {
    const pagesDir = join(projectRoot, 'src', 'pages');
    if (!existsSync(pagesDir)) return out;
    const cache = subCache(templateCache, projectRoot);
    const seen = new Set<string>();
    for (const file of collectTemplateFiles(pagesDir)) {
      seen.add(file);
      try {
        const mtimeMs = statSync(file).mtimeMs;
        const cached = cache.get(file);
        if (cached && cached.mtimeMs === mtimeMs) {
          if (cached.info) out.push(cached.info);
          continue;
        }
        const info = readTemplateInfo(file, pagesDir);
        cache.set(file, { mtimeMs, info });
        if (info) out.push(info);
      } catch {
        // Unreadable/unparseable template → skipped this round (uncached).
      }
    }
    pruneCache(cache, seen);
  } catch {
    // No pages dir / unreadable tree → no CMS templates.
  }
  return out;
}

/** Parse one item JSON (mtime-cached). null = unparseable / not an object. */
function readItem(projectRoot: string, file: string): Record<string, unknown> | null {
  const cache = subCache(itemCache, projectRoot);
  try {
    const mtimeMs = statSync(file).mtimeMs;
    const cached = cache.get(file);
    if (cached && cached.mtimeMs === mtimeMs) return cached.item;
    let item: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        item = parsed as Record<string, unknown>;
      }
    } catch {
      /* unparseable → null (cached so we don't re-parse a broken file every render) */
    }
    cache.set(file, { mtimeMs, item });
    return item;
  } catch {
    return null;
  }
}

/** A slug-usable value: non-empty string, or a finite number (the boilerplate's params accept both). */
function usableSlug(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * The item's slug for one locale — the `buildCMSItemPath` chain (JSON build parity),
 * constrained to what the emitted boilerplate actually produces for the default locale:
 *   - `I18nValue` slug → `resolveI18nValue` for the locale; only a non-empty STRING
 *     counts (mirrors `resolveCmsEntrySlug`, which drops anything else so the
 *     boilerplate falls back to `entry.id`),
 *   - plain value → as-is (numbers stringified — valid route params),
 *   - anything unusable → the item's filename (= `entry.id` under the converter's
 *     `generateId`).
 */
function itemSlugForLocale(
  item: Record<string, unknown>,
  slugField: string,
  filename: string,
  locale: string,
  config: I18nConfig,
): string | undefined {
  const raw = item[slugField];
  let v: string | undefined;
  if (isI18nValue(raw)) {
    const resolved = resolveI18nValue(raw, locale, config);
    v = typeof resolved === 'string' && resolved ? resolved : undefined;
  } else {
    v = usableSlug(raw);
  }
  const slug = (v ?? filename).replace(/^\/+|\/+$/g, '');
  return slug || undefined;
}

/**
 * Collect one {@link CmsSlugEntry} per published CMS item of the project rooted at
 * `projectRoot`. Deterministic order (sorted by pageId); never throws. See the module
 * doc for slug/draft semantics.
 */
export function loadCmsSlugMappings(projectRoot: string): CmsSlugEntry[] {
  const entries: CmsSlugEntry[] = [];
  try {
    const config = loadI18nConfig(projectRoot);
    const seenItems = new Set<string>();
    for (const template of scanCmsTemplates(projectRoot)) {
      const dir = join(projectRoot, 'src', 'content', template.collectionId);
      if (!existsSync(dir)) continue;
      // Flat scan, published items only — the AstroCMSProvider.getItems contract
      // (`*.draft.json` siblings are unpublished WIP versions).
      const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith(DRAFT_FILE_SUFFIX));
      for (const f of files) {
        const file = join(dir, f);
        seenItems.add(file);
        const item = readItem(projectRoot, file);
        if (!item) continue;
        const filename = basename(f, '.json');

        const slugs: Record<string, string> = {};
        for (const { code } of config.locales) {
          // Per-locale visibility — except the default locale, which the emitted
          // boilerplate builds unconditionally (see module doc).
          if (code !== config.defaultLocale && isItemDraftForLocale(item as CMSItem, code)) {
            continue;
          }
          const slug = itemSlugForLocale(item, template.slugField, filename, code, config);
          if (slug) slugs[code] = template.routeDir ? `${template.routeDir}/${slug}` : slug;
        }

        const pageId = slugs[config.defaultLocale];
        if (!pageId) continue; // no routable default URL (degenerate slug data) → skip
        entries.push({
          map: { pageId, slugs, exactLocales: true },
          templateId: template.templateId,
          item,
        });
      }
    }
    pruneCache(subCache(itemCache, projectRoot), seenItems);
  } catch {
    // Any unexpected failure degrades to "no CMS entries" (pages keep working).
  }
  return entries.sort((a, b) => a.map.pageId.localeCompare(b.map.pageId));
}

/**
 * Synthesize the computed system fields a CMS LIST template references on each item — the
 * astro-format equivalent of meno-core CMSService's `addItemUrls` (which ran before the
 * renderer ever saw the items). `getCollectionList` returns raw stored `entry.data`, but a
 * Meno collection-list card binds its link to `{{item._url}}` (and may read `{{item._id}}`),
 * so without this each card's `link` prop is `undefined` and `resolveProps` falls back to
 * the card component's default — every card points at the listing page instead of its post.
 *
 *   - `_url` — the item's canonical (default-locale) URL, `"/<routeDir>/<slug>"`, EXACTLY
 *     the route the build emits for it: route dir + slugField come from the collection's
 *     `[slug].astro` template (the same `scanCmsTemplates` + `itemSlugForLocale` chain
 *     `loadCmsSlugMappings` uses, so a card link and the actual page always agree).
 *     `Link.astro` localizes it per render locale (`localizeHref`). No template for the
 *     collection → `/<source>/<slug|id>` (mirrors the legacy JSON→astro emitter's fallback).
 *   - `_id`  — the content-entry id (filename stem) when the stored data lacks one.
 *
 * Slug fallback uses the entry id (filename), matching the boilerplate's
 * `params: { slug: entry.data.<slugField> ?? entry.id }`. Never throws — any failure
 * leaves the item with the `/<source>/…` fallback url.
 */
export function resolveCmsItemUrls(
  projectRoot: string,
  source: string,
  entries: Array<{ id?: string; data: Record<string, unknown> }>,
): Array<Record<string, unknown>> {
  let routeDir = source;
  let slugField = 'slug';
  let config: I18nConfig | undefined;
  try {
    const template = scanCmsTemplates(projectRoot).find((t) => t.collectionId === source);
    if (template) {
      routeDir = template.routeDir;
      slugField = template.slugField;
    }
    config = loadI18nConfig(projectRoot);
  } catch {
    /* no templates / no config → fall back to "/<source>/<slug>" below */
  }
  const defaultLocale = config?.defaultLocale ?? 'en';
  return entries.map((e) => {
    const data = e.data;
    const entryId = typeof e.id === 'string' && e.id ? e.id : undefined;
    const filename = entryId ?? (typeof data._id === 'string' ? data._id : '');
    let url: string;
    try {
      const slug =
        (config ? itemSlugForLocale(data, slugField, filename, defaultLocale, config) : usableSlug(data[slugField])) ??
        filename;
      url = routeDir ? `/${routeDir}/${slug}` : `/${slug}`;
    } catch {
      url = `/${source}/${filename}`;
    }
    const item: Record<string, unknown> = { ...data, _url: url };
    if (item._id === undefined && entryId) item._id = entryId;
    return item;
  });
}

/**
 * Content-layer slug normalization — the schema `.transform()` the converter writes
 * into a project's generated `src/content.config.ts`:
 *
 *   schema: z.record(z.string(), z.any())
 *     .transform((data) => resolveCmsEntrySlug(data, "blog"))
 *
 * Why it exists: the CMS template's emitted `getStaticPaths()` boilerplate builds
 * `params: { slug: entry.data.<slugField> ?? entry.id }`. With a per-locale
 * (`I18nValue`) slug, `entry.data.<slugField>` would be an OBJECT — Astro rejects
 * non-string route params (`GetStaticPathsInvalidRouteParam`) and the whole build
 * dies. The boilerplate is frozen dialect output (round-trip is sacred), so the fix
 * lives a layer below it: resolve the slug to its DEFAULT-locale string as the entry
 * enters the content layer. Non-default locale URLs never touch this path — they are
 * served by the injected locale route from `loadCmsSlugMappings` (raw item JSON).
 *
 * `slugField` is looked up from the collection's template page at LOAD time (not baked
 * into the generated file) so later `slugField`/locale edits never strand a stale
 * content config. A degenerate i18n slug (no usable string) is DROPPED so the
 * boilerplate's `?? entry.id` falls back to the filename — `loadCmsSlugMappings`'
 * `itemSlugForLocale` mirrors both rules; keep them in lockstep.
 *
 * Runs inside the consuming project's `astro build`/`dev` (cwd = project root, the
 * loadFontCss precedent). Never throws — any failure returns the data unchanged.
 */
export function resolveCmsEntrySlug(data: Record<string, unknown>, collectionId: string): Record<string, unknown> {
  try {
    if (!data || typeof data !== 'object') return data;
    const root = process.cwd();
    const slugField = scanCmsTemplates(root).find((t) => t.collectionId === collectionId)?.slugField ?? 'slug';
    const value = data[slugField];
    if (!isI18nValue(value)) return data;
    const config = loadI18nConfig(root);
    const resolved = resolveI18nValue(value, config.defaultLocale, config);
    if (typeof resolved === 'string' && resolved) return { ...data, [slugField]: resolved };
    const { [slugField]: _omit, ...rest } = data;
    return rest;
  } catch {
    return data;
  }
}
