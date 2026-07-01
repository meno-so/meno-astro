/**
 * CMS template-page route helpers — the single source of truth for "is this page a
 * CMS template?" and "where on disk does it live?". Shared by the emitter
 * (`emitPage`), the page/CMS providers, and the project converter so they all agree
 * on the `src/pages/<collection>/[slug].astro` layout.
 *
 * A CMS template page is a normal page model whose `meta.source === 'cms'` and which
 * carries a `meta.cms` schema. Its body renders the *current* item via `{{cms.field}}`
 * templates; on disk it becomes an Astro dynamic route with `getStaticPaths()`.
 */

/** The dynamic route filename — Astro maps `[slug].astro` to a `slug` param. */
export const CMS_ROUTE_FILE = '[slug].astro';

/** Minimal shape of the `meta.cms` schema this module reads. */
export interface CmsMetaLike {
  id?: string;
  slugField?: string;
  urlPattern?: string;
  /** Backing store: `'cms'` (file-backed, default) or `'sanity'` (read-only Sanity dataset). */
  source?: 'cms' | 'sanity';
  /** Sanity document `_type` (only when `source === 'sanity'`). */
  documentType?: string;
  /** The collection schema's field definitions (only `type` is read here, for rich-text detection). */
  fields?: Record<string, { type?: string }>;
}

/** A page-model-ish value with the meta we care about. */
interface PageLike {
  meta?: { source?: unknown; cms?: CmsMetaLike } | Record<string, unknown>;
}

/** True when `page` is a CMS template page (`meta.source === 'cms'` + a `meta.cms` schema). */
export function isCmsTemplatePage(page: unknown): page is { meta: { source: 'cms'; cms: CmsMetaLike } } {
  if (!page || typeof page !== 'object') return false;
  const meta = (page as PageLike).meta as Record<string, unknown> | undefined;
  return !!meta && meta.source === 'cms' && !!meta.cms && typeof meta.cms === 'object';
}

/**
 * Derive the route *directory* (relative to `src/pages`) from a CMS `urlPattern`.
 *
 *   "/blog/{{slug}}"            -> "blog"
 *   "/case-studies/{{slug}}"    -> "case-studies"
 *   "/docs/guides/{{slug}}"     -> "docs/guides"   (multi-segment: kept verbatim)
 *   "/{{slug}}"  /  ""  /  …    -> ""              (degrade: file lands at pages root)
 *
 * Mirrors the one-way exporter's `extractPathPrefix` (cmsPageEmitter.ts): everything
 * before the FIRST `{{…}}` placeholder is the static prefix. Locale-prefixed patterns
 * like "/{{locale}}/blog/{{slug}}" therefore degrade to "" (their first placeholder is
 * the locale) — those aren't specially handled here (the dialect is single-locale).
 */
export function cmsRouteDirFromUrlPattern(urlPattern: string | undefined): string {
  if (!urlPattern) return '';
  const withoutLeading = urlPattern.replace(/^\/+/, '');
  const idx = withoutLeading.indexOf('{{');
  const prefix = idx < 0 ? withoutLeading : withoutLeading.slice(0, idx);
  // Strip a trailing slash and any stray surrounding slashes.
  return prefix.replace(/^\/+|\/+$/g, '');
}

/**
 * The `.astro` file path (relative to `src/pages`, POSIX separators) for a CMS
 * template page. `"/blog/{{slug}}"` → `"blog/[slug].astro"`; a pattern with no static
 * prefix → just `"[slug].astro"`.
 */
export function cmsRouteRelPath(urlPattern: string | undefined): string {
  const dir = cmsRouteDirFromUrlPattern(urlPattern);
  return dir ? `${dir}/${CMS_ROUTE_FILE}` : CMS_ROUTE_FILE;
}

/**
 * The `getStaticPaths()` + `const { cms } = Astro.props;` frontmatter boilerplate for a
 * CMS template page. Deterministic, derived solely from the collection id + slug field
 * (mirrors `core`'s `cmsPageEmitter.buildGetStaticPaths`, single-locale form). This is
 * emit-only: the parser recognizes and SKIPS it, regenerating it from `meta.cms`.
 */
export function buildGetStaticPaths(cms: CmsMetaLike): string {
  const slugField = cms.slugField || 'slug';

  // Sanity-backed template: fetch the document type via GROQ (getSanityData) instead of the
  // content collection (getCollection) — no astro:content, no local content.config entry. Items
  // are read-only (authored in Sanity). The Sanity slug type is `{ _type:'slug', current }`, but
  // getSanityData already flattens it to the `current` string, so `item.<slugField>` is the slug.
  if (cms.source === 'sanity') {
    const documentType = cms.documentType ?? cms.id ?? '';
    return [
      `export async function getStaticPaths() {`,
      `  const items = await getSanityData(${JSON.stringify(documentType)}, {}, Astro);`,
      `  return items.map((item) => ({`,
      `    params: { slug: item.${slugField} ?? item._id },`,
      `    props: { cms: item },`,
      `  }));`,
      `}`,
      ``,
      `const { cms } = Astro.props;`,
    ].join('\n');
  }

  const collectionId = cms.id ?? '';
  return [
    `export async function getStaticPaths() {`,
    `  const entries = await getCollection(${JSON.stringify(collectionId)});`,
    `  return entries.map((entry) => ({`,
    `    params: { slug: entry.data.${slugField} ?? entry.id },`,
    `    props: { cms: entry.data },`,
    `  }));`,
    `}`,
    ``,
    `const { cms } = Astro.props;`,
  ].join('\n');
}
