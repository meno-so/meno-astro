/**
 * EmitContext — accumulates everything a single `.astro` file needs that is
 * discovered while walking the node tree: component imports, `meno-astro` runtime
 * symbols/components, and frontmatter const declarations (CMS collection queries).
 *
 * The node walker writes the template body; the page/component assembler reads the
 * context afterwards to emit a deterministic frontmatter (alphabetized imports, then
 * the collected consts).
 */

export interface EmitContext {
  /** Names of components referenced by `type:"component"` instances (need a local import). */
  components: Set<string>;
  /**
   * Component name → its emitted tag identifier (see `componentIdentFor`). Tags must be
   * Capitalized JS identifiers, so names like `container` / `GlobalPadding 2` get a
   * sanitized identifier; uniquified so two names that sanitize identically (or shadow a
   * runtime tag like `Link`) never collide in one file. The import path keeps the true
   * name — the parser maps tags back through it (ParseContext.componentImports).
   */
  componentIdents: Map<string, string>;
  /** Symbols imported from `meno-astro` (e.g. style, i18n, list, getCollectionList, when, embedHtml). */
  runtime: Set<string>;
  /** Astro components imported from `meno-astro/components` (e.g. LocaleList, MenoImage). */
  runtimeComponents: Set<string>;
  /** Frontmatter `const … = …` lines (collection-list queries), in insertion order. */
  frontmatterConsts: string[];
  /**
   * Filter-wired collection lists (a list with `emitTemplate: true`) discovered while
   * walking the body — `{ collection, binding }` where `binding` is the
   * `getCollectionList(...)` frontmatter const. The page/component assembler emits, after
   * the body, one inline `<script type="application/json" id="meno-cms-<collection>">` per
   * DISTINCT collection (carrying `serializeClientCmsData(<binding>)`), so the client-side
   * MenoFilter runtime has the real item data (type coercion, range filters, facet/total
   * counts) instead of only the DOM-only `data-<field>` substrate. Emit-only: the parser
   * drops the script (it's re-derived from the list's `emitTemplate` on every emit).
   */
  clientDataCollections: Array<{ collection: string; binding: string }>;
  /**
   * Stack of active list loop-item variable names (e.g. `post` inside a
   * `blogList.map((post, …) => …)`). A component instance emitted inside a list
   * passes these so a CMS-card component bound to `{{post.title}}` receives the item
   * (which it declares from `Astro.props` — see emitComponent's item bindings).
   */
  loopVars: string[];
  /**
   * Identifiers resolvable in the current emit scope, used to gate ambient-prop
   * forwarding (renderComponentInstance) so a forward never references an undefined var.
   * In a component: its declared prop names PLUS its own ambient bindings (the identifiers
   * it itself reads from `Astro.props` — its `collectItemBindings` result). On a page:
   * empty (pages have no props; `cms` stays handled by the `cms={cms}` special case, and
   * loop vars are checked separately against `ctx.loopVars` — they push/pop during list
   * emit, so they are NOT baked in here). Set before the body walk by emitComponent/emitPage.
   */
  inScope: Set<string>;
  /**
   * Component name → the ambient identifiers that component's body reads from `Astro.props`
   * (its precomputed `collectItemBindings` result). When emitting a `<Child …/>` instance,
   * each such identifier in scope here (`inScope`/`loopVars`) and not already passed is
   * forwarded `name={name}` — meno-core inherits the enclosing prop scope, Astro components
   * are isolated. From EmitOptions; absent for flat/test emit (forwarding then no-ops).
   */
  componentAmbientBindings?: Record<string, string[]>;
  /**
   * True when the file emits a CMS collection list, so the page/component must
   * `import { getCollection } from 'astro:content'` and pass it to getCollectionList
   * (meno-astro never imports astro:content itself — see runtime/collectionList).
   */
  needsContentApi: boolean;
  /**
   * True when `cms` is in the surrounding render scope — a CMS template page (which
   * destructures `const { cms } = Astro.props` from getStaticPaths) or a component that
   * itself receives `cms`. In meno-core the CMS item flows to all descendants implicitly;
   * Astro components are isolated, so a component instance emitted here is forwarded
   * `cms={cms}` (renderComponentInstance) — otherwise a `<BlogPostBody />` whose body uses
   * `{{cms.featuredImage}}` reads `cms` as undefined and crashes. Set before the body walk.
   */
  cmsInScope?: boolean;
  /**
   * Root identifiers whose bare member-chain templates (`{{root.path}}`) are RAW
   * CMS data in the surrounding render scope, so their expressions emit wrapped in
   * the runtime `i18n()` resolver (`{{cms.title}}` → `{i18n(cms.title)}`): `cms` on
   * a CMS template page / cms-receiving component, plus each active collection
   * list's loop var while its children emit. The default-locale `getStaticPaths`
   * boilerplate and `getCollectionList` pass `entry.data` unresolved — an
   * `{ _i18n, … }` field would interpolate as "[object Object]" without the wrap.
   * `i18n()` is identity for non-i18n values, so wrapping is always safe.
   * See `maybeWrapI18n` (emitNode).
   */
  i18nRoots: Set<string>;
  /**
   * Name of the resolved-props object to pass into `style()` (and href/embed) so
   * prop-`_mapping`s resolve — `'__props'` inside a component, undefined on a page
   * (pages have no props). Set by emitComponent before the body is walked.
   */
  propsVar?: string;
  /**
   * Names of props declared `type:"rich-text"` in this component's interface. A text child
   * that is a bare ref to one of these (`{{text}}`) renders as real HTML via
   * `<Fragment set:html={text} />` — a plain `{text}` would HTML-escape the markup and the
   * inline marks (spans/strong/links) would die. Set by emitComponent before the body walk;
   * undefined on pages (which have no prop interface).
   */
  richTextProps?: Set<string>;
  /**
   * Names of CMS schema fields declared `type:"rich-text"` on a CMS template page
   * (`meta.cms.fields`). A bare `{{cms.<field>}}` text child for one of these renders via
   * `<Fragment set:html={richTextWithComponents(cms.<field>, cmsComponents)} />` — the runtime
   * resolves the raw TipTap object to HTML (a CMS page has no `resolveProps`, so a plain
   * `{i18n(cms.field)}` would string-coerce the object to "[object Object]") and renders
   * embedded `menoComponent` nodes against the generated registry. The parser reverses the
   * call to the `{{…}}` template, so it round-trips. Set by emitPage before the body walk;
   * undefined outside a CMS template page. (The analog of `richTextProps`, but for CMS page fields.)
   */
  cmsRichTextFields?: Set<string>;
  /**
   * True when the body emitted a `richTextWithComponents(…, cmsComponents)` call (a CMS
   * rich-text field bound as a text child), so the file's frontmatter must import the
   * converter-generated component registry: `import { cmsComponents } from '<rel>/cmsComponents'`
   * (`src/cmsComponents.ts`, written by convertProject — see buildCmsComponentsModule).
   * The parser ignores the import (non-`.astro`, named) and the reverse rule drops the
   * registry arg, so the form round-trips. Set by emitTextChild during the body walk.
   */
  needsCmsComponents?: boolean;
  /**
   * The component structure's root node (reference identity). Its emitted `class` attr
   * gets a `root: true` marker so the runtime `style()` merges the INSTANCE class the
   * parent passed (`__props.class`) over the root's own classes — meno-core merges
   * instance styles over the component root's styles, so without this every
   * `class={style(…, { instance: true })}` a parent computes is silently dropped.
   * Set by emitComponent before the body walk; undefined on pages.
   */
  structureRoot?: unknown;
  /** Monotonic counter for generating unique frontmatter binding names. */
  listCounter: number;
  /** Monotonic counter for hoisted verbatim consts (multi-line embed HTML). */
  hoistCounter: number;
  /** Monotonic counter for dynamic-tag consts (`const Tag_0 = \`h${size}\``). */
  tagCounter: number;
  /** Max literal line width before objects/arrays expand. */
  width: number;
}

