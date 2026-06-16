/**
 * meno-astro — runtime entry point.
 *
 * This is the package that Meno-generated Astro projects import at runtime so the
 * `.astro` source stays thin and consistent (one shared resolver for styles, i18n,
 * and CMS queries — the same code paths the Studio React preview uses).
 *
 * Design note: `meno-astro` depends on `meno-core` (single direction). The heavy,
 * battle-tested logic (style/utility-class generation, i18n resolution, CMS query
 * parsing, the template engine) lives in `meno-core` and is composed here behind a
 * curated, stable surface. No `meno-core` files move, so the existing JSON runtime is
 * untouched by construction. Slimming the published bundle (so generated projects do
 * not transitively pull all of `meno-core`) is a later optimization.
 */

import type {
  JSONPage,
  PageData,
  ComponentNode,
  StructuredComponentDefinition,
  PropDefinition,
  StyleObject,
  ResponsiveStyleObject,
} from 'meno-core/shared';
import { resolveI18nInProps } from 'meno-core/shared';
import { getLocaleContext } from './runtime/i18n';
import { toHtmlString } from './runtime/richText';

// ---------------------------------------------------------------------------
// Dialect version — written into generated projects so a project can be
// migrated forward if the on-disk `.astro` dialect format evolves. Part of the
// package's semver contract.
// ---------------------------------------------------------------------------
// 0.1.3: CMS rich-text text children emit `richTextWithComponents(<chain>, cmsComponents)`
// (+ the generated `src/cmsComponents.ts` registry import) instead of `richText(<chain>)` —
// an older parse() reads the new call back as a verbatim `{ _code }` marker, not the
// `{{<chain>}}` binding, so this is a forward-incompatible emitted-shape change.
export const dialectVersion = '0.1.3' as const;

// ---------------------------------------------------------------------------
// Model types re-exported for the dialect + generated projects. These are the
// Meno in-memory model the emitter serializes and the parser reconstructs.
// ---------------------------------------------------------------------------
export type {
  JSONPage,
  PageData,
  ComponentNode,
  StructuredComponentDefinition,
  PropDefinition,
  StyleObject,
  ResponsiveStyleObject,
};

/** A responsive style payload as carried verbatim in `style({...})` calls. */
export type MenoStyle = ResponsiveStyleObject | StyleObject;

/** A component's prop definitions, as carried by the `resolveProps(Astro, {…})` call. */
export type MenoProps = Record<string, PropDefinition>;

/** A page's `export const meta` payload. */
export type MenoPageMeta = NonNullable<JSONPage['meta']>;

/**
 * A component's non-interface metadata, carried by the `__meno` frontmatter const.
 * `defineVars` is intentionally not here: it is emitted as the script's native
 * `<script define:vars={{…}}>` directive and reconstructed on parse, not via `__meno`.
 */
export type MenoComponentMeta = Pick<
  StructuredComponentDefinition,
  'category' | 'acceptsStyles' | 'libraries'
>;

// ---------------------------------------------------------------------------
// Curated runtime helpers, composed from meno-core. The dialect-specific wrappers
// the emitter targets: `i18n()`, `list()`, `style()`, `getCollectionList()`,
// `href()`, and `embedHtml()` are implemented (below / `runtime/*.ts`). The primitives
// re-exported here are the unambiguous, dependency-free foundations they build on.
// ---------------------------------------------------------------------------

// i18n resolution (pure primitives; only type-imports inside meno-core).
export {
  isI18nValue,
  resolveI18nValue,
  extractLocaleFromPath,
  buildLocalizedPath,
} from 'meno-core/shared';

// Slug translation primitives (pure; meno-core's slug translator). Re-exported here so
// the published components (LocaleList/BaseLayout/LocaleRoute) can reach them alongside
// `loadSlugMappings`; the locale-route helpers in `runtime/localeRoutes.ts` build on them.
export {
  buildSlugIndex,
  getLocaleLinks,
  resolveSlugToPageId,
} from 'meno-core/shared';
export type { SlugMap, LocaleLink } from 'meno-core/shared';

