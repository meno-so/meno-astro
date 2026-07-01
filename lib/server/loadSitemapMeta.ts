/**
 * meno-astro/server — `loadSitemapMeta`.
 *
 * Scans a converted project's `src/pages/**\/*.astro` files and collects each page's
 * per-page sitemap settings (`meta.sitemap`: `priority` / `changefreq` / `exclude`) into a
 * map keyed by the page's **normalized route path** — the same `''`-rooted, slash-trimmed
 * shape `buildSitemapXml` works in. So the sitemap hook can look up a built page's settings
 * with a direct `get(path)`.
 *
 * i18n: a page surfaces at its default-locale URL (un-prefixed) AND one localized URL per
 * non-default locale (`<locale>/<translated-slug>`, prefix-swap fallback when no `meta.slugs`
 * entry). This reader enumerates ALL of them from each page's own `meta.slugs` + the project
 * i18n config — mirroring `loadPageSlugMappings`/the locale route — so an `exclude` drops every
 * variant and a `priority`/`changefreq` applies to every variant. No external slug-map needed.
 *
 * Build-only (cwd = project root during `astro build`); a per-file mtime cache keeps it cheap.
 * Never throws — an unreadable/unparseable page contributes nothing.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { readPageMeta } from '../dialect/parse/parseFrontmatter';
import { loadI18nConfig } from './loadI18nConfig';

export interface SitemapMeta {
  priority?: number;
  changefreq?: string;
  exclude?: boolean;
}

const CHANGEFREQ = new Set(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never']);

interface FileCacheEntry {
  mtimeMs: number;
  meta: SitemapMeta | null;
  slugs: Record<string, string> | undefined;
}
/** projectRoot → (absolute page file → cached entry). */
const cache = new Map<string, Map<string, FileCacheEntry>>();

/** Extract a valid `meta.sitemap` (clamped priority, known changefreq, exclude flag), or null. */
function pickSitemapMeta(meta: Record<string, unknown> | undefined): SitemapMeta | null {
  const sm = meta?.sitemap;
  if (!sm || typeof sm !== 'object') return null;
  const src = sm as Record<string, unknown>;
  const out: SitemapMeta = {};
  if (typeof src.priority === 'number' && src.priority >= 0 && src.priority <= 1) out.priority = src.priority;
  if (typeof src.changefreq === 'string' && CHANGEFREQ.has(src.changefreq)) out.changefreq = src.changefreq;
  if (src.exclude === true) out.exclude = true;
  return Object.keys(out).length ? out : null;
}

/** `meta.slugs` as a plain string record, or undefined. */
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
      if (e.name.includes('[')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.astro') && !/^(404|500)\.astro$/.test(e.name)) files.push(p);
    }
  };
  walk(pagesDir);
  return files;
}

/**
 * Map a page's pageId (`index` → `''`) + its `meta.slugs` + the i18n config to every
 * normalized route path the page is built at (default-locale un-prefixed + one per other
 * locale). Mirrors `prefixDefaultLocale: false` + translated-slug routing.
 */
function pagePaths(
  pageId: string,
  slugs: Record<string, string> | undefined,
  defaultLocale: string,
  locales: string[],
): string[] {
  const base = pageId === 'index' ? '' : pageId;
  const paths = [base];
  for (const loc of locales) {
    if (loc === defaultLocale) continue;
    const slug = (slugs?.[loc] ?? base).replace(/^\/+|\/+$/g, '');
    paths.push(slug === '' ? loc : `${loc}/${slug}`);
  }
  return paths;
}

/**
 * Build the route-path → sitemap-settings map for the project rooted at `projectRoot`.
 * Pages with no `meta.sitemap` are absent (default treatment). Never throws.
 */
export function loadSitemapMeta(projectRoot: string): Map<string, SitemapMeta> {
  const result = new Map<string, SitemapMeta>();
  try {
    const pagesDir = join(projectRoot, 'src', 'pages');
    if (!existsSync(pagesDir)) return result;

    let fileCache = cache.get(projectRoot);
    if (!fileCache) {
      fileCache = new Map();
      cache.set(projectRoot, fileCache);
    }

    const { defaultLocale, locales } = loadI18nConfig(projectRoot);
    const localeCodes = (locales ?? []).map((l) => l.code);
    const files = collectPageFiles(pagesDir);
    const seen = new Set<string>();

    for (const file of files) {
      seen.add(file);
      const pageId = relative(pagesDir, file)
        .split(sep)
        .join('/')
        .replace(/\.astro$/, '');
      try {
        const mtimeMs = statSync(file).mtimeMs;
        let entry = fileCache.get(file);
        if (!entry || entry.mtimeMs !== mtimeMs) {
          const meta = readPageMeta(readFileSync(file, 'utf8'));
          entry = { mtimeMs, meta: pickSitemapMeta(meta), slugs: readSlugs(meta) };
          fileCache.set(file, entry);
        }
        if (!entry.meta) continue;
        for (const path of pagePaths(pageId, entry.slugs, defaultLocale, localeCodes)) {
          result.set(path, entry.meta);
        }
      } catch {
        /* unreadable page → no sitemap settings */
      }
    }

    for (const f of fileCache.keys()) if (!seen.has(f)) fileCache.delete(f);
  } catch {
    /* no pages dir → empty map */
  }
  return result;
}
