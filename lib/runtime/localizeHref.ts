/**
 * meno-astro — locale-aware href rewriting (the dialect twin of meno-core SSR's
 * `localizeHref` / `localizeRichTextLinks`, ssrRenderer.ts).
 *
 * Authored hrefs in a Meno model are default-locale paths (`/about`). When a page
 * renders under a non-default locale (`/pl/o-nas`), its internal links must point at
 * the SAME locale's URLs — slug-translated when the target page has localized slugs
 * (`/about` → `/pl/o-nas`), locale-prefixed otherwise (`/contact` → `/pl/contact`).
 * Meno's SSR did this at render time; in the astro format the equivalent seam is the
 * runtime components every link flows through (`Link.astro` for `{type:"link"}` nodes,
 * `Embed.astro` for anchors inside raw HTML).
 *
 * Split pure-core / context-wrapper like the rest of the runtime: `localizeHrefFor`
 * is fully parameterized (unit-testable, no fs / no ALS), while `localizeHref` reads
 * the active locale from the middleware-opened context and the slug map from the
 * project (`loadSlugMappings`, mtime-cached) — callable straight from component
 * frontmatter.
 */

import { translatePath, buildLocalizedPath, findPageBySlug } from 'meno-core/shared';
import type { SlugMap } from 'meno-core/shared';
import type { I18nConfig } from 'meno-core/shared';
import { getLocaleContext } from './i18n';
import { slugLookupFor, type CmsAwareSlugMap } from './localeRoutes';
import { loadSlugMappings } from '../server/loadSlugMappings';

/** Internal app paths only: `/x` yes; external/protocol-relative/anchors/mail no. */
function isInternalHref(href: unknown): href is string {
  return typeof href === 'string' && href.startsWith('/') && !href.startsWith('//');
}

/**
 * Pure core: rewrite an authored (default-locale) internal `href` for `locale`.
 * Mirrors SSR's chain — slug map present → `translatePath` (prefix + slug
 * translation, no-op for the default locale); no map → bare prefix for
 * non-default locales. Non-internal hrefs pass through untouched.
 *
 * Two rules SSR didn't need (its dynamic routing served every fallback URL; the
 * static build only ships canonical ones):
 *   - A `?query`/`#hash` suffix is split off before translation — `translatePath`
 *     does bare string slug surgery, so `/about#team` would miss the index and
 *     degrade to the prefix swap `/pl/about#team`, a route the build deliberately
 *     does NOT emit when a `pl` slug exists. The suffix is re-appended afterwards.
 *   - A CMS entry marked `exactLocales` that LACKS the target locale was draft-hidden
 *     there and never built — keep the authored default-locale URL (it exists)
 *     instead of fabricating a 404ing prefixed one. The same visibility rule
 *     hreflang and the LocaleList apply (`routableLocaleLinks`).
 */
export function localizeHrefFor(
  href: string,
  locale: string | null | undefined,
  config: I18nConfig,
  mappings: SlugMap[],
): string {
  if (!isInternalHref(href) || !locale) return href;
  const m = /^([^?#]*)([?#].*)?$/.exec(href)!;
  const path = m[1] || '/';
  const suffix = m[2] ?? '';
  if (mappings.length > 0) {
    const { index, byPageId } = slugLookupFor(mappings);
    if (locale !== config.defaultLocale) {
      const slug = path.replace(/^\/+|\/+$/g, '');
      const hit = findPageBySlug(slug, config.defaultLocale, index);
      const entry: CmsAwareSlugMap | undefined = hit ? byPageId.get(hit.pageId) : undefined;
      if (entry?.exactLocales && entry.slugs[locale] === undefined) return href;
    }
    return translatePath(path, locale, config.defaultLocale, config.defaultLocale, index) + suffix;
  }
  if (locale !== config.defaultLocale) return buildLocalizedPath(path, locale) + suffix;
  return href;
}

/**
 * Localize an internal href to the active render locale (middleware context).
 * No context / default locale / non-internal href → unchanged. Reads the slug map
 * from the project root (cwd during astro dev/build — loadFontCss precedent).
 */
export function localizeHref(href: unknown): unknown {
  if (!isInternalHref(href)) return href;
  const ctx = getLocaleContext();
  if (!ctx?.locale || ctx.locale === ctx.config.defaultLocale) return href;
  return localizeHrefFor(href, ctx.locale, ctx.config, loadSlugMappings(process.cwd()));
}

/**
 * Localize every internal `<a href="…">` inside a raw HTML string (Embed nodes /
 * rich text) — same regex + skip rules as SSR's `localizeRichTextLinks`.
 */
export function localizeRichTextLinks(html: string): string {
  if (typeof html !== 'string' || !html) return html;
  const ctx = getLocaleContext();
  if (!ctx?.locale || ctx.locale === ctx.config.defaultLocale) return html;
  const mappings = loadSlugMappings(process.cwd());
  return html.replace(
    /<a\b([^>]*?)href=(["'])([^"']*?)\2([^>]*?)>/gi,
    (match, before, quote, href, after) => {
      if (!isInternalHref(href)) return match;
      const localized = localizeHrefFor(href, ctx.locale, ctx.config, mappings);
      return localized === href ? match : `<a${before}href=${quote}${localized}${quote}${after}>`;
    },
  );
}