// Locale-aware href rewriting — Link.astro/Embed.astro rewrite authored
// (default-locale) internal hrefs to the active render locale, slug-translated
// through the project slug map (SSR `localizeHref` parity). See `runtime/localizeHref.ts`.
export { localizeHref, localizeHrefFor, localizeRichTextLinks } from './runtime/localizeHref';
// Rich-text → HTML normalizer for Embed.astro (TipTap doc / { __richtext__, … } → HTML).
// Kept in meno-astro (not meno-core) so it ships with the locally-rebuilt play runtime;
// the runtime installs meno-core from npm, so a new meno-core export wouldn't reach it.
export { toHtmlString, richText } from './runtime/richText';
// Rich text with embedded project components rendered for real (Container API against
// the converter-generated `src/cmsComponents.ts` registry) — the emitter binds CMS
// rich-text fields through this. See `runtime/richTextComponents.ts`.
export { richTextWithComponents } from './runtime/richTextComponents';
// Client form-submit handler (`<Form submitHandler="fetch">`) — injected by BaseLayout
// before </body> so forms POST via fetch and show an inline success/error message.
// Kept in meno-astro (not imported from meno-core) so it ships with the locally-rebuilt
// play runtime and resolves in projects that depend only on meno-astro. See
// `runtime/formHandler.ts`.
export { formHandlerScript } from './runtime/formHandler';
// Client-side CMS filtering runtime (MenoFilter) — injected by BaseLayout before </body>
// so a `[data-meno-filter]` page filters/searches/sorts/paginates its CMS list. Kept in
// meno-astro (re-bundled from meno-core's source, not imported) for the same reason as
// `formHandlerScript`. Self-gating: a no-op when the page has no filter. See
// `runtime/menoFilter.ts`.
export { menoFilterScript } from './runtime/menoFilter';

// Locale route helpers (pure) — enumerate the injected `/[locale]/[...path]` route's
// getStaticPaths entries from the slug map, plus the slug-translated link builders the
// published components consume (LocaleRoute / LocaleList / BaseLayout hreflang) and
// `normalizePathname` (trailing-slash canonicalization — BaseLayout's canonical URL).
// See `runtime/localeRoutes.ts`.
export {
  enumerateLocaleStaticPaths,
  enumerateCmsLocaleStaticPaths,
  enumerate404LocaleStaticPaths,
  dedupeLocaleStaticPaths,
  NOT_FOUND_PAGE_ID,
  pageModuleKey,
  buildHreflangLinks,
  localeListItems,
  normalizePathname,
} from './runtime/localeRoutes';
export type {
  LocaleStaticPath,
  HreflangLink,
  LocaleListItem,
  CmsSlugEntry,
  CmsAwareSlugMap,
} from './runtime/localeRoutes';

// i18n runtime — the emitter-facing `i18n()` resolver + its locale-context seam.
// Emitted markup calls `i18n({…})`; `runWithLocale` is how BaseLayout/middleware will
// set the active locale per route. See `runtime/i18n.ts`.
export {
  i18n,
  runWithLocale,
  getLocaleContext,
  localeFromAstro,
} from './runtime/i18n';
export type {
  LocaleContextValue,
  AstroLike,
  I18nOverride,
} from './runtime/i18n';

// Locale middleware factory — wraps each page render in `runWithLocale(...)` so `i18n()`
// resolves per locale. `createLocaleMiddleware(config)` is the pure, testable factory;
// `deriveLocale` is its locale-selection policy. The injected middleware module (the one
// the integration points Astro at) lives at the `meno-astro/runtime/localeMiddleware`
// subpath. See `runtime/middleware.ts`.
export {
  createLocaleMiddleware,
  deriveLocale,
} from './runtime/middleware';
export type {
  LocaleMiddleware,
  LocaleMiddlewareContext,
} from './runtime/middleware';

// loadI18nConfig — read + migrate a converted project's i18n config (server/build helper).
// Also available from `meno-astro/server`; re-exported here as the natural root surface
// for the middleware/integration story. Touches the filesystem (server/build only).
export { loadI18nConfig } from './server/loadI18nConfig';

// loadSiteUrl — read a converted project's public origin (`siteUrl` in
// project.config.json, trailing slash trimmed; null when absent/invalid). Re-exported
// here (alongside loadI18nConfig) so the published BaseLayout can reach it for the
// canonical link + absolute hreflang URLs; `meno-astro/server` is workspace-only and
// not shipped. Touches the filesystem (build/SSR only — runs in BaseLayout frontmatter).
export { loadSiteUrl } from './server/loadSiteUrl';

// loadSlugMappings — the project's MERGED slug map (pages' `meta.slugs` + one entry per
// published CMS item) that drives link localization, LocaleList links, BaseLayout
// hreflang, and the sitemap. `loadPageSlugMappings`/`loadCmsSlugMappings` are the split
// halves the injected locale route enumerates from (pages render page modules; CMS items
// render their `[slug].astro` template with `cms` props). `resolveCmsEntrySlug` is the
// content-layer transform generated `content.config.ts` files apply so an i18n slug
// value reaches the emitted getStaticPaths boilerplate as its default-locale string.
// `has404Page` is the slug-map-FREE existence check the locale route's localized-404
// enumeration gates on (404 is deliberately excluded from the map — see loadSlugMappings).
// Re-exported here (alongside loadI18nConfig) so the published components and generated
// projects can reach them; `meno-astro/server` is workspace-only and not shipped.
// Touch the filesystem (build/SSR only — mtime-cached per file).
export { loadSlugMappings, loadPageSlugMappings, has404Page } from './server/loadSlugMappings';
export { loadCmsSlugMappings, resolveCmsEntrySlug } from './server/loadCmsSlugMappings';

