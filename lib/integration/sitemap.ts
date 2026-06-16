/**
 * meno-astro/integration — sitemap.xml generation (pure).
 *
 * The `meno()` integration's `astro:build:done` hook hands this module the build's
 * `pages` list (Astro's documented `{ pathname }[]` hook param), the project's `siteUrl`
 * (`loadSiteUrl`), and the i18n config + slug map it already loads for routing; this
 * module turns them into a sitemaps.org `<urlset>` string. The hook owns all I/O
 * (writing `<outDir>/sitemap.xml`) — this stays a pure, unit-testable function, the
 * `toAstroI18nOptions` convention.
 *
 * Shape contract (sitemaps.org + Google's localized-sitemap guidance):
 *   - one `<url><loc>…</loc></url>` per built page, absolute URLs on `siteUrl`,
 *   - multi-locale pages the slug map can route — including CMS item URLs, which the
 *     merged map (`loadSlugMappings` = pages + `loadCmsSlugMappings`) covers —
 *     additionally carry one `<xhtml:link rel="alternate" hreflang="…">` per locale
 *     plus `x-default` (the same `buildHreflangLinks` output BaseLayout renders into
 *     `<head>` — reused wholesale so head and sitemap can never advertise different
 *     URLs; CMS items advertise only their published locales, see `CmsAwareSlugMap`),
 *   - pages the slug map can't route are listed plainly with no alternates — never
 *     alternates pointing at 404s,
 *   - `404`/`500` error routes are excluded outright — including the locale route's
 *     localized 404 twins (`<locale>/404`, matched against the configured codes),
 *   - single-locale projects get a plain sitemap (no alternates, no xhtml namespace).
 *
 * This is the astro twin of meno-core's static-export `generateSitemap`
 * (build-static.ts) with the alternates upgrade; the SSR pipeline emits the same
 * locale URLs via its hreflang head links. No @astrojs/sitemap dependency: that
 * integration neither knows Meno's slug map (its alternates would be naive
 * prefix-swaps) nor matches this <1KB of XML assembly.
 */

import { extractLocaleFromPath } from 'meno-core/shared';
import { buildHreflangLinks } from '../runtime/localeRoutes';
import type { I18nConfig } from 'meno-core/shared';
import type { SlugMap } from 'meno-core/shared';

/** The slice of Astro's `astro:build:done` `pages` entries the sitemap consumes. */
export interface SitemapPage {
  pathname: string;
}

/**
 * Normalize one of Astro's built-page pathnames to a clean root-relative path with no
 * leading/trailing slashes (`''` = the site root). Astro's entries vary by version and
 * `build.format` — `''` (root), `'about/'` (directory format), `'about/index.html'` /
 * `'404.html'` (file-ish forms) — so this strips a trailing `index.html` and any slash
 * padding, accepting every observed shape. (Verified against a real `astro build`:
 * Astro 5 directory format yields `''` / `'about/'` / `'pl/o-nas/'` / `'404/'`.)
 */
function normalizePagePath(pathname: string): string {
  return pathname
    .replace(/[?#].*$/, '') // defensive: a query/hash is never part of a built path
    // Anchored to a path boundary: bare `index.html$` would truncate any page whose
    // final segment merely ENDS in "index.html" (`zindex.html` under
    // `build.format: 'file'` → "z").
    .replace(/(^|\/)index\.html$/, '$1')
    .replace(/^\/+|\/+$/g, '');
}

/**
 * `404`/`500` error routes (any emitted form: `404/`, `404.html`) — not real pages.
 *
 * Multi-locale builds additionally emit the locale route's localized 404 twins
 * (`pl/404/` → `dist/pl/404/index.html`, see `enumerate404LocaleStaticPaths`) — same
 * exclusion. A `<seg>/404` form is dropped only when its first segment IS a configured
 * locale code: a genuine user page that happens to live at e.g. `archive/404` must
 * stay listed (the config-keyed check is what makes that distinction possible).
 */
function isErrorRoute(path: string, config: I18nConfig): boolean {
  const m = /^(?:([^/]+)\/)?(404|500)(\.html)?$/.exec(path);
  if (!m) return false;
  if (!m[1]) return true; // root-level 404/500 (Astro's own error outputs)
  return (config.locales ?? []).some((l) => l.code === m[1]);
}

/** Minimal XML escaping for URL/attribute content (loc + href values). */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build the sitemap.xml content for a finished build.
 *
 * @param pages    Astro's `astro:build:done` `pages` param (`{ pathname }[]`).
 * @param siteUrl  The project's public origin (`loadSiteUrl`; trailing slash trimmed).
 * @param config   The project i18n config (`loadI18nConfig`) — drives alternates.
 * @param mappings The project slug map (`loadSlugMappings`) — routes localized URLs.
 * @returns The XML document, or `null` when there is nothing to write (no pages, or
 *          only excluded error routes) — the hook then writes no file at all rather
 *          than an empty `<urlset>`.
 */
export function buildSitemapXml(
  pages: SitemapPage[],
  siteUrl: string,
  config: I18nConfig,
  mappings: SlugMap[],
): string | null {
  // Dedupe (defensive: hook params are external input) + drop error routes.
  const paths = [...new Set(pages.map((p) => normalizePagePath(p.pathname)))].filter(
    (p) => !isErrorRoute(p, config),
  );
  if (paths.length === 0) return null;
  // Sorted for deterministic output (meno-core generateSitemap parity).
  paths.sort();

  let hasAlternates = false;
  const entries = paths.map((path) => {
    const route = path === '' ? '/' : `/${path}`;
    const loc = `${siteUrl}${route}`;
    // The page's own locale (from its URL prefix; un-prefixed = default locale) seeds
    // the same slug-map resolution BaseLayout's hreflang uses. Single-locale projects,
    // unroutable paths, and empty maps all yield [] → a plain <url>.
    const { locale } = extractLocaleFromPath(route, config);
    const alternates = buildHreflangLinks(
      route,
      locale ?? config.defaultLocale,
      config,
      mappings,
      siteUrl,
    );
    if (alternates.length === 0) return `  <url><loc>${escapeXml(loc)}</loc></url>`;
    hasAlternates = true;
    const links = alternates
      .map(
        ({ hreflang, href }) =>
          `    <xhtml:link rel="alternate" hreflang="${escapeXml(hreflang)}" href="${escapeXml(href)}"/>`,
      )
      .join('\n');
    return `  <url>\n    <loc>${escapeXml(loc)}</loc>\n${links}\n  </url>`;
  });

  // The xhtml namespace is declared only when an <xhtml:link> actually uses it.
  const xhtmlNs = hasAlternates ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : '';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${xhtmlNs}>\n` +
    entries.join('\n') +
    '\n</urlset>\n'
  );
}
