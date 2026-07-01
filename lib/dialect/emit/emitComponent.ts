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
import { emitStyleValuesConst } from '../styleValues';
import { buildImportLines, buildPropsBlock, IS_EDITOR_MODE_CONST, referencesIsEditorMode } from './frontmatter';
import { collectFrontmatterDeclaredNames } from '../parse/frontmatterScan';
import { importedLibraryUrls } from '../libraryImports';
import { wrapDefineVarsJs } from '../scriptBind';
import { isBindableIdent } from '../ident';
import { hasRawHtmlPrefix, stripRawHtmlPrefix } from '../richtext';

const META_KEYS = ['category', 'acceptsStyles', 'libraries'] as const;

/** Recursively shed meno-core's raw-HTML sentinel from every string within a default value. */
function deepStripRawHtml(v: unknown): unknown {
  if (typeof v === 'string') return stripRawHtmlPrefix(v);
  if (Array.isArray(v)) return v.map(deepStripRawHtml);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, deepStripRawHtml(val)]),
    );
  }
  return v;
}

/**
 * Translate the legacy raw-HTML sentinel out of a component's prop interface. A `type:"string"`
 * prop whose default is sentinel-marked raw HTML (e.g. Heading's `text` default
 * `<!--MENO_RAW_HTML-->Connecting Giving<br>…`) is the JSON way of saying "this prop holds rich
 * text" — meno-core's renderer sets innerHTML when the resolved value carries the marker. The
 * meno-astro dialect expresses that as `type:"rich-text"` (its bare `{{text}}` child then emits
 * `<Fragment set:html={text}>` via richTextProps), so promote the type and strip the marker from
 * the default. Without the promotion the binding HTML-escapes and the prop's markup ships as
 * literal text. Recurses into list `itemSchema`s; marker-free interfaces pass through unchanged.
 */
type ComponentInterface = StructuredComponentDefinition['interface'];

function normalizeRawHtmlInterface(iface: ComponentInterface): ComponentInterface {
  if (!iface) return iface;
  let changed = false;
  // The structured PropDefinition union is wide and the per-field rewrites below stay within
  // valid shapes (string→rich-text, default-string stripping), so work loosely and recast on return.
  const out: Record<string, any> = {};
  for (const [name, d] of Object.entries(iface)) {
    let def: any = d;
    if (def.type === 'string' && hasRawHtmlPrefix(def.default)) {
      def = { ...def, type: 'rich-text' };
      changed = true;
    }
    if (def.default !== undefined) {
      const stripped = deepStripRawHtml(def.default);
      if (stripped !== def.default) {
        def = { ...def, default: stripped };
        changed = true;
      }
    }
    if (def.itemSchema && typeof def.itemSchema === 'object') {
      const nested = normalizeRawHtmlInterface(def.itemSchema as ComponentInterface);
      if (nested !== def.itemSchema) {
        def = { ...def, itemSchema: nested };
        changed = true;
      }
    }
    out[name] = def;
  }
  return (changed ? out : iface) as ComponentInterface;
}

/**
 * Runtime helpers whose name could realistically be a user prop and whose every emit call
 * site reads {@link EmitContext.runtimeAliases} (so an alias is honored). Today only `list`
 * qualifies — its sole call site is renderList, and `list` is the conventional prop name for
 * a list component's items (`source: "{{list}}"`), so the collision is common. The parser
 * resolves the alias back from the `import { list as … } from 'meno-astro'` line.
 */
const ALIASABLE_RUNTIME = ['list'] as const;

/**
 * Map each aliasable runtime helper that collides with a destructured prop local to a
 * collision-free alias (`list` → `list$`). Returns an empty map when nothing collides, so
 * non-colliding components emit the plain helper name (no churn).
 */
