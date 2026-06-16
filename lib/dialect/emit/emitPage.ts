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
import { createEmitContext, needRuntimeComponent, type EmitOptions } from './emitContext';
import { emitNode, buildClientDataScripts } from './emitNode';
import { serializeLiteral } from './serialize';
import { buildImportLines, IS_EDITOR_MODE_CONST, referencesIsEditorMode } from './frontmatter';
import { importedLibraryUrls } from '../libraryImports';
import { isCmsTemplatePage, buildGetStaticPaths, cmsRouteDirFromUrlPattern, type CmsMetaLike } from '../cmsRoute';

export function emitPage(page: JSONPage, opts?: EmitOptions): string {
  const ctx = createEmitContext();
  const isCms = isCmsTemplatePage(page);
  // A CMS template page destructures `const { cms } = Astro.props` (from getStaticPaths),
  // so `cms` is in scope for the whole body — component instances are forwarded `cms={cms}`.
  // Must be set BEFORE the body walk so renderComponentInstance sees it. `cms` is also a
  // CMS-data root: getStaticPaths passes RAW entry.data, so bare `{{cms.*}}` templates
  // emit wrapped in i18n() (maybeWrapI18n) — otherwise an { _i18n, … } field renders as
  // "[object Object]" on the default-locale route.
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
  // Body sits two spaces in, inside <BaseLayout>.
  const body = page.root ? emitNode(page.root as any, ctx, 2) : '';
  needRuntimeComponent(ctx, 'BaseLayout');
  // Define meno-core's `isEditorMode` global (false in the built artifact) when the body
  // references it, else the bare identifier throws at SSR. See emitComponent for the why.
  if (referencesIsEditorMode(body)) ctx.frontmatterConsts.unshift(IS_EDITOR_MODE_CONST);

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

  const importLines = buildImportLines(ctx, {
    // No `satisfies MenoPageMeta` type annotation is emitted (see below), so there's
    // no type import to add. `satisfies` is a TS-only operator that breaks the
    // esbuild/astro frontmatter parse on build, and the published runtime ships no
    // types anyway — so the annotation was pure build-time fragility.
    typeImports: [],
    componentPrefix,
    componentImportPath,
  });

  const fm: string[] = [];
  // Pull entries from Astro's content layer: CMS template routes need it for
  // getStaticPaths; any page with a CMS collection list needs it to pass into
  // getCollectionList (meno-astro never imports astro:content itself).
  if (isCms || ctx.needsContentApi) fm.push(`import { getCollection } from 'astro:content';`);
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
    fm.push(buildGetStaticPaths((page.meta as { cms: CmsMetaLike }).cms));
    fm.push('');
  }
  // A plain `const meta` (not `export const meta`): the page's meta is only consumed
  // locally by `<BaseLayout meta={meta}>`, never as a module export. Crucially, Astro's
  // compiler fails to hoist an EMPTY `export const meta = {}` out of the component body
  // ("Unexpected export" at build) — a page with no title/description would otherwise
  // break. A local const sidesteps hoisting entirely and works for empty + non-empty meta.
  fm.push(`const meta = ${serializeLiteral(page.meta ?? {}, { indent: 0 })};`);
  if (ctx.frontmatterConsts.length) {
    fm.push('');
    fm.push(...ctx.frontmatterConsts);
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
