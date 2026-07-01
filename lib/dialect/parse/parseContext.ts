/**
 * Shared state the body parser needs from the frontmatter: collection-list bindings,
 * hoisted embed consts, and the set of imported component tag names.
 */

export interface CollectionBinding {
  source: string;
  query?: Record<string, unknown>;
}

export interface RemoteBinding {
  url: string;
  query?: Record<string, unknown>;
}

export interface SanityBinding {
  documentType: string;
  query?: Record<string, unknown>;
}

/** Absolute byte span of a model node in the original source: `[start, end)`. */
export interface NodeSpan {
  start: number;
  end: number;
}

export interface ParseContext {
  /**
   * `import <Ident> from '../components/<name>.astro'` → tag identifier → component
   * name (the file basename). The emitter capitalizes/sanitizes tags to valid JSX
   * identifiers (`container` → `<Container>`, `GlobalPadding 2` → `<GlobalPadding2>`),
   * so the tag is NOT the component's identity — the import path carries it. The body
   * parser maps component tags back through this so the model (and everything keyed on
   * it: the component loader, /api/component-data) uses the true on-disk name.
   */
  componentImports: Map<string, string>;
  /**
   * Island imports — `import <Ident> from '<rel>/islands/<src>'` where `<src>` is a
   * framework component file (`.tsx/.jsx/.vue/.svelte`). Maps the tag identifier → `src`
   * (the path relative to `src/islands/`, e.g. `Counter.tsx` or `widgets/Chart.vue`). The
   * body parser turns a tag in this map into a `type:"island"` node (NOT a component); the
   * framework is derived from the extension.
   */
  islandImports: Map<string, string>;
  /**
   * Custom-`.astro` imports — `import <Ident> from '<rel>/custom/<src>'` where `<src>` is a
   * hand-authored opaque `.astro` component (a `.astro` import NOT under `components/`). Maps
   * the tag identifier → `src` (the path relative to `src/custom/`, e.g. `Fancy.astro` or
   * `widgets/Box.astro`). The body parser turns a tag in this map into a `type:"custom"` node
   * (an opaque black box Meno renders via Astro but doesn't model), NOT a Meno component.
   */
  customAstroImports: Map<string, string>;
  /**
   * Local name the `list` runtime helper is imported under, when emit aliased it to dodge a
   * prop-name collision (`import { list as list$ } from 'meno-astro'`). Default 'list' (plain
   * import). The body parser recognizes a prop list by `<listHelperLocal>(<src>).map(…)`.
   */
  listHelperLocal?: string;
  /** `const blogList = await getCollectionList("blog", {…}, Astro)` → binding name → info. */
  collectionBindings: Map<string, CollectionBinding>;
  /** `const X = await getRemoteData("https://…", {…}, Astro)` → binding name → info. */
  remoteBindings: Map<string, RemoteBinding>;
  /** `const X = await getSanityData("post", {…}, Astro)` → binding name → info. */
  sanityBindings: Map<string, SanityBinding>;
  /** `const __embed0 = \`…\`` → const name → verbatim (un-escaped) HTML. */
  embedConsts: Map<string, string>;
  /**
   * Every frontmatter `const <ident> = \`…\`` backtick-template const, keyed by name →
   * verbatim (un-escaped) value. A superset of `embedConsts` that also captures a
   * HAND-AUTHORED embed hoist named with anything OTHER than `__embedN` (e.g.
   * `const __iconChat = \`<svg>…\``). The embed body parser resolves `<Embed html={ident} />`
   * against this so a custom-named hoist's HTML is never lost (the emitter re-normalizes the
   * name to `__embedN`). Reserved `__codeN`/`Tag_N` consts are excluded — they are verbatim
   * JS and dynamic-tag templates, not embed HTML.
   */
  templateConsts: Map<string, string>;
  /** `const __code0 = <raw expr>` → const name → verbatim JS expression (hoisted multi-line). */
  codeConsts: Map<string, string>;
  /** `const Tag_0 = \`h${size}\`` → const name → the Meno tag string (`h{{size}}`). */
  tagConsts: Map<string, string>;
  /**
   * Optional sink for source-line mapping: when present, the body parser records the
   * absolute source span of every object node it produces (keyed by node identity).
   * Off by default (the round-trip codec never sets it) so normal parsing is unchanged;
   * `buildAstroLineMap` opts in to recover `.astro` line ranges for the editor/selection.
   */
  spans?: Map<object, NodeSpan>;
  /**
   * Transient guard set only while the expression-list round-trip gate re-parses an emitted
   * candidate (see parseBody's expressionListRoundTrips). It makes the `<expr>.map(…)` →
   * expression-list promotion take its UNGATED branch, so the gate's inner re-parse doesn't
   * recurse into the gate again. Never set during normal parsing.
   */
  _expressionListReparse?: boolean;
}

export function createParseContext(): ParseContext {
  return {
    componentImports: new Map(),
    islandImports: new Map(),
    customAstroImports: new Map(),
    collectionBindings: new Map(),
    remoteBindings: new Map(),
    sanityBindings: new Map(),
    embedConsts: new Map(),
    templateConsts: new Map(),
    codeConsts: new Map(),
    tagConsts: new Map(),
  };
}