function computeRuntimeAliases(propInterface: Record<string, unknown> | undefined): Map<string, string> {
  const propNames = new Set(Object.keys(propInterface ?? {}).filter(isBindableIdent));
  const aliases = new Map<string, string>();
  for (const helper of ALIASABLE_RUNTIME) {
    if (!propNames.has(helper)) continue;
    let alias = `${helper}$`;
    while (propNames.has(alias)) alias += '$';
    aliases.set(helper, alias);
  }
  return aliases;
}

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
  // Translate meno-core's raw-HTML sentinel out of the prop interface up front: a
  // `type:"string"` prop with a sentinel-marked default becomes `type:"rich-text"` (and the
  // marker is stripped from defaults), so richTextProps below and the serialized prop block
  // both see the dialect-native shape. See normalizeRawHtmlInterface.
  const iface = normalizeRawHtmlInterface(def.interface);
  // Rich-text props (`type:"rich-text"`) carry an HTML string; a bare `{{name}}` text child
  // referencing one must render via `set:html` (see emitTextChild) or its marks are dead.
  ctx.richTextProps = new Set(
    Object.entries(iface ?? {})
      .filter(([, d]) => (d as { type?: string })?.type === 'rich-text')
      .map(([name]) => name),
  );
  // Rich-text fields nested inside a `type:"list"` prop's `itemSchema` (`tabs.itemSchema.title`
  // is rich-text). A `{{tab.title}}` text child inside `list(tabs).map((tab) => …)` must ALSO
  // render via `set:html` — the list-item analog of richTextProps. Keyed by the list prop name
  // (the list node's `source`); renderList activates it for the loop var while emitting children.
  ctx.richTextItemFields = new Map();
  for (const [name, d] of Object.entries(iface ?? {})) {
    const decl = d as { type?: string; itemSchema?: Record<string, { type?: string }> };
    if (decl?.type !== 'list' || !decl.itemSchema) continue;
    const fields = new Set(
      Object.entries(decl.itemSchema)
        .filter(([, fd]) => fd?.type === 'rich-text')
        .map(([fieldName]) => fieldName),
    );
    if (fields.size) ctx.richTextItemFields.set(name, fields);
  }
  // CMS-item bindings: identifiers the template references (e.g. `cms` in `{{cms.title}}`,
  // or `post` in `{{post.title}}`) that aren't declared props. Computed before the body
  // walk so a component that itself receives `cms` propagates it (`cms={cms}`) to the
  // component instances it renders (renderComponentInstance) — the CMS context flows down.
  // Identifiers the hand-authored frontmatter passthrough (`_frontmatter`) already declares —
  // a custom component reborn as a Meno component fetches its own data there (`const next =
  // …`). Subtract them from the props-derived ambient bindings so emit never writes a SECOND
  // `const next` (a duplicate declaration that breaks `astro build`). The body reference
  // resolves to the passthrough const instead. See collectFrontmatterDeclaredNames.
  const passthroughNames = collectFrontmatterDeclaredNames((def as { _frontmatter?: string })._frontmatter);
  const itemBindings = collectItemBindings(def.structure, [...Object.keys(iface ?? {}), ...passthroughNames]);
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
  ctx.inScope = new Set([...Object.keys(iface ?? {}), ...itemBindings, ...passthroughNames]);
  if (opts?.componentAmbientBindings) ctx.componentAmbientBindings = opts.componentAmbientBindings;
  // Authoritative component registry (convertProject only) → lets emitNode drop a
  // `type:"component"` reference whose source .json was deleted, rather than emit a hard import
  // to a non-existent `.astro` (FailedToLoadModuleSSR). Gated on dropMissingComponents so the
  // editor save path (same componentPaths, but live models) keeps save→get faithful.
  // See EmitContext.knownComponents.
  if (opts?.componentPaths && opts.dropMissingComponents)
    ctx.knownComponents = new Set(Object.keys(opts.componentPaths));
  // A destructured prop local that shares a runtime-helper name would shadow the import
  // (a prop named `list` shadows the `list()` helper → `list(list)` calls the Array). Alias
  // the helper so the call uses a distinct local (`list$(list)`); the prop stays the bare
  // name. Only the `list` helper has a reroutable single call site (renderList) today.
  ctx.runtimeAliases = computeRuntimeAliases(iface);
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

  // Islands live at `src/islands/<src>`; the component file sits at
  // `src/components/<selfPath>.astro`, so `src/` is 1 + selfDir-depth hops up.
  const islandUp = `${'../'.repeat(1 + (selfDir ? selfDir.split('/').length : 0))}islands/`;
  // Custom-`.astro` components live at `src/custom/<src>` — same `../` depth to `src/` as islands.
  const customUp = `${'../'.repeat(1 + (selfDir ? selfDir.split('/').length : 0))}custom/`;
  const importLines = buildImportLines(ctx, {
    typeImports,
    componentPrefix: './',
    componentImportPath,
    islandImportPath: (src) => `${islandUp}${src}`,
    customAstroImportPath: (src) => `${customUp}${src}`,
  });
  // The generated component registry (`src/cmsComponents.ts`) for rich-text-embedded
  // components — the component file sits at `src/components/<selfPath>.astro`, so `src/`
  // is 1 + selfDir-depth hops up. Parser-ignored (named, non-.astro import), re-derived
  // from ctx.needsCmsComponents on every emit, so it round-trips.
  if (ctx.needsCmsComponents) {
    const up = '../'.repeat(1 + (selfDir ? selfDir.split('/').length : 0));
    importLines.push(`import { cmsComponents } from '${up}cmsComponents';`);
  }
  const propsBlock = buildPropsBlock(iface);

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
  // Verbatim frontmatter passthrough — hand-authored statements preserved byte-for-byte.
  // Emitted BEFORE the generated `frontmatterConsts` because a hoisted `__codeN` (a multi-line
  // body expression) may reference a value the passthrough declares (`const __code0 =
  // notes?.map(…)` over a passthrough `const { data: notes } = await …`) — the reverse never
  // happens (the passthrough is the author's original code, predating any emit-generated const).
  // Ordering the other way is a temporal-dead-zone ReferenceError at SSR. Re-captured
  // identically on parse (position-independent), so it round-trips.
  const passthrough = (def as { _frontmatter?: string })._frontmatter;
  if (typeof passthrough === 'string' && passthrough.trim()) {
    fm.push('');
    fm.push(passthrough.trim());
  }
  if (ctx.frontmatterConsts.length) {
    fm.push('');
    fm.push(...ctx.frontmatterConsts);
  }

  // Durable side-channel for hash-fallback utility classes whose value can't live in the class
  // name (quotes/brackets — e.g. grid-template-areas). Re-derived every emit from the warm
  // registry; the parser restores it (dialect/styleValues.ts) so the value survives a reload.
  const styleValuesConst = emitStyleValuesConst(def);
  if (styleValuesConst) {
    fm.push('');
    fm.push(styleValuesConst);
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
