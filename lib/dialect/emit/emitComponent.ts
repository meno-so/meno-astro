/**
 * Component assembler — a `StructuredComponentDefinition` → a full `.astro` component
 * file (frontmatter + body + optional <style>/<script>).
 *
 * The single `const { … } = resolveProps(Astro, {…})` call is the authoritative
 * prop block: its `{…}` argument is the serialized prop interface (the parser reads
 * it), and the destructured locals (typed by inference) are emit-only convenience.
 * `__meno` carries the remaining component metadata (category, acceptsStyles,
 * libraries). `defineVars` is NOT in `__meno`: a component's JS that needs its props
 * is emitted as `<script define:vars={{…}}>` (native Astro), reconstructed on parse.
 */

import type { StructuredComponentDefinition } from 'meno-core/shared';
import { createEmitContext, relativeComponentImport, type EmitOptions } from './emitContext';
import { emitNode, collectItemBindings, buildClientDataScripts } from './emitNode';
import { serializeLiteral } from './serialize';
import { buildImportLines, buildPropsBlock, IS_EDITOR_MODE_CONST, referencesIsEditorMode } from './frontmatter';
import { importedLibraryUrls } from '../libraryImports';
import { wrapDefineVarsJs } from '../scriptBind';
import { isBindableIdent } from '../ident';

const META_KEYS = ['category', 'acceptsStyles', 'libraries'] as const;

/**
 * The prop names injected into the client `<script>` via Astro's `define:vars`.
 * `true` → every interface prop (key order, minus `children`); a `string[]` → as given.
 */
function defineVarNames(def: StructuredComponentDefinition): string[] {
  // Non-bindable names (e.g. "Mobile-0") are filtered: `define:vars={{ Mobile-0 }}`
  // shorthand is a syntax error, and there is no destructured local to inject anyway
  // (buildPropsBlock skips them too). Mirrored by normalizeDefineVars' all-props check.
  if (def.defineVars === true) {
    return Object.keys(def.interface ?? {}).filter((k) => k !== 'children' && isBindableIdent(k));
  }
  return (def.defineVars ?? []).filter(isBindableIdent);
}

/**
 * The client `<script>` block. When `defineVars` is set, emit Astro's native
 * `<script define:vars={{ a, b }}>` (which already forces inline — no `is:inline`);
 * otherwise a plain `<script is:inline>`. No script when there is no `javascript`.
 */
function buildScriptBlock(def: StructuredComponentDefinition): string {
  if (!def.javascript) return '';
  if (def.defineVars) {
    const names = defineVarNames(def);
    // Bind `el` (the component root) and `props` (object of the injected prop values) for the
    // user JS — define:vars alone injects only individual prop values, so meno-core-style
    // `el.querySelector(...)` / `props.x` would throw. See scriptBind.
    return `\n\n<script define:vars={{ ${names.join(', ')} }}>\n${wrapDefineVarsJs(def.javascript, names)}\n</script>`;
  }
  return `\n\n<script is:inline>\n${def.javascript}\n</script>`;
}

function pickComponentMeta(def: StructuredComponentDefinition): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const k of META_KEYS) {
    const v = (def as Record<string, unknown>)[k];
    if (v !== undefined) meta[k] = v;
  }
  return meta;
}

