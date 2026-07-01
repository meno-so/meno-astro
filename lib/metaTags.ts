/**
 * meno-astro — `buildSocialMetaTags`.
 *
 * The dialect twin of meno-core's SSR `generateMetaTags` (`metaTagGenerator.ts`), reduced to
 * the head fields BaseLayout does NOT already own. BaseLayout renders `<title>`,
 * `<meta name="description">`, `<link rel="canonical">` and the hreflang alternates itself;
 * this helper adds the *social/SEO* surface from the page's native `meta` fields:
 *
 *   - `<meta name="keywords">`
 *   - Open Graph: `og:title`, `og:description`, `og:image`, `og:type`, `og:url`
 *   - Twitter Card: `twitter:card`, `twitter:title`, `twitter:description`, `twitter:site`, `twitter:creator`
 *
 * Before this helper existed, these were reachable in an `.astro` project ONLY by hand-writing
 * the tags into `meta.customCode.head`: the Studio "Open Graph" / "SEO" panels wrote
 * `meta.ogTitle` / `meta.ogImage` / `meta.keywords` and they round-tripped through the codec,
 * but the runtime never emitted them. This closes that gap so the Pages-tab fields render
 * natively — the same `meta` the editor already collects.
 *
 * Parity with meno-core's `generateMetaTags`:
 *   - Same extract-time fallbacks: `ogTitle` ← `title`, `ogDescription` ← `description`,
 *     `ogType` ← `'website'`.
 *   - Same `twitter:card` logic: `summary_large_image` when an og:image is present, else
 *     `summary`; emitted only when there is any social content. No `twitter:image` (Twitter
 *     inherits `og:image`).
 *
 * Deliberate divergences from core:
 *   - og:image is absolutized against `siteUrl` for crawlers (root-relative → absolute) but is
 *     NOT format-swapped. Core swaps `/images/*.webp|avif` → `.jpg` because its upload pipeline
 *     emits a companion JPEG; an `.astro` project has no such guarantee, so swapping would risk
 *     a 404'd card image. The original asset path is preserved.
 *   - `title` / `description` / canonical / hreflang are intentionally NOT emitted here
 *     (BaseLayout owns them), so this string is concatenated AFTER BaseLayout's own head tags.
 *
 * Backward-compat with customCode SEO: a faithfully-imported project may still carry its
 * OG/Twitter/keywords tags in `meta.customCode.head` — the only place they rendered before this
 * helper existed (e.g. the website-convert importer emits them there). To avoid duplicate tags,
 * the social surface DEFERS to customCode: if the merged head customCode already declares any
 * `og:` or `twitter:` tag, this helper assumes the author owns the social surface and emits
 * neither family. `keywords` defers independently (suppressed only when customCode already
 * declares a `keywords` meta). Migrating those tags into the native `meta` fields (and removing
 * them from customCode) flips each surface back to native emission.
 *
 * Pure + framework-free: the caller (BaseLayout) resolves i18n VALUES through `i18n()` first and
 * passes plain strings, so this module needs no locale context. Non-string inputs coerce to ''.
 */

/** Self-contained HTML escaper — replicates meno-core's `escapeHtml` (attributeBuilder.ts) so
 * this runtime-only module carries no `meno-core` import (the published play runtime resolves
 * meno-core from npm; duplicating the 5-replacement escaper is cheaper than a cross-package dep). */
