/**
 * Shared state the body parser needs from the frontmatter: collection-list bindings,
 * hoisted embed consts, and the set of imported component tag names.
 */

export interface CollectionBinding {
  source: string;
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
  /** `const blogList = await getCollectionList("blog", {…}, Astro)` → binding name → info. */
  collectionBindings: Map<string, CollectionBinding>;
  /** `const __embed0 = \`…\`` → const name → verbatim (un-escaped) HTML. */
  embedConsts: Map<string, string>;
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
}

export function createParseContext(): ParseContext {
  return {
    componentImports: new Map(),
    collectionBindings: new Map(),
    embedConsts: new Map(),
    codeConsts: new Map(),
    tagConsts: new Map(),
  };
}
