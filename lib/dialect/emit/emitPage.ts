/**
 * Page assembler — a `JSONPage` → a full `.astro` page file.
 *
 * The page `meta` becomes `export const meta = {…} satisfies MenoPageMeta` and the
 * node tree is wrapped in `<BaseLayout meta={meta}>`.
 *
 * **CMS template pages** (`meta.source === 'cms'` + a `meta.cms` schema) emit as an
 * idiomatic Astro dynamic route: an extra `getCollection` import plus a deterministic
 * `getStaticPaths()` + `const { cms } = Astro.props;` block (derived from `meta.cms`)
 * sit ahead of `export const meta`. That block is emit-only boilerplate — the parser
 * recognizes and SKIPS it (like `interface Props`/`resolveProps` for components), so
 * the model round-trips unchanged. The body is identical to a regular page.
 */

import type { JSONPage } from 'meno-core/shared';
import { createEmitContext, needRuntime, needRuntimeComponent, type EmitOptions } from './emitContext';
import { emitNode, buildClientDataScripts, hasTemplate, templateToExpr } from './emitNode';
import { serializeLiteral, rawExpr } from './serialize';
import { buildImportLines, IS_EDITOR_MODE_CONST, referencesIsEditorMode } from './frontmatter';
import { emitStyleValuesConst } from '../styleValues';
import { importedLibraryUrls } from '../libraryImports';
import { isCmsTemplatePage, buildGetStaticPaths, cmsRouteDirFromUrlPattern, type CmsMetaLike } from '../cmsRoute';
import { isSsrPage, ssrSourceNames, buildLoadPageData, ssrRouteParams, SSR_PARAMS_CONST } from '../ssrPage';

