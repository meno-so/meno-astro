/**
 * meno-astro/server — `loadSiteUrl`.
 *
 * Reads a converted project's `project.config.json` and returns its `siteUrl` — the
 * public origin the deployed site lives at (e.g. `https://example.com`) — with any
 * trailing slash trimmed so callers can safely do `${siteUrl}${path}`. A missing file,
 * unparseable JSON, a non-string value, or an empty/whitespace value all degrade to
 * `null` rather than throwing (the `loadI18nConfig` convention: a project must always
 * build, with or without SEO config).
 *
 * This is the single seam every absolute-URL feature reads from:
 *   - the `meno()` integration maps it onto Astro's `site` option (`astro:config:setup`)
 *     and prefixes the generated `sitemap.xml` URLs (`astro:build:done`),
 *   - `BaseLayout.astro` uses it for the canonical link + absolute hreflang alternates
 *     (the dialect twin of meno-core `metaTagGenerator`'s `url`/`baseUrl` options).
 *
 * Server/build-only (touches the filesystem); called with `process.cwd()` (= project
 * root during `astro dev`/`build`) by the published components, same contract as
 * `loadI18nConfig`/`loadFontCss`. Mtime-memoized like `loadI18nConfig` — BaseLayout
 * calls this on every page render, so a build would otherwise re-read + JSON.parse
 * the same unchanged file once per page.
 */

import { readFileSync, statSync } from 'fs';
import { join } from 'path';

/** Per-project mtime memo (see `loadI18nConfig` for the rationale). */
const cache = new Map<string, { mtimeMs: number; siteUrl: string | null }>();

/**
 * Load the public site origin for the project rooted at `projectRoot`.
 *
 * Resolution:
 *   1. Read `<projectRoot>/project.config.json`. Missing/unreadable → `null`.
 *   2. Take its `.siteUrl`; non-string / empty (after trimming whitespace and
 *      trailing slashes) → `null`.
 *
 * Never throws: every failure path returns `null` (the "no absolute URLs" mode —
 * hreflang stays relative, no canonical, no sitemap).
 */
export function loadSiteUrl(projectRoot: string): string | null {
  try {
    const cfgPath = join(projectRoot, 'project.config.json');
    const { mtimeMs } = statSync(cfgPath); // throws when missing → null below
    const cached = cache.get(projectRoot);
    if (cached && cached.mtimeMs === mtimeMs) return cached.siteUrl;
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8')) as { siteUrl?: unknown };
    let siteUrl: string | null = null;
    if (typeof parsed.siteUrl === 'string') {
      const trimmed = parsed.siteUrl.trim().replace(/\/+$/, '');
      siteUrl = trimmed === '' ? null : trimmed;
    }
    cache.set(projectRoot, { mtimeMs, siteUrl });
    return siteUrl;
  } catch {
    return null;
  }
}