function escapeHtml(unsafe: unknown): string {
  let value: string;
  if (typeof unsafe !== 'string') {
    if (unsafe === null || unsafe === undefined) return '';
    value = String(unsafe);
  } else {
    value = unsafe;
  }
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Prepend the site origin to a root-relative og:image so crawlers fetch an absolute URL.
 * No format swap (see module header). External/absolute URLs are left untouched. */
function absolutizeOgImage(value: string, siteUrl?: string | null): string {
  if (siteUrl && value.startsWith('/')) {
    return `${siteUrl.replace(/\/$/, '')}${value}`;
  }
  return value;
}

export interface SocialMetaInput {
  /** Resolved page title — fallback source for og:title/twitter:title; NOT emitted here. */
  title?: unknown;
  /** Resolved page description — fallback source for og:description; NOT emitted here. */
  description?: unknown;
  /** Resolved keywords (`meta.keywords`). */
  keywords?: unknown;
  /** Resolved `meta.ogTitle`. */
  ogTitle?: unknown;
  /** Resolved `meta.ogDescription`. */
  ogDescription?: unknown;
  /** `meta.ogImage` (plain string path/URL). */
  ogImage?: unknown;
  /** `meta.ogType` (defaults to 'website'). */
  ogType?: unknown;
  /** Absolute canonical URL for `og:url`; falsy → omitted (BaseLayout owns `<link rel="canonical">`). */
  url?: string | null;
  /** Site origin used to absolutize a root-relative og:image. */
  siteUrl?: string | null;
  /** Project social handle (`project.config.json` `social.twitterHandle`) → twitter:site/creator. */
  twitterHandle?: string;
  /** Merged head customCode — families already declared there are suppressed to avoid dupes. */
  customCodeHead?: string;
}

/**
 * Build the `og:*` / `twitter:*` / `keywords` head-tag string for a page from its native
 * `meta` fields. Returns '' when nothing should be emitted. Joined with the indentation
 * BaseLayout's `<head>` uses, ready to drop into a `<Fragment set:html={…} />`.
 */
export function buildSocialMetaTags(input: SocialMetaInput): string {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  const title = str(input.title);
  const description = str(input.description);
  const keywords = str(input.keywords);
  const ogTitle = str(input.ogTitle) || title;
  const ogDescription = str(input.ogDescription) || description;
  const ogImage = str(input.ogImage);
  const ogType = str(input.ogType) || 'website';
  const url = str(input.url);

  const head = input.customCodeHead ?? '';
  // If the author hand-wrote ANY og:/twitter: tag into customCode, they own the social surface —
  // emit neither family (prevents the importer's customCode SEO from duplicating native output).
  const hasCustomSocial = /property\s*=\s*["']og:/i.test(head) || /name\s*=\s*["']twitter:/i.test(head);
  const hasCustomKeywords = /name\s*=\s*["']keywords["']/i.test(head);

  const tags: string[] = [];

  if (keywords && !hasCustomKeywords) {
    tags.push(`<meta name="keywords" content="${escapeHtml(keywords)}" />`);
  }

  if (!hasCustomSocial) {
    // Open Graph
    if (ogTitle) tags.push(`<meta property="og:title" content="${escapeHtml(ogTitle)}" />`);
    if (ogDescription) tags.push(`<meta property="og:description" content="${escapeHtml(ogDescription)}" />`);
    if (ogImage) {
      tags.push(`<meta property="og:image" content="${escapeHtml(absolutizeOgImage(ogImage, input.siteUrl))}" />`);
    }
    // og:type rides the OG block's gate — never a lone og:type on a page with no other OG content.
    if (ogTitle || ogDescription || ogImage) {
      tags.push(`<meta property="og:type" content="${escapeHtml(ogType)}" />`);
    }
    if (url) tags.push(`<meta property="og:url" content="${escapeHtml(url)}" />`);

    // Twitter Card — card type from og:image presence; title/description fall back to OG (then title/desc).
    const hasAnyMeta = title || description || ogImage || ogTitle || ogDescription;
    if (hasAnyMeta) {
      tags.push(`<meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}" />`);
    }
    if (ogTitle) tags.push(`<meta name="twitter:title" content="${escapeHtml(ogTitle)}" />`);
    if (ogDescription) tags.push(`<meta name="twitter:description" content="${escapeHtml(ogDescription)}" />`);

    const rawHandle = input.twitterHandle?.trim();
    if (rawHandle) {
      const handle = rawHandle.startsWith('@') ? rawHandle : `@${rawHandle}`;
      tags.push(`<meta name="twitter:site" content="${escapeHtml(handle)}" />`);
      tags.push(`<meta name="twitter:creator" content="${escapeHtml(handle)}" />`);
    }
  }

  return tags.join('\n    ');
}