export function emitPage(page: JSONPage, opts?: EmitOptions): string {
  const ctx = createEmitContext();
  const isCms = isCmsTemplatePage(page);
  // An SSR page (`meta.source === 'ssr'`) destructures its data sources from
  // `loadPageData(meta.data, Astro)`, so each source name is in scope for the whole body.
  // The names are also CMS-data-style roots: loadPageData returns RAW fetched values, so bare
  // `{{repo.*}}` body templates emit wrapped in i18n() (maybeWrapI18n) for parity with `cms`
  // (i18n() is identity for the plain values a fetch returns; the wrap round-trips generically
  // via reverseI18nWrap). Must be set BEFORE the body walk below.
  const isSsr = !isCms && isSsrPage(page);
  const ssrNames = isSsr ? ssrSourceNames((page.meta as { data?: { sources?: Record<string, unknown> } }).data) : [];
  // Dynamic-route params (`meta.routeParams`): a `[param]` SSR route exposes `const params =
  // Astro.params`, so the body can bind `{{params.slug}}`. NOT added to i18nRoots — param values
  // are plain strings, so they emit as bare `{params.slug}` (round-trips generically).
  const ssrParams = isSsr ? ssrRouteParams(page.meta as { routeParams?: unknown }) : [];
  if (isSsr) {
    for (const name of ssrNames) ctx.i18nRoots.add(name);
    needRuntime(ctx, 'loadPageData'); // the derived `await loadPageData(meta.data, Astro)` boilerplate
  }
  // A CMS template page destructures `const { cms } = Astro.props` (from getStaticPaths),
  // so `cms` is in scope for the whole body — component instances are forwarded `cms={cms}`.
  // Must be set BEFORE the body walk so renderComponentInstance sees it. `cms` is also a
  // CMS-data root: getStaticPaths passes RAW entry.data, so bare `{{cms.*}}` templates
  // emit wrapped in i18n() (maybeWrapI18n) — otherwise an { _i18n, … } field renders as
  // "[object Object]" on the default-locale route.
  // A Sanity-backed CMS template fetches items via getSanityData (NOT astro:content) — its
  // getStaticPaths calls the runtime helper, so register it and suppress the astro:content import.
  const isSanityCms = isCms && (page.meta as { cms?: CmsMetaLike }).cms?.source === 'sanity';
  if (isSanityCms) needRuntime(ctx, 'getSanityData');
  if (isCms) {
    ctx.cmsInScope = true;
    ctx.i18nRoots.add('cms');
    // Rich-text fields render via `set:html={richTextWithComponents(cms.field, cmsComponents)}`
    // (not text interpolation), so a `{{cms.<field>}}` body binding shows HTML instead of
    // "[object Object]". Mirrors emitComponent's richTextProps, but reads the CMS schema.
    // See emitTextChild.
    const fields = (page.meta as { cms?: CmsMetaLike }).cms?.fields ?? {};
    ctx.cmsRichTextFields = new Set(
      Object.entries(fields)
        .filter(([, d]) => (d as { type?: string })?.type === 'rich-text')
        .map(([name]) => name),
    );
  }
  // Pages have no props, so `ctx.inScope` stays empty (createEmitContext default) — a
  // component instance on a page forwards only loop vars (ctx.loopVars) and `cms` (the
  // cms={cms} special case), never an ambient parent prop. Thread the project-wide
  // ambient-bindings map so instances can forward what IS in scope (e.g. a loop var).
  if (opts?.componentAmbientBindings) ctx.componentAmbientBindings = opts.componentAmbientBindings;
  // Authoritative component registry (convertProject only) → lets emitNode drop a
  // `type:"component"` reference to a deleted component rather than emit a hard import to a
  // non-existent `.astro` (FailedToLoadModuleSSR). Gated on dropMissingComponents so the editor
  // save path keeps save→get faithful. See EmitContext.knownComponents.
  if (opts?.componentPaths && opts.dropMissingComponents)
    ctx.knownComponents = new Set(Object.keys(opts.componentPaths));
  // Body sits two spaces in, inside <BaseLayout>.
  const body = page.root ? emitNode(page.root as any, ctx, 2) : '';
  needRuntimeComponent(ctx, 'BaseLayout');
  // Define meno-core's `isEditorMode` global (false in the built artifact) when the body
  // references it, else the bare identifier throws at SSR. See emitComponent for the why.
  if (referencesIsEditorMode(body)) ctx.frontmatterConsts.unshift(IS_EDITOR_MODE_CONST);

  // A CMS template page binds the head fields `meta.title` / `meta.description` to entry data
  // (`{{cms.title}}`). BaseLayout renders `meta.title` straight into `<title>` (only resolving
  // i18n VALUES through i18n()), so a literal "{{cms.title}}" string would print verbatim in the
  // tab — the body's `{{cms.title}}` resolves only because it emits as the JSX expression
  // `{i18n(cms.title)}`. Mirror that here: emit the head fields as the same i18n()-wrapped
  // expression (templateToExpr with the body's ctx), so a mixed binding like `{{cms.title}} | Docs`
  // wraps each part (`` `${i18n(cms.title)} | Docs` ``) and an { _i18n, … } field resolves instead of
  // stringifying to "[object Object]". `cms` is in scope (the getStaticPaths boilerplate destructures
  // it ahead of `const meta`); the parser reverses the wrap (reverseI18nWrap), so it round-trips to
  // the same `{{…}}` template. Only the rendered head fields convert — the nested `cms` schema (with
  // its own `urlPattern` template, read literally by getStaticPaths) stays a literal. Runs BEFORE
  // buildImportLines so a title-only i18n() wrap still registers its `i18n` runtime import.
  let metaForEmit: Record<string, unknown> = (page.meta ?? {}) as Record<string, unknown>;
  // `meta.prerender` is emitted as Astro's own top-level `export const prerender = …` (the
  // per-route static/SSR mechanism), NOT a BaseLayout meta field — so lift it out of the
  // serialized `const meta` literal and emit it separately below. CMS template routes force
  // `prerender = true` (they depend on getStaticPaths), so the override is regular-page-only.
  // SSR pages force `prerender = false` (derived from the type, emitted below) — exclude them
  // here so a stray `meta.prerender` doesn't emit a SECOND `export const prerender`.
  const prerenderOverride =
    !isCms && !isSsr && typeof metaForEmit.prerender === 'boolean' ? (metaForEmit.prerender as boolean) : undefined;
  if ('prerender' in metaForEmit) {
    const { prerender: _prerender, ...rest } = metaForEmit;
    metaForEmit = rest;
  }
  if (isCms) {
    const headFields = ['title', 'description'] as const;
    const bound = (k: string) => typeof metaForEmit[k] === 'string' && hasTemplate(metaForEmit[k] as string);
    if (headFields.some(bound)) {
      metaForEmit = { ...metaForEmit };
      for (const k of headFields) {
        if (bound(k)) metaForEmit[k] = rawExpr(templateToExpr(metaForEmit[k] as string, ctx));
      }
    }
  }

  // Component import prefix is relative to the page file's directory. A top-level page
  // sits at `src/pages/<name>.astro` (depth 0 → `../components/`). A CMS template route
  // lives at `src/pages/<routeDir>/[slug].astro`, so its depth (and thus the number of
  // `../` hops up to `src/components/`) is derived from `meta.cms.urlPattern`. A regular
  // page whose slug contains a `/` (e.g. `services/wellness`) is written to
  // `src/pages/services/wellness.astro`, so its depth comes from the directory portion of
  // `opts.pagePath`. This keeps emit a pure function of the model while emitting a correct
  // relative import (without it, a nested page emits `../components/` and 404s on build).
  const routeDir = isCms
    ? cmsRouteDirFromUrlPattern((page.meta as { cms: CmsMetaLike }).cms.urlPattern)
    : (opts?.pagePath?.split('/').slice(0, -1).join('/') ?? '');
  const depth = routeDir ? routeDir.split('/').length : 0;
  const componentPrefix = `${'../'.repeat(depth + 1)}components/`;

  // With a component→path map (categorized projects), resolve each import to its
  // subfolder (e.g. `../components/section/Error404.astro`); otherwise stay flat.
  const componentImportPath = opts?.componentPaths
    ? (name: string) => `${componentPrefix}${opts.componentPaths![name] ?? name}.astro`
    : undefined;

  // Islands live at `src/islands/<src>`; the page's `../` depth to `src/` is the same as
  // for `components/`. Always provided so a nested page resolves correctly.
  const islandPrefix = `${'../'.repeat(depth + 1)}islands/`;
  // Custom-`.astro` components live at `src/custom/<src>` — same `../` depth to `src/`.
  const customPrefix = `${'../'.repeat(depth + 1)}custom/`;

  const importLines = buildImportLines(ctx, {
    // No `satisfies MenoPageMeta` type annotation is emitted (see below), so there's
    // no type import to add. `satisfies` is a TS-only operator that breaks the
    // esbuild/astro frontmatter parse on build, and the published runtime ships no
    // types anyway — so the annotation was pure build-time fragility.
    typeImports: [],
    componentPrefix,
    componentImportPath,
    islandImportPath: (src) => `${islandPrefix}${src}`,
    customAstroImportPath: (src) => `${customPrefix}${src}`,
  });

  const fm: string[] = [];
  // Pull entries from Astro's content layer: file-backed CMS template routes need it for
  // getStaticPaths; any page with a CMS collection list needs it to pass into getCollectionList
  // (meno-astro never imports astro:content itself). A Sanity-backed CMS template fetches via
  // getSanityData instead, so it must NOT import astro:content (no content collection exists).
  if ((isCms && !isSanityCms) || ctx.needsContentApi) fm.push(`import { getCollection } from 'astro:content';`);
  fm.push(...importLines);
  // The generated component registry (`src/cmsComponents.ts`) for rich-text-embedded
  // components — same `../` depth as the components/ import (both live under `src/`).
  // Parser-ignored (named, non-.astro import), re-derived on every emit; round-trips.
  if (ctx.needsCmsComponents) {
    fm.push(`import { cmsComponents } from '${'../'.repeat(depth + 1)}cmsComponents';`);
  }
  // The project's theme stylesheet (`src/styles/theme.css`, written by convertProject from
  // colors.json) — a plain side-effect CSS import that *defines* the `var(--…)` custom
  // properties every style() references. Same `../` depth as the component imports. Pages
  // are the single global import point (components render inside a page, so `:root` is in
  // scope); the parser ignores bare imports, so this round-trips without a model change.
  fm.push(`import '${'../'.repeat(depth + 1)}styles/theme.css';`);
  // Local libraries (page `meta.libraries`): emit a bare side-effect import per local CSS /
  // ES-module JS so Vite bundles + fingerprints them. The `libraries/` folder sits at the
  // project root (one level above `src/`), so it is `depth + 2` hops up. Bare imports are
  // ignored by the parser (re-derived from meta.libraries on emit), so they round-trip — the
  // same contract as the theme.css import above. External libs + classic local JS stay as
  // tags rendered by loadLibraries → BaseLayout.
  for (const url of importedLibraryUrls(page.meta?.libraries)) {
    fm.push(`import '${'../'.repeat(depth + 2)}${url.slice(1)}';`);
  }
  fm.push('');
  if (isCms) {
    // Deterministic boilerplate, derived from meta.cms (emit-only; parser skips it).
    // `prerender = true` keeps the route statically generated even under `output: 'server'`:
    // a CMS [slug] template gets its `cms` prop from getStaticPaths, which Astro IGNORES for
    // on-demand server routes — so without this the page renders with `Astro.props.cms`
    // undefined and crashes (`Cannot read … 'title'`). Harmless under static output (the
    // default). Recognized as emit-only by the frontmatter scanner, so it round-trips.
    fm.push('export const prerender = true;');
    fm.push(buildGetStaticPaths((page.meta as { cms: CmsMetaLike }).cms));
    fm.push('');
  }
  // An SSR page (`meta.source === 'ssr'`) runs on demand: emit `prerender = false` (derived
  // from the type, NOT meta.prerender — the parser skips it for SSR pages, see parseFrontmatter).
  // The `loadPageData` destructure that consumes it is emitted AFTER `const meta` (it reads
  // meta.data). Mutually exclusive with the CMS branch (isSsr is gated on !isCms).
  if (isSsr) {
    fm.push('export const prerender = false;');
    fm.push('');
  }
  // Per-page static/SSR override for a regular page (CMS routes force prerender=true above,
  // SSR pages force false above). Recognized as emit-only by the frontmatter scanner and folded
  // back into meta.prerender by parseFrontmatter, so it round-trips.
  if (prerenderOverride !== undefined) {
    fm.push(`export const prerender = ${prerenderOverride};`);
    fm.push('');
  }
  // A plain `const meta` (not `export const meta`): the page's meta is only consumed
  // locally by `<BaseLayout meta={meta}>`, never as a module export. Crucially, Astro's
  // compiler fails to hoist an EMPTY `export const meta = {}` out of the component body
  // ("Unexpected export" at build) — a page with no title/description would otherwise
  // break. A local const sidesteps hoisting entirely and works for empty + non-empty meta.
  fm.push(`const meta = ${serializeLiteral(metaForEmit, { indent: 0 })};`);
  // SSR boilerplate — derived from meta, emitted right after `const meta` (loadPageData reads
  // meta.data). Emit-only: frontmatterScan covers it, the parser regenerates it.
  if (isSsr) {
    fm.push('');
    // Dynamic-route param scope (a `[param]` route) — before loadPageData so a source URL like
    // `…/{{params.slug}}` reads it conceptually (interpolation is actually server-side in
    // loadPageData via Astro.params; this const is for BODY bindings).
    if (ssrParams.length) fm.push(SSR_PARAMS_CONST);
    fm.push(buildLoadPageData(ssrNames));
  }
  if (ctx.frontmatterConsts.length) {
    fm.push('');
    fm.push(...ctx.frontmatterConsts);
  }
  // Durable side-channel for hash-fallback utility classes (quotes/brackets values whose value
  // can't live in the class name) — re-derived every emit from the warm registry; the parser
  // restores it (dialect/styleValues.ts) so the value survives a reload.
  const styleValuesConst = emitStyleValuesConst(page);
  if (styleValuesConst) {
    fm.push('');
    fm.push(styleValuesConst);
  }
  // Verbatim frontmatter passthrough — hand-authored statements (foreign imports, helper
  // consts/functions, env access) preserved byte-for-byte after the generated frontmatter.
  // Parser re-captures it identically (extractFrontmatterPassthrough), so it round-trips.
  const passthrough = (page as { _frontmatter?: string })._frontmatter;
  if (typeof passthrough === 'string' && passthrough.trim()) {
    fm.push('');
    fm.push(passthrough.trim());
  }

  // Inline CMS-data scripts for any filter-wired collection list on the page, after the
  // body but inside <BaseLayout> (the getCollectionList bindings are in frontmatter scope).
  // A sibling of the page root, so parsePageRoot's `children[0]` + elementToNode's skip drop
  // it on round-trip. Body is two spaces in.
  const clientData = buildClientDataScripts(ctx, 2);
  const slot = clientData ? `${body}\n${clientData}` : body;
  const wrapped = body ? `<BaseLayout meta={meta}>\n${slot}\n</BaseLayout>` : `<BaseLayout meta={meta} />`;
  return `---\n${fm.join('\n')}\n---\n${wrapped}\n`;
}