export function emitComponent(def: StructuredComponentDefinition, opts?: EmitOptions): string {
  const ctx = createEmitContext();
  // Every component exposes its resolved props as `__props` (see buildPropsBlock); the
  // body's style()/href()/embedHtml() calls pass it so prop-`_mapping`s resolve.
  ctx.propsVar = '__props';
  // Rich-text props (`type:"rich-text"`) carry an HTML string; a bare `{{name}}` text child
  // referencing one must render via `set:html` (see emitTextChild) or its marks are dead.
  ctx.richTextProps = new Set(
    Object.entries(def.interface ?? {})
      .filter(([, d]) => (d as { type?: string })?.type === 'rich-text')
      .map(([name]) => name),
  );
  // CMS-item bindings: identifiers the template references (e.g. `cms` in `{{cms.title}}`,
  // or `post` in `{{post.title}}`) that aren't declared props. Computed before the body
  // walk so a component that itself receives `cms` propagates it (`cms={cms}`) to the
  // component instances it renders (renderComponentInstance) — the CMS context flows down.
  const itemBindings = collectItemBindings(def.structure, Object.keys(def.interface ?? {}));
  if (itemBindings.includes('cms')) {
    ctx.cmsInScope = true;
    // The forwarded `cms={cms}` carries the page's RAW entry data, so this component's
    // own `{{cms.*}}` templates need the same i18n() wrap as the page body (emitPage).
    ctx.i18nRoots.add('cms');
    // A shared component has no CMS schema of its own; the converter passes the project-wide
    // union of rich-text field names so a `{{cms.<field>}}` text child emits via
    // `set:html={richTextWithComponents(cms.<field>, cmsComponents)}` (not the object-coercing
    // `{i18n(cms.<field>)}`). The analog of emitPage's per-page `cmsRichTextFields`.
    // See emitTextChild / EmitOptions.
    if (opts?.cmsRichTextFields) ctx.cmsRichTextFields = opts.cmsRichTextFields;
  }
  // The structure root's class attr is marked `root: true` so the runtime style() merges
  // the instance class the parent passed (`__props.class`) over the root's own classes —
  // meno-core's instance-over-root style merge (see emitClassAttr / runtime/style.ts).
  ctx.structureRoot = def.structure;
  // Identifiers resolvable in this component's module scope: its declared props plus the
  // ambient bindings it itself reads from `Astro.props` (itemBindings). A nested instance
  // may forward any of these to a child that needs them (renderComponentInstance).
  ctx.inScope = new Set([...Object.keys(def.interface ?? {}), ...itemBindings]);
  if (opts?.componentAmbientBindings) ctx.componentAmbientBindings = opts.componentAmbientBindings;
  const body = def.structure ? emitNode(def.structure as any, ctx, 0) : '<slot />';
  // `isEditorMode` is a meno-core global template variable (false outside the Studio
  // editor). The emitted artifact is the production/preview build, so define it as a
  // frontmatter const wherever the body references it — otherwise the bare identifier
  // throws "isEditorMode is not defined" at SSR. Emit-only (parseFrontmatter ignores it),
  // re-derived from the body on every emit, so it round-trips.
  if (referencesIsEditorMode(body)) ctx.frontmatterConsts.unshift(IS_EDITOR_MODE_CONST);

  const componentMeta = pickComponentMeta(def);
  const hasMeta = Object.keys(componentMeta).length > 0;

  // `resolveProps` is the authoritative prop block; every component imports it.
  ctx.runtime.add('resolveProps');

  // No `satisfies MenoComponentMeta` annotation is emitted (see below) — `satisfies`
  // is TS-only and breaks the esbuild/astro frontmatter parse on build, and no types
  // ship with the runtime — so there's no type import to add.
  const typeImports: string[] = [];

  // Categorized projects: resolve sibling-component imports relative to THIS
  // component's own folder (e.g. a `section/` component importing `ui/Button`
  // emits `../ui/Button.astro`). Flat projects keep `./Button.astro`.
  const selfDir = opts?.selfPath ? opts.selfPath.split('/').slice(0, -1).join('/') : '';
  const componentImportPath = opts?.componentPaths
    ? (name: string) => `${relativeComponentImport(selfDir, opts.componentPaths![name] ?? name)}.astro`
    : undefined;

  const importLines = buildImportLines(ctx, { typeImports, componentPrefix: './', componentImportPath });
  // The generated component registry (`src/cmsComponents.ts`) for rich-text-embedded
  // components — the component file sits at `src/components/<selfPath>.astro`, so `src/`
  // is 1 + selfDir-depth hops up. Parser-ignored (named, non-.astro import), re-derived
  // from ctx.needsCmsComponents on every emit, so it round-trips.
  if (ctx.needsCmsComponents) {
    const up = '../'.repeat(1 + (selfDir ? selfDir.split('/').length : 0));
    importLines.push(`import { cmsComponents } from '${up}cmsComponents';`);
  }
  const propsBlock = buildPropsBlock(def.interface);

  // Local libraries (`__meno.libraries`): a bare side-effect import per local CSS / ES-module
  // JS so Vite bundles + fingerprints them (Vite also dedupes a file imported by several
  // components). The component file sits at `src/components/<selfPath>.astro`, so the project
  // root (where `libraries/` lives) is 2 + selfDir-depth hops up. Bare imports are ignored by
  // the parser, so they round-trip — same contract as emitPage's theme.css import. External
  // libs + classic local JS stay as tags rendered by loadLibraries → BaseLayout.
  const libUpToRoot = '../'.repeat(2 + (selfDir ? selfDir.split('/').length : 0));
  const libraryImports = importedLibraryUrls(def.libraries).map((url) => `import '${libUpToRoot}${url.slice(1)}';`);

  // `itemBindings` (computed above, before the body walk) are declared from `Astro.props`
  // so the references resolve in this component's own module scope — the parent list/page
  // passes them (renderComponentInstance).
  const fm: string[] = [];
  // A component containing a CMS collection list must import astro:content's
  // getCollection and pass it to getCollectionList (see runtime/collectionList).
  if (ctx.needsContentApi) fm.push(`import { getCollection } from 'astro:content';`);
  fm.push(...importLines);
  fm.push(...libraryImports);
  fm.push('');
  fm.push(...propsBlock);
  if (itemBindings.length) {
    fm.push(`const { ${itemBindings.join(', ')} } = Astro.props;`);
  }
  if (hasMeta) {
    fm.push('');
    fm.push(`const __meno = ${serializeLiteral(componentMeta, { indent: 0 })};`);
  }
  if (ctx.frontmatterConsts.length) {
    fm.push('');
    fm.push(...ctx.frontmatterConsts);
  }

  // `is:global` — meno-core injects component CSS globally, so the dialect must too.
  // Astro's default scoping would rewrite every selector with a scope attribute, which
  // breaks the two global-CSS idioms component css relies on: selectors that target
  // slotted children (`[data-el="…"] > *` — the slot content comes from ANOTHER
  // component and never carries this component's scope attribute) and selectors that
  // target JS-created elements (created via `document.createElement`, never scoped).
  const styleBlock = def.css ? `\n\n<style is:global>\n${def.css}\n</style>` : '';
  const scriptBlock = buildScriptBlock(def);
  // Inline CMS-data scripts for a filter-wired collection list inside this component —
  // after the structure body, BEFORE the (trailing) <style>/<script> blocks so
  // splitComponentBody strips those from the end and parses the structure root as nodes[0]
  // with the data script dropped (also skipped explicitly in elementToNode). Single-line, so
  // the trailing-`<script>` regex never grabs it as the component client script.
  const clientData = buildClientDataScripts(ctx, 0);
  const bodyBlock = clientData ? `${body}\n${clientData}` : body;

  return `---\n${fm.join('\n')}\n---\n${bodyBlock}\n${styleBlock}${scriptBlock}`.replace(/\n+$/, '\n');
}