// menoCmsLoader — the content-collection loader the generated `content.config.ts` declares
// (in place of a bare `glob`). Loads published items always; merges DRAFT sidecars over
// published ONLY in dev (`astro dev` provides a file watcher) so localhost/play preview
// unpublished edits while a production `astro build` ships published content only.
// Re-exported here (like resolveCmsEntrySlug) because `meno-astro/server` is workspace-only
// and not shipped — generated projects import it from the main `meno-astro` entry.
export { menoCmsLoader } from './server/menoCmsLoader';
export type { MenoCmsLoaderOptions } from './server/menoCmsLoader';

// loadFontCss — read a project's `fonts` config → `@font-face` CSS + preload tags for
// BaseLayout's <head>. Re-exported here (alongside loadI18nConfig) so the published
// BaseLayout component can reach it; `meno-astro/server` is workspace-only and not
// shipped. Touches the filesystem (build/SSR only — runs in BaseLayout frontmatter).
export { loadFontCss } from './server/loadFontCss';
export type { FontHeadAssets } from './server/loadFontCss';

// loadLibraries — merge a converted project's library tiers (global + component +
// page `meta.libraries`) → external <link>/<script>/inline <style> tags for BaseLayout's
// <head>/body. Re-exported here (alongside loadFontCss) so the published BaseLayout can
// reach it; `meno-astro/server` is workspace-only and not shipped. Touches the filesystem
// (build/SSR only — runs in BaseLayout frontmatter).
export { loadLibraries } from './server/loadLibraries';
export type { PageLibrariesMeta } from './server/loadLibraries';

// loadIconsConfig — read a project's `icons` config (favicon / dark favicon / apple-touch
// icon hrefs the Studio Icons panel writes) → BaseLayout's <link rel="icon"> tags. The
// hrefs point into the project's bridged `/icons/` asset dir (served by the meno()
// integration in dev, copied to dist/ on build). Re-exported here (alongside loadFontCss)
// so the published BaseLayout can reach it; `meno-astro/server` is workspace-only and not
// shipped. Touches the filesystem (build/SSR only — runs in BaseLayout frontmatter).
export { loadIconsConfig } from './server/loadIconsConfig';
export type { IconsConfig } from './server/loadIconsConfig';

// style() runtime — the emitter-facing style resolver (class-name only). Emitted markup
// calls `style(styleObject[, props][, meta])` and `style()` returns just the `class={...}`
// value; the matching utility/interactive CSS is generated at BUILD time by the meno()
// integration (`virtual:meno-utilities.css`), not collected at render time. See
// `runtime/style.ts`.
export { style, inlineStyle } from './runtime/style';
export type { StyleMeta } from './runtime/style';
// linkClass() — applies the `link` UA reset (meno-core's `.olink`, as `block no-underline
// text-inherit`) to a link's class string at render. Used by the Link.astro runtime component
// so every <Link> gets the reset intrinsically — no per-node marker, no re-conversion.
export { linkClass } from './runtime/style';

// href() / embedHtml() / when() runtime — resolve a Link's href / an Embed's html / a
// node's `if` condition when the model value is a prop-`_mapping`. Emitted markup calls
// `href(mapping, __props)` / `embedHtml(mapping, __props)` / `when(mapping, __props)`;
// each mirrors meno-core's resolver (resolveLinkMapping / resolveHtmlMapping /
// resolveConditionalValue). See `runtime/refs.ts`.
export { href, embedHtml, when } from './runtime/refs';

/**
 * Prop-list helper used by generated `.astro`: `list(items, { limit, offset }).map(…)`.
 * Tolerates null/undefined sources and applies offset/limit. (The scope-aware
 * `when()` / `href()` runtime + the CSS-injection integration are the remaining,
 * Astro-toolchain-verified part of Phase 0b.)
 */
export function list<T>(
  source: T[] | null | undefined,
  opts?: { offset?: number; limit?: number },
): T[] {
  let out = Array.isArray(source) ? source : [];
  if (opts?.offset) out = out.slice(opts.offset);
  if (opts?.limit != null) out = out.slice(0, opts.limit);
  return out;
}

// CMS collection list helpers used by generated `.astro`:
//   `const blogList = await getCollectionList("blog", { sort, limit, … }, Astro)`.
// Pulls items from astro:content and applies the JSON runtime's query semantics. `queryList`
// applies a query to an already-fetched array — for a nested collection list whose query
// references the outer loop var (a hoisted getCollectionList can't see it). See collectionList.
export { getCollectionList, queryList, serializeClientCmsData } from './runtime/collectionList';
export type { CollectionListQuery } from './runtime/collectionList';