export function createEmitContext(width = 80): EmitContext {
  return {
    components: new Set(),
    componentIdents: new Map(),
    runtime: new Set(),
    runtimeComponents: new Set(),
    frontmatterConsts: [],
    clientDataCollections: [],
    loopVars: [],
    inScope: new Set(),
    i18nRoots: new Set(),
    needsContentApi: false,
    listCounter: 0,
    hoistCounter: 0,
    tagCounter: 0,
    width,
  };
}

/**
 * Per-file emit options threaded from the converter (and editor save path) so
 * component imports resolve across category subfolders. Absent for flat projects
 * (and tests), where emit falls back to flat `./Name.astro` / `../components/Name.astro`.
 */
export interface EmitOptions {
  /** Component name → its path under `components/` without extension (e.g. `section/Error404`). */
  componentPaths?: Record<string, string>;
  /** For component emit: this component's own path under `components/` (e.g. `ui/Card`). */
  selfPath?: string;
  /**
   * For page emit: this page's own POSIX path under `src/pages/` without extension
   * (e.g. `services/wellness`). Its directory portion sets the `../` depth of the page's
   * component/theme/library imports — a page one folder deep needs `../../components/`,
   * not `../components/`. Absent (or no `/`) = top-level page (depth 0).
   */
  pagePath?: string;
  /**
   * For component emit: the project-wide set of CMS field names declared `type:"rich-text"`
   * across every collection (union). A shared component carries no CMS schema, so a
   * `{{cms.<field>}}` text child can only be recognized as rich-text — and emitted via
   * `set:html={richTextWithComponents(cms.<field>, cmsComponents)}` instead of a string-coercing
   * `{i18n(cms.<field>)}` ("[object Object]") — by name. The wrap passes plain strings through
   * unchanged, so a same-named non-rich-text field is harmless. Built by convertProject from each template's
   * `meta.cms.fields`; absent for flat/test emit. See EmitContext.cmsRichTextFields.
   */
  cmsRichTextFields?: Set<string>;
  /**
   * Component name → the ambient identifiers that component's body reads from `Astro.props`
   * (its `collectItemBindings` result, i.e. `{{X}}` templates referencing neither a declared
   * prop nor a loop var). A parent forwards each such identifier it has in scope onto the
   * `<Child …/>` instance, because meno-core inherits the enclosing prop scope while Astro
   * components are isolated (e.g. an `ArrowLink` reading `{{ctaText}}` from its `CardWayToStart`
   * parent). Built by convertProject / the editor save paths from every component's structure;
   * absent for flat/test emit (forwarding then no-ops). Threaded into EmitContext.
   */
  componentAmbientBindings?: Record<string, string[]>;
}

/**
 * POSIX relative import path from a directory to a target (both '/'-separated,
 * extensionless). `relativeComponentImport('ui', 'section/Hero')` → `'../section/Hero'`.
 */
export function relativeComponentImport(fromDir: string, target: string): string {
  const f = fromDir ? fromDir.split('/').filter(Boolean) : [];
  const t = target.split('/').filter(Boolean);
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  const parts = [...Array(f.length - i).fill('..'), ...t.slice(i)];
  const rel = parts.join('/');
  return rel.startsWith('.') ? rel : './' + rel;
}

/** Register a `meno-astro` runtime symbol and return its name (for fluent use). */
export function needRuntime(ctx: EmitContext, name: string): string {
  ctx.runtime.add(name);
  return name;
}

/** Register a `meno-astro/components` Astro component and return its tag name. */
export function needRuntimeComponent(ctx: EmitContext, name: string): string {
  ctx.runtimeComponents.add(name);
  return name;
}