// CMS filter/sort expression parsing + serialization (pure).
export {
  parseFilterExpression,
  serializeFilterExpression,
  parseSortExpression,
  serializeSortExpression,
} from 'meno-core/shared';

// ---------------------------------------------------------------------------
// resolveProps — the single authoritative prop block for `.astro` components.
//
// A component's frontmatter declares its props exactly once:
//
//   const { text, isMarginTop, class: className } = resolveProps(Astro, {
//     text: { type: "string", default: "Link" },
//     isMarginTop: { type: "boolean", default: false },
//   });
//
// The `{…}` literal is the authoritative prop definition the dialect parser reads
// back into `def.interface`. At runtime this merges `Astro.props` over each def's
// `default` (and always provides `class`, defaulting to ""). The destructured locals
// are typed by inferring each prop's value type from its definition (mirroring the
// old `interface Props` mapping), so editing the file stays fully type-checked.
// ---------------------------------------------------------------------------

/** Map a single prop definition to the runtime value type of that prop. */
type InferMenoProp<D> =
  D extends { type: 'number' } ? number :
  D extends { type: 'boolean' } ? boolean :
  D extends { type: 'link' } ? { href: string; target?: string } :
  D extends { type: 'list' } ? unknown[] :
  D extends { type: 'select'; options: infer O }
    ? (O extends readonly (infer U)[] ? U : string)
    : string; // string, rich-text, image, embed, file → string

/** Map a whole prop-definition record to the destructured locals' value types. */
type InferMenoProps<T extends MenoProps> = { [K in keyof T]: InferMenoProp<T[K]> };

/**
 * Resolve a component's props from `Astro.props`, merging each provided value over
 * its declared `default` and always supplying `class` (defaulting to "").
 *
 * `defs` is the authoritative prop definition (the same literal the dialect parser
 * reads). The `const` type parameter preserves literal `type`/`options` so the
 * returned locals are precisely typed (e.g. `select` options become a string union).
 */
export function resolveProps<const T extends MenoProps>(
  astro: { props: Record<string, unknown> },
  defs: T,
): InferMenoProps<T> & { class: string } {
  const props = astro.props ?? {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(defs)) {
    if (key === 'children') continue;
    const provided = props[key];
    out[key] = provided !== undefined ? provided : (defs[key] as PropDefinition).default;
  }
  out.class = typeof props.class === 'string' ? props.class : '';
  // The instance style object the parent passed (`<Child __menoStyle={…} />`) — read by the
  // root's `inlineStyle()` to drop prop-bound inline declarations the instance overrides (so the
  // instance's utility class wins; see runtime/style.ts). Reserved, never a declared prop.
  if (props.__menoStyle !== undefined) out.__menoStyle = props.__menoStyle;
  // SSR parity: meno-core's renderer runs `resolveI18nInProps` over a component's
  // props before the component renders, so `{ _i18n, … }` leaves ANYWHERE in the
  // props (i18n prop DEFAULTS, raw CMS items forwarded across a component boundary
  // — `<Card post={post} />` — and i18n values inside list-prop items) resolve to
  // the active locale's strings. Without this, such leaves render as
  // `[object Object]` — the emit-side `i18n()` wrap only covers bindings the
  // emitter can prove are CMS data, which a component boundary hides. Instance-site
  // values already resolved by `i18n(...)` pass through unchanged (they're plain
  // strings by now), as does everything when no locale context is open (non-meno
  // usage / unit renders).
  const ctx = getLocaleContext();
  const resolved = ctx ? (resolveI18nInProps(out, ctx.locale, ctx.config) as Record<string, unknown>) : out;
  // Rich-text props are stored as TipTap JSON (or a `{ __richtext__, … }` marker), and the
  // emitter renders a rich-text prop with `set:html={prop}` (the `richTextProps` path in
  // emitTextChild). `set:html` on a raw object string-coerces to "[object Object]", so
  // normalize every `type: "rich-text"` prop to an HTML string here — the one choke point
  // all component props flow through (fixes RichText-style components, collection-list cards,
  // any rich-text prop). Done AFTER i18n resolution so a per-locale rich-text value is
  // unwrapped first; idempotent on plain HTML strings (Embed.astro handles its own `html`
  // prop separately, since it reads Astro.props directly rather than via resolveProps).
  for (const key of Object.keys(defs)) {
    if ((defs[key] as PropDefinition).type === 'rich-text') {
      resolved[key] = toHtmlString(resolved[key]);
    }
  }
  return resolved as InferMenoProps<T> & { class: string };
}
