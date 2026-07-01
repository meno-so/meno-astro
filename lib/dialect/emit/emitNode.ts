/**
 * Node walker — turns a Meno node tree into meno-astro dialect markup.
 *
 * Model: every node renders into a self-contained block at *column 0*; a placer
 * (`placeChild`) then shifts that block to its target indent and, when the node has
 * an `if`, wraps it in `{cond && ( … )}`. This separates structure from placement so
 * indentation and conditionals stay simple and deterministic.
 *
 * Two render shapes:
 *   - `element`  → JSX markup (`<div …>…</div>`), placed as-is.
 *   - `expr`     → a JS expression (list `.map(…)`, or an `if`-wrapped node), placed
 *                  inside `{ … }`.
 */

import type { ResponsiveStyleObject } from 'meno-core/shared';
import { singularize, responsiveStylesToClasses, splitVariantPrefix } from 'meno-core/shared';
import { decodeVariantClass } from '../variantClass';
import { serializeLiteral } from './serialize';
import { type EmitContext, needRuntime, needRuntimeComponent } from './emitContext';
import { hasRawHtmlPrefix, isRichTextHtml, stripMenoSpanMarker, stripRawHtmlPrefix } from '../richtext';
import { templateVarName } from '../../runtime/cssValue';

type Node = Record<string, any>;

export type Rendered = { kind: 'element'; markup: string } | { kind: 'expr'; expr: string };

const INDENT = 2;

function pad(n: number): string {
  return ' '.repeat(n);
}

/** Shift every line of a column-0 block to start at `indent`. */
function shift(block: string, indent: number): string {
  const p = pad(indent);
  return block
    .split('\n')
    .map((line) => (line.length ? p + line : line))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Templates: Meno uses `{{ expr }}`. Convert to a JS expression for `{ … }`.
// ---------------------------------------------------------------------------

const TEMPLATE_RE = /\{\{([\s\S]*?)\}\}/g;

export function hasTemplate(s: string): boolean {
  return /\{\{[\s\S]*?\}\}/.test(s);
}

/** Escape literal text for inclusion inside a backtick template literal. Newlines are escaped to
 *  `\n`/`\r` (valid template-literal escapes, same value at runtime) so the literal stays SINGLE-LINE
 *  — an inline `<Fragment set:html={`…`} />` would otherwise be re-indented by `shift` on every emit,
 *  growing the embedded whitespace each round-trip (reverseTemplate decodes them back). */
function escapeBacktick(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/** A bare identifier/member dot-chain (`cms.title.pl`) — the only shape `maybeWrapI18n` wraps. */
const BARE_CHAIN_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/**
 * Wrap a template expression in the runtime `i18n()` resolver when it is a bare
 * member/identifier chain rooted at a CMS-data binding (`ctx.i18nRoots`: `cms` on a CMS
 * template page / cms-receiving component, the loop var inside a collection list):
 * `cms.title` → `i18n(cms.title)`. The default-locale `getStaticPaths` boilerplate and
 * `getCollectionList` pass RAW entry data — an `{ _i18n, … }` field would interpolate as
 * "[object Object]" — while `i18n()` is identity for non-i18n values, so the wrap is
 * always safe (locale-resolved render paths, e.g. the injected LocaleRoute, pass
 * already-resolved strings straight through; so do forced-locale suffixes like
 * `cms.title.pl`). ONLY bare chains are wrapped: operator/ternary/call/index expressions
 * already coerce their operands and are an authored-JS concern (documented boundary).
 * The parser reverses the wrap (`reverseI18nWrap`), so the binding round-trips to the
 * same `{{…}}` template.
 */
function maybeWrapI18n(expr: string, ctx?: EmitContext): string {
  if (!ctx || ctx.i18nRoots.size === 0) return expr;
  if (!BARE_CHAIN_RE.test(expr)) return expr;
  const root = expr.split('.', 1)[0] ?? '';
  if (!ctx.i18nRoots.has(root)) return expr;
  needRuntime(ctx, 'i18n');
  return `i18n(${expr})`;
}

/**
 * meno-core resolves a binding whose data is absent to an empty string; a meno-astro binding
 * compiles to a REAL JS reference, so a `{{cms.*}}` template on a NON-CMS page — where `cms`
 * is never declared — is a build-time `ReferenceError: cms is not defined` instead of empty
 * (the meno-web /features "Connect …with {{cms.field}} syntax" doc-copy bug). Guard such a
 * dead `cms` binding so it renders empty and the build survives: `typeof cms === 'undefined'`
 * is the one reference form that is SAFE on an undeclared identifier, and the chain is never
 * evaluated when `cms` is absent — so it holds at any depth (`cms.a.b.c`). Returns null (no
 * guard) for everything else. Fires ONLY for a bare `cms`/`cms.*` chain with `cms` OUT of
 * scope; a CMS template page (cmsInScope) / cms-receiving component (inScope has `cms`) /
 * an enclosing `cms` loop var keeps the direct reference. The parser reverses the guard back
 * to the `{{cms.*}}` template (reverseDeadCmsGuard), so it round-trips. Bare-chain only, like
 * maybeWrapI18n — operator/call expressions are an authored-JS concern (verbatim-code boundary).
 */
function guardUnscopedCms(inner: string, ctx?: EmitContext): string | null {
  if (!ctx) return null;
  if (!BARE_CHAIN_RE.test(inner)) return null;
  if (inner.split('.', 1)[0] !== 'cms') return null;
  if (ctx.cmsInScope || ctx.inScope.has('cms') || ctx.loopVars.includes('cms')) return null;
  return `typeof cms === 'undefined' ? '' : ${inner}`;
}

/**
 * Value-position wraps for a single template expression, in precedence order: the dead-`cms`
 * build guard (out-of-scope `{{cms.*}}`) first, else the CMS-data i18n() wrap. They are mutually
 * exclusive — `cms` is i18n-wrapped only when it IS in scope, the guard fires only when it isn't.
 */
function wrapTemplateExpr(inner: string, ctx?: EmitContext): string {
  return guardUnscopedCms(inner, ctx) ?? maybeWrapI18n(inner, ctx);
}

/**
 * meno-core's runtime resolver reads a numeric array-index path segment via DOT notation
 * (`categories.0.categoryName` → walk `categories` → `[0]` → `categoryName`, splitting on `.`).
 * JS — and jsep, so `isSupportedTemplateExpression` — reject `.0`: it scans as a float literal,
 * so emitting the dot form verbatim inside `{ … }` is an Astro compile error ("Expected '}' but
 * found '.0'"). Rewrite each member-access dot-number to bracket notation so the expression is
 * valid JS AND a jsep-parseable binding (the parser reads it back as `{{…[0]…}}` — a one-way
 * canonicalization; the bracket form is round-trip stable thereafter). Only a `.` that FOLLOWS
 * an identifier char / `]` / `)` and precedes a pure-digit segment is rewritten — decimal
 * literals (`price * 1.5`, `.5`) and string contents are left untouched.
 */
function numericDotToBracket(expr: string): string {
  if (!expr.includes('.')) return expr;
  let out = '';
  for (let i = 0; i < expr.length; ) {
    const c = expr[i]!;
    // Copy string/template literals verbatim so an embedded `foo.0` inside quotes is never touched.
    if (c === '"' || c === "'" || c === '`') {
      const start = i++;
      while (i < expr.length && expr[i] !== c) {
        if (expr[i] === '\\') i++;
        i++;
      }
      out += expr.slice(start, Math.min(i + 1, expr.length));
      i++;
      continue;
    }
    const prev = out[out.length - 1] ?? '';
    if (c === '.' && /[A-Za-z_$\])]/.test(prev)) {
      let j = i + 1;
      while (j < expr.length && expr[j]! >= '0' && expr[j]! <= '9') j++;
      // A complete numeric segment (≥1 digit) not glued to an identifier (`.0a` is not an index).
      if (j > i + 1 && !(j < expr.length && /[A-Za-z_$]/.test(expr[j]!))) {
        out += `[${expr.slice(i + 1, j)}]`;
        i = j;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Convert a Meno template string to the JS expression that goes inside `{ … }`.
 * - `"{{ expr }}"` (whole string) → `expr`
 * - `"Hi {{name}}!"`              → `` `Hi ${name}!` ``
 *
 * When `ctx` is given (value positions: text children, attributes/props, href, embed
 * html), each expression additionally gets the CMS-data `i18n()` wrap where it applies
 * (`{{cms.title}}` → `i18n(cms.title)`, `"Hi {{cms.name}}"` → `` `Hi ${i18n(cms.name)}` ``)
 * — see {@link maybeWrapI18n}. Callers outside those positions (list sources, `if`
 * conditions, dynamic tags, structured-prop literals) deliberately omit `ctx`.
 */
export function templateToExpr(s: string, ctx?: EmitContext): string {
  const matches = [...s.matchAll(TEMPLATE_RE)];
  // Exactly one template spanning the entire string → bare expression.
  const only = matches[0];
  if (matches.length === 1 && only !== undefined && only.index === 0 && only[0].length === s.length) {
    return wrapTemplateExpr(numericDotToBracket((only[1] ?? '').trim()), ctx);
  }
  // Otherwise build a backtick template literal.
  let out = '';
  let last = 0;
  for (const m of matches) {
    out += escapeBacktick(s.slice(last, m.index!));
    out += `\${${wrapTemplateExpr(numericDotToBracket((m[1] ?? '').trim()), ctx)}}`;
    last = m.index! + m[0].length;
  }
  out += escapeBacktick(s.slice(last));
  return `\`${out}\``;
}

/**
 * Rewrite a list's loop references inside every `{{…}}` template of a string to native JS
 * off the emitted `.map((item, itemIndex[, itemArr]) => …)`. meno-core's runtime binds each
 * item under BOTH the generic names (`item`, `itemIndex`, `itemFirst`, `itemLast`) AND the
 * `itemAs` name variants (see `buildTemplateContext`); a model may reference either.
 *
 * Idiomatic Astro/JS (matching meno-core's own `nodeToAstro` exporter, `replaceItemMetaVars`):
 *   - `item` / `itemIndex` → the loop var / its index param
 *   - `itemFirst` / `<var>First` → `(<var>Index === 0)`
 *   - `itemLast`  / `<var>Last`  → `(<var>Index === <var>Arr.length - 1)`  ← needs the
 *     native 3rd `.map` arg (the array); `acc.needsArr` is flagged so renderList emits it.
 * No synthesized context object is ported — these are plain expressions. Word-boundary
 * anchored so `itemCount`/`lineitem` are untouched.
 */
function rewriteItemRefs(str: string, itemVar: string, acc: { needsArr: boolean }): string {
  const idx = `${itemVar}Index`;
  const first = `(${idx} === 0)`;
  const last = `(${idx} === ${itemVar}Arr.length - 1)`;
  const namedLast = new RegExp(`\\b${itemVar}Last\\b`);
  // The native `.map` array arg is needed for `itemLast` (→ `index === arr.length - 1`) AND
  // for any template that already references the array directly — which happens on a
  // re-emit: a prior emit turned `{{itemLast}}` into `(itemIndex === itemArr.length - 1)`,
  // parse keeps that native form, so the loop var is `…Arr`, not `…Last`. Detect both so the
  // arr param is re-declared and the re-emitted `.map` stays buildable (no `itemArr is not
  // defined`). Idempotent: emit(parse(emit(x))) === emit(parse(emit(parse(emit(x))))).
  const namedArr = new RegExp(`\\b${itemVar}Arr\\b`);
  return str.replace(TEMPLATE_RE, (_m, expr: string) => {
    let s = String(expr);
    if (/\bitemLast\b/.test(s) || namedLast.test(s) || /\bitemArr\b/.test(s) || namedArr.test(s)) {
      acc.needsArr = true;
    }
    // Named (`<var>First`/`<var>Last`) before generic, and before the bare `item` rename.
    if (itemVar !== 'item') {
      s = s
        .replace(new RegExp(`\\b${itemVar}First\\b`, 'g'), first)
        .replace(new RegExp(`\\b${itemVar}Last\\b`, 'g'), last);
    }
    s = s
      .replace(/\bitemIndex\b/g, idx)
      .replace(/\bitemFirst\b/g, first)
      .replace(/\bitemLast\b/g, last)
      .replace(/\bitem\b/g, itemVar);
    return `{{${s}}}`;
  });
}

/**
 * Deep-clone a list's item-template subtree, normalizing generic `item` refs to the loop
 * variable (see {@link rewriteItemRefs}). A nested `type: 'list'` opens a new item scope,
 * so its `children` are left for that inner list's own rewrite; its other fields (e.g. a
 * `source` like `{{item.subItems}}`) are evaluated in THIS scope and so are rewritten.
 */
function rewriteItemRefsInTree<T>(node: T, itemVar: string, acc: { needsArr: boolean }): T {
  if (typeof node === 'string') return rewriteItemRefs(node, itemVar, acc) as unknown as T;
  if (Array.isArray(node)) return node.map((n) => rewriteItemRefsInTree(n, itemVar, acc)) as unknown as T;
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = k === 'children' && obj.type === 'list' ? v : rewriteItemRefsInTree(v, itemVar, acc);
    }
    return out as unknown as T;
  }
  return node;
}

/** Globals/keywords that look like identifiers but are never item bindings. */
const NON_BINDING_ROOTS = new Set([
  'Astro',
  'Math',
  'JSON',
  'Object',
  'Array',
  'Date',
  'Number',
  'String',
  'Boolean',
  'true',
  'false',
  'null',
  'undefined',
  'this',
  // meno-core's editor-mode global: the emitter injects it as `const isEditorMode = false;`
  // wherever the body references it (referencesIsEditorMode). Treating `{{isEditorMode}}` as
  // an item binding too would ALSO emit `const { isEditorMode } = Astro.props;` — two
  // declarations of the same const → esbuild "isEditorMode has already been declared".
  'isEditorMode',
]);

/**
 * Scan a component's structure for the root identifiers its `{{root.…}}` / `{{root}}`
 * templates reference that are NOT declared props and NOT bound by an inner list's
 * loop var — i.e. CMS-item bindings like `post` that the component receives from its
 * parent list. The component declares these from `Astro.props` so its `post.title`
 * references resolve (the parent list passes them; see renderComponentInstance).
 */
export function collectItemBindings(root: unknown, declaredProps: Iterable<string>): string[] {
  const free = new Set<string>();
  const rootOf = (expr: string): string | undefined => expr.trim().match(/^[A-Za-z_$][\w$]*/)?.[0];

  const walk = (node: unknown, bound: Set<string>): void => {
    if (node == null) return;
    if (typeof node === 'string') {
      for (const m of node.matchAll(TEMPLATE_RE)) {
        const r = rootOf(m[1] ?? '');
        if (r && !bound.has(r) && !NON_BINDING_ROOTS.has(r)) free.add(r);
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const n of node) walk(n, bound);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    // A list node binds its own loop vars for its children only; its own fields
    // (source/filter) still reference the surrounding scope.
    let childBound = bound;
    if (obj.type === 'list') {
      const itemVar =
        (obj.itemAs as string) ??
        (obj.sourceType === 'collection' && obj.source ? singularize(obj.source as string) : 'item');
      // Bind the loop var + all loop metadata (generic and itemAs-named) so they are not
      // mistaken for parent-passed item bindings: they resolve to native `.map` expressions
      // inside the list (see rewriteItemRefs), never to `Astro.props`.
      childBound = new Set(bound)
        .add(itemVar)
        .add(`${itemVar}Index`)
        .add(`${itemVar}First`)
        .add(`${itemVar}Last`)
        .add(`${itemVar}Arr`)
        .add('item')
        .add('itemIndex')
        .add('itemFirst')
        .add('itemLast');
    }
    for (const [k, v] of Object.entries(obj)) {
      walk(v, k === 'children' || k === 'default' ? childBound : bound);
    }
  };

  walk(root, new Set(declaredProps));
  return [...free];
}

function isI18nValue(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && (v as Record<string, unknown>)._i18n === true;
}

/** A verbatim-code marker: arbitrary JS the model preserves rather than coercing. */
function isCodeMarker(v: unknown): v is { _code: true; expr: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as Record<string, unknown>)._code === true &&
    typeof (v as Record<string, unknown>).expr === 'string'
  );
}

/**
 * Source for a verbatim JS expression placed inside `{ … }`. Single-line goes inline; multi-line
 * is hoisted to a frontmatter `const __codeN = …;` (column 0, never re-indented by the placer) and
 * referenced by name — mirroring the multi-line embed-HTML hoist.
 *
 * EXCEPT a multi-line expression that contains JSX (`items.map(x => <li/>)`) is NEVER hoisted: the
 * frontmatter is TypeScript, where `<li>` is a type cast (not an element), so esbuild rejects it
 * ("Expected '>' but found 'class'"). A markup expression may span lines, so such code stays inline
 * in the body where JSX is valid. The JSX test is deliberately liberal — a false positive only
 * keeps the expression inline, which is always valid; a missed hoist would break the build.
 */
function codeExpr(expr: string, ctx: EmitContext): string {
  const hasJsx = /<[A-Za-z]/.test(expr) || expr.includes('</');
  if (expr.includes('\n') && !hasJsx) {
    const name = `__code${ctx.hoistCounter++}`;
    ctx.frontmatterConsts.push(`const ${name} = ${expr};`);
    return name;
  }
  return expr;
}

// ---------------------------------------------------------------------------
// Attribute / prop emission
// ---------------------------------------------------------------------------

/**
 * Render one `name=…` attribute. `dropEmptyTemplate` (set for HTML node attributes) emits the
 * meno-core parity guard for an entirely-`{{template}}` value (see below); component props /
 * locale-list props leave it false (they aren't node attributes — meno-core never skip-empties
 * them).
 */
function emitAttr(name: string, value: unknown, ctx: EmitContext, dropEmptyTemplate = false): string {
  if (isCodeMarker(value)) {
    return `${name}={${codeExpr(value.expr, ctx)}}`;
  }
  if (isI18nValue(value)) {
    needRuntime(ctx, 'i18n');
    return `${name}={i18n(${serializeLiteral(value, { indent: INDENT, width: ctx.width })})}`;
  }
  if (typeof value === 'string') {
    // A legacy-JSON value passed to a (rich-text) prop may carry meno-core's raw-HTML
    // sentinel; the receiving prop renders it via `set:html` (richTextProps), so the marker
    // would only ship as a stray HTML comment. Shed it before serializing — the rich-text
    // detection below still fires on the underlying markup. See `../richtext`.
    const str = stripRawHtmlPrefix(value);
    // Rich-text HTML value (a custom span, <strong>, <a>, …) → a backtick template literal
    // so the markup reads cleanly with no `\"` escaping (vs JSON.stringify). The editor-only
    // data-meno-span is stripped (re-added on parse); any nested {{template}} becomes ${…}.
    if (isRichTextHtml(str)) return `${name}={${templateToExpr(stripMenoSpanMarker(str), ctx)}}`;
    if (hasTemplate(str)) {
      const expr = templateToExpr(str, ctx);
      // Parity with meno-core's skipEmptyTemplateAttributes: a NODE attribute that is entirely
      // a single `{{template}}` and resolves to "" must be DROPPED — Astro renders empty
      // strings (`fade=""`), meno-core omits them. A `… || undefined` guard makes Astro omit
      // the attr when it resolves falsy. Only the bare whole-string template form (a backtick
      // literal always carries surrounding text, so it can never be the empty case). The parser
      // reverses the guard back to `{{…}}` (interpretExprValue).
      // A dead-`cms` guard (guardUnscopedCms) already resolves to "" when absent and carries
      // its own reversal; skip the `|| undefined` wrap so the two don't entangle on parse.
      // A nullish-coalescing expr (`a?.b ?? ''`) ALSO already supplies a default, and
      // `X ?? Y || undefined` is a hard JS SyntaxError (unparenthesized `??`/`||` mix) — so skip
      // the guard there too. (`isSupportedTemplateExpression` accepts `?.`/`??` as a binding even
      // though the wrap can't apply; the expr renders natively at build.)
      // A loop INDEX binding (`{{tabIndex}}` → `tabIndex`, where `tab` is an active loop var) is
      // a NUMBER and never the empty string, so meno-core keeps it (`data-x="0"`). The guard
      // would drop index 0 (`0 || undefined` → undefined), which desyncs scripts that select
      // panels via `querySelectorAll('[data-x]')` (the tabbed-hero "two tabs" bug). Emit the bare
      // expr so the 0th item keeps its attribute. (Index vars are `${itemVar}Index`; renderList.)
      const isLoopIndex = ctx.loopVars.some((v) => expr === `${v}Index`);
      if (
        dropEmptyTemplate &&
        expr[0] !== '`' &&
        /^\{\{.+\}\}$/.test(str) &&
        !isLoopIndex &&
        !expr.startsWith('typeof cms ===') &&
        !expr.includes('??')
      ) {
        return `${name}={${expr} || undefined}`;
      }
      return `${name}={${expr}}`;
    }
    if (!str.includes('"') && !str.includes('\n')) return `${name}="${str}"`;
    return `${name}={${JSON.stringify(str)}}`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${name}={${value}}`;
  }
  if (value === null || value === undefined) return `${name}={null}`;
  // objects/arrays (link values, arbitrary structured props). A `{{template}}` nested
  // inside (e.g. `link={{ href: "{{link.href}}" }}`) must be resolved to an expression —
  // the child component can't resolve a parent-scope template. Only switch to the
  // template-aware serializer when one is actually present, so template-free literals
  // keep their existing formatting + round-trip exactly.
  if (deepHasTemplate(value)) return `${name}={${serializeExprLiteral(value)}}`;
  return `${name}={${serializeLiteral(value, { indent: INDENT, width: ctx.width })}}`;
}

/** True when a value deep-contains a `{{…}}` template string. */
function deepHasTemplate(value: unknown): boolean {
  if (typeof value === 'string') return hasTemplate(value);
  if (Array.isArray(value)) return value.some(deepHasTemplate);
  if (value && typeof value === 'object') return Object.values(value).some(deepHasTemplate);
  return false;
}

/** A JS identifier that needs no quoting as an object key. */
function isBareIdent(key: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

/**
 * Serialize a value to a JS expression literal, turning every nested `{{template}}` string
 * into the expression it denotes (`"{{link.href}}"` → `link.href`, `"/p/{{slug}}"` →
 * `` `/p/${slug}` ``). The inverse is `parseLiteral`, which reads bare expressions /
 * backtick literals back into `{{…}}` templates — so structured props round-trip.
 */
function serializeExprLiteral(value: unknown): string {
  if (typeof value === 'string') return hasTemplate(value) ? templateToExpr(value) : JSON.stringify(value);
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(serializeExprLiteral).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${isBareIdent(k) ? k : JSON.stringify(k)}: ${serializeExprLiteral(v)}`,
    );
    return entries.length ? `{ ${entries.join(', ')} }` : '{}';
  }
  return 'null';
}

/** Color CSS prop → its class root, for keeping the `var()` shorthand in variant tables. */
const VARIANT_COLOR_ROOT: Record<string, string> = {
  color: 'text',
  backgroundColor: 'bg',
  borderColor: 'border',
  accentColor: 'accent',
  outlineColor: 'outline',
};

/** The utility class for a CSS prop+value at a breakpoint (engine form), or undefined. */
function variantClassFor(cssProp: string, value: string | number, bp: string): string | undefined {
  if (value === '') return undefined;
  const responsive: ResponsiveStyleObject = { [bp]: { [cssProp]: value } };
  const cls = responsiveStylesToClasses(responsive)[0];
  if (!cls) return cls;
  // A `var(--token)` color value emits the bare token form (`text-muted`) in the static engine, but
  // variant TABLES keep the self-describing `var()` shorthand (`text-(--muted)`) so they round-trip
  // through `decodeVariantClass` without the project token set (the table is parsed/built standalone).
  const root = VARIANT_COLOR_ROOT[cssProp];
  const varMatch = typeof value === 'string' ? value.match(/^var\((--[\w-]+)\)$/) : null;
  if (root && varMatch?.[1]) {
    const bare = `${root}-${varMatch[1].slice(2)}`;
    if (cls.endsWith(bare)) return `${cls.slice(0, -bare.length)}${root}-(${varMatch[1]})`;
  }
  return cls;
}

/**
 * Whether a prop `_mapping` round-trips LOSSLESSLY through the utility-class form — i.e. every value
 * either is empty ("no style for this option") or its generated class decodes back (via
 * `decodeVariantClass`) to the SAME property/value at the SAME breakpoint. The decode re-wraps color
 * var-token shorthands (`text-(--x)` → `var(--x)`), so color-token values DO round-trip and convert.
 * Values whose class can't be recovered exactly — e.g. a quoted/comma font stack, or a registry-less
 * hash class — fail the check and keep the whole mapping on the `style()` path. This is the safety
 * gate that keeps prop-variant class storage exact.
 */
function mappingConvertibleToClasses(
  cssProp: string,
  mapping: { values: Record<string, string | number> },
  bp: string,
): boolean {
  for (const v of Object.values(mapping.values)) {
    if (v === '') continue;
    const cls = variantClassFor(cssProp, v, bp);
    if (!cls) return false;
    const decoded = decodeVariantClass(cls);
    const decodedBp = splitVariantPrefix(cls).breakpoint || 'base';
    if (!decoded || decoded.prop !== cssProp || String(decoded.value) !== String(v) || decodedBp !== bp) return false;
  }
  return true;
}

/**
 * Split a style value into its non-variant part and a prop-driven VARIANT TABLE
 * (`{ propName: { propValue: "utility classes" } }`) — the class form of prop `_mapping`s. Only
 * mappings that round-trip losslessly (`mappingConvertibleToClasses`) are extracted; any other
 * `_mapping` (e.g. color tokens) is left in `withoutMappings` on the `style()` path. Empty
 * breakpoint buckets are preserved. Returns null when nothing was extracted.
 */
function extractVariantTable(
  style: unknown,
): { withoutMappings: unknown; table: Record<string, Record<string, string>> } | null {
  if (!style || typeof style !== 'object') return null;
  const s = style as Record<string, unknown>;
  const responsive = 'base' in s || 'tablet' in s || 'mobile' in s;
  const buckets: Array<[string, Record<string, unknown>]> = responsive
    ? Object.entries(s)
        .filter(([, v]) => v && typeof v === 'object')
        .map(([bp, v]) => [bp, v as Record<string, unknown>])
    : [['base', s as Record<string, unknown>]];

  const table: Record<string, Record<string, string>> = {};
  const without: Record<string, Record<string, unknown>> = {};
  let extracted = false;

  for (const [bp, bucket] of buckets) {
    for (const [cssProp, val] of Object.entries(bucket)) {
      const isMapping = val && typeof val === 'object' && (val as { _mapping?: unknown })._mapping === true;
      if (isMapping && mappingConvertibleToClasses(cssProp, val as { values: Record<string, string | number> }, bp)) {
        extracted = true;
        const m = val as { prop: string; values: Record<string, string | number> };
        const lookup: Record<string, string> = table[m.prop] ?? {};
        table[m.prop] = lookup;
        for (const [key, cssVal] of Object.entries(m.values)) {
          const k = String(key);
          const cls = variantClassFor(cssProp, cssVal, bp);
          // An empty option ("no style") is recorded as an empty entry so it survives round-trip.
          if (cls) lookup[k] = lookup[k] ? `${lookup[k]} ${cls}` : cls;
          else if (!(k in lookup)) lookup[k] = '';
        }
      } else {
        if (!without[bp]) without[bp] = {};
        without[bp][cssProp] = val;
      }
    }
  }
  if (!extracted) return null;

  let withoutMappings: unknown;
  if (responsive) {
    const out: Record<string, unknown> = {};
    for (const bp of Object.keys(s)) if (s[bp] && typeof s[bp] === 'object') out[bp] = without[bp] ?? {};
    withoutMappings = out;
  } else {
    withoutMappings = without.base ?? {};
  }
  return { withoutMappings, table };
}

/**
 * Build the `class={…}` attribute for a node, or null when it carries no style/interactive/label
 * metadata. Static styling emits `class={style(…)}`; a node with losslessly-convertible prop
 * `_mapping`s emits the class form `class={cx(style(static…), variants(props, table))}` (or just
 * `class={variants(props, table)}` when nothing static remains) — table values are utility classes.
 */
/**
 * The cx-able styling fragments for a node's OWN style — the `style(…)` / `variants(…)` calls,
 * minus any `class={…}` wrapper, instance seam, or static-class merge. Shared by the plain
 * `emitClassAttr` (non-root) and the structure-root `cx(…)` form (classAttrFor). `extraMeta`
 * carries caller markers (`instance` / `root`) that fold into the `style()` meta argument.
 * Returns `[]` when the node has no style and no meta (no class attr at all).
 */
function classFragments(node: Node, ctx: EmitContext, extraMeta: Record<string, unknown>): string[] {
  const meta: Record<string, unknown> = { ...extraMeta };
  if (node.interactiveStyles !== undefined) meta.interactive = node.interactiveStyles;
  if (node.label !== undefined) meta.label = node.label;
  if (node.generateElementClass !== undefined) meta.genClass = node.generateElementClass;

  const hasStyle = hasStyleContent(node.style);
  const hasMeta = Object.keys(meta).length > 0;
  if (!hasStyle && !hasMeta) return [];

  // Losslessly-convertible prop `_mapping`s → the class form `variants(props, table)`, combined with
  // any remaining static styling / meta via `cx(style(…), variants(…))`. Lossy mappings (color
  // tokens) fall through to the plain `style(…)` fragment unchanged.
  const variantInfo = extractVariantTable(node.style);
  if (variantInfo) {
    needRuntime(ctx, 'variants');
    const vp = ctx.propsVar ?? 'undefined';
    const tableLit = serializeLiteral(variantInfo.table, { indent: INDENT, width: ctx.width });
    const variantCall = `variants(${vp}, ${tableLit})`;
    if (!hasStyleContent(variantInfo.withoutMappings) && !hasMeta) return [variantCall];
    needRuntime(ctx, 'style');
    const lit = serializeLiteral(variantInfo.withoutMappings ?? {}, { indent: INDENT, width: ctx.width });
    const styleCall = hasMeta
      ? `style(${lit}, ${vp}, ${serializeLiteral(meta, { indent: INDENT, width: ctx.width })})`
      : ctx.propsVar
        ? `style(${lit}, ${ctx.propsVar})`
        : `style(${lit})`;
    return [styleCall, variantCall];
  }

  needRuntime(ctx, 'style');
  const styleLit = serializeLiteral(node.style ?? {}, { indent: INDENT, width: ctx.width });
  // Pass the resolved props object so prop-`_mapping`s resolve (in a component it's
  // `__props`; a page has none). The parser skips the props arg and reads meta from the
  // object-literal arg, so both `style(obj, props, meta)` and `style(obj)` round-trip.
  const propsArg = ctx.propsVar;
  if (!hasMeta) return [propsArg ? `style(${styleLit}, ${propsArg})` : `style(${styleLit})`];
  const metaLit = serializeLiteral(meta, { indent: INDENT, width: ctx.width });
  return [`style(${styleLit}, ${propsArg ?? 'undefined'}, ${metaLit})`];
}

/**
 * Build the `class={…}` attribute for a node, or null when it carries no style/interactive/label
 * metadata. Static styling emits `class={style(…)}`; a node with losslessly-convertible prop
 * `_mapping`s emits the class form `class={cx(style(…), variants(…))}` (or just
 * `class={variants(…)}` when nothing static remains) — table values are utility classes.
 *
 * The COMPONENT STRUCTURE ROOT does NOT come through here — it uses the `cx(…, className)`
 * instance-merge form (see classAttrFor). A component-INSTANCE that is itself a structure root
 * (rare: a component whose root is another component) still flows through renderComponentInstance
 * → here, and keeps the legacy `style(…, { root: true })` merge (the marker is emit-only, dropped
 * on parse, re-derived every emit).
 */
function emitClassAttr(node: Node, ctx: EmitContext, extraMeta?: Record<string, unknown>): string | null {
  const meta: Record<string, unknown> = { ...extraMeta };
  if (ctx.structureRoot !== undefined && node === ctx.structureRoot) meta.root = true;
  const frags = classFragments(node, ctx, meta);
  if (frags.length === 0) return null;
  if (frags.length === 1) return `class={${frags[0]}}`;
  needRuntime(ctx, 'cx');
  return `class={cx(${frags.join(', ')})}`;
}

/**
 * The class attribute for an element-like node, folding in any static `attributes.class`.
 *
 * Non-root nodes keep the historical form (`class={style(…)}`, or `class={style(…) + " static"}`
 * when a foreign static class rides along). The COMPONENT STRUCTURE ROOT instead collapses to the
 * conflict-aware `cx(…)` instance-merge form (spec §8/§9, runtime `cx`):
 *   `class={cx(<own styling…>, "<static>"?, className)}`
 * so the instance class the parent passed (destructured `class: className` in every component)
 * merges over the root's own classes per (breakpoint, CSS property) — the class-level equivalent
 * of meno-core's instance-over-root style merge. `cx` owns the merge, so the root's own fragments
 * carry NO `root: true` meta. Emitted even for a style-less, static-less root (`cx(className)`) —
 * the incoming instance class must still land on the element.
 *
 * Returns the attribute string (or null when a non-root carries no own styling) plus whether the
 * static class was consumed here (so emitAttributes skips re-emitting it as a duplicate `class`).
 */
function classAttrFor(
  node: Node,
  ctx: EmitContext,
  staticSource: unknown,
): { attr: string | null; skipStatic: boolean } {
  if (ctx.structureRoot !== undefined && node === ctx.structureRoot) {
    const frags = classFragments(node, ctx, {});
    const stat = staticClassOf(staticSource);
    const parts = [...frags];
    if (stat !== undefined) parts.push(JSON.stringify(stat));
    // The destructured instance class (`const { …, class: className } = __props`, always bound —
    // see buildPropsBlock). cx drops a falsy arg, so an instance with no override is a no-op.
    parts.push('className');
    needRuntime(ctx, 'cx');
    return { attr: `class={cx(${parts.join(', ')})}`, skipStatic: stat !== undefined };
  }
  const cls = emitClassAttr(node, ctx);
  if (!cls) return { attr: null, skipStatic: false };
  const stat = staticClassOf(staticSource);
  return { attr: stat !== undefined ? mergeStaticClass(cls, stat) : cls, skipStatic: stat !== undefined };
}

/** CSS property name (kebab-case) for a model style key. Idempotent for already-kebab keys. */
function cssPropName(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/**
 * A style value that is a `{{template}}` string (e.g. `gap: "{{gap}}px"`) can't become a
 * static utility class — its value is per-instance — so `style()` and the build-time CSS
 * generator skip it. Mirroring meno-core's JSON→Astro export, those props are emitted as an
 * inline `style={`…`}` attribute instead, with each `{{expr}}` resolved against the render scope
 * (host prop / loop var). Returns the inline declarations as `[name, rawValue]` pairs:
 *   - The value is set on a CSS VARIABLE (`--m-<bp>-<prop>: …`) that the matching utility rule
 *     reads via `var(--m-<bp>-<prop>)` (emitted by style()/the build scan). Because the inline
 *     sets the VARIABLE rather than the property, a `:hover`/`.is-open`/`:checked` interactive rule
 *     that sets the property still wins by specificity instead of losing to an inline declaration
 *     (the dropdown/menu bug). tablet/mobile MUST bridge (an inline style can't carry a media
 *     query); `base` bridges too — EXCEPT on a component ROOT (`isRoot`), where the base
 *     declaration stays DIRECT (`gap: ${gap}px`) so the instance-over-root inline suppression
 *     (`inlineStyle`) governs it. See templateVarName.
 */
function templatedStyleProps(style: unknown, isRoot = false): Array<[string, string]> {
  if (!style || typeof style !== 'object') return [];
  const s = style as Record<string, unknown>;
  const isResponsive = 'base' in s || 'tablet' in s || 'mobile' in s;
  const out: Array<[string, string]> = [];
  const collect = (bp: string, flat: unknown): void => {
    if (!flat || typeof flat !== 'object') return;
    for (const [k, v] of Object.entries(flat as Record<string, unknown>)) {
      if (typeof v !== 'string' || !v.includes('{{')) continue;
      // Root base → the CSS property directly (instance-over-root path). Everything else → the
      // bridging variable, so interactive class rules can override it.
      out.push(bp === 'base' && isRoot ? [cssPropName(k), v] : [templateVarName(bp, k), v]);
    }
  };
  if (isResponsive) {
    collect('base', s.base);
    collect('tablet', s.tablet);
    collect('mobile', s.mobile);
  } else {
    collect('base', s);
  }
  return out;
}

/**
 * Build an inline `style=…` attr for a node's templated style values, or null.
 *
 * On a COMPONENT STRUCTURE ROOT the inline style is emitted through the runtime `inlineStyle(…,
 * __props)` helper instead of a bare template literal: the root's BASE templates render as DIRECT
 * inline declarations (templatedStyleProps), and an inline style outranks the utility class a
 * parent's instance override (`class={style(…, { instance: true })}` + the `__menoStyle` object)
 * lands on the same element. `inlineStyle()` drops any direct declaration the instance overrides so
 * the instance wins, mirroring meno-core's instance-over-root merge (see runtime/style.ts). The
 * root's tablet/mobile templates are emitted as `--m-<bp>-<prop>` variables here too (inlineStyle
 * passes them through — they're never an instance-override key). Non-root nodes (and pages, which
 * have no `propsVar`) keep the plain `style={`…`}` form, with EVERY breakpoint bridged through a
 * variable so interactive class rules can override the declaration.
 */
function emitInlineStyleAttr(node: Node, ctx: EmitContext): string | null {
  const isRoot = ctx.structureRoot !== undefined && node === ctx.structureRoot;
  const props = templatedStyleProps(node.style, isRoot);
  if (props.length === 0) return null;
  // `{{expr}}` → `${expr}` inside a template literal; surrounding text stays literal.
  const resolve = (val: string) => val.replace(TEMPLATE_RE, (_m, e) => `\${${String(e).trim()}}`);
  if (isRoot && ctx.propsVar !== undefined) {
    needRuntime(ctx, 'inlineStyle');
    const entries = props.map(([name, val]) => `${JSON.stringify(name)}: \`${resolve(val)}\``);
    return `style={inlineStyle({ ${entries.join(', ')} }, ${ctx.propsVar})}`;
  }
  const decls = props.map(([name, val]) => `${name}: ${resolve(val)}`);
  return `style={\`${decls.join('; ')}\`}`;
}

/** Whether a style value has any non-empty content worth emitting. */
function hasStyleContent(style: unknown): boolean {
  if (!style || typeof style !== 'object') return false;
  for (const v of Object.values(style as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'object') {
      if (Object.keys(v as object).length > 0) return true;
    } else {
      return true;
    }
  }
  return false;
}

/** HTML `attributes` map → attribute strings. `skipClass` when class was merged into style(). */
function emitAttributes(node: Node, ctx: EmitContext, skipClass = false): string[] {
  if (!node.attributes || typeof node.attributes !== 'object') return [];
  // HTML node attributes: drop entirely-template attrs that resolve to "" (meno-core parity).
  return Object.entries(node.attributes)
    .filter(([k]) => !(skipClass && k === 'class'))
    .map(([k, v]) => emitAttr(k, v, ctx, true));
}

/** A plain static class string (no template/marker) usable in a style() concat, or undefined. */
function staticClassOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' && !hasTemplate(value) ? value : undefined;
}

/**
 * Merge a static class into an emitted `class={style(…)}` attribute:
 * `class={style(…) + " swiper is-logos"}`. A node carrying both a style and a foreign
 * static class (`attributes.class`, e.g. an external-library hook) must emit ONE `class`
 * attribute — duplicate attributes are invalid HTML, and in a real Astro render the
 * browser keeps only the first, silently dropping the foreign class (the meno-core
 * canvas merges them instead, masking the loss). Parse reverses the concat back to
 * `attributes.class` (staticClassSuffix).
 */
function mergeStaticClass(cls: string, staticClass: string): string {
  return `${cls.slice(0, -1)} + ${JSON.stringify(` ${staticClass}`)}}`;
}

// ---------------------------------------------------------------------------
// Children
// ---------------------------------------------------------------------------

const VOID_ELEMENTS = new Set([
  'img',
  'br',
  'hr',
  'input',
  'meta',
  'link',
  'area',
  'base',
  'col',
  'embed',
  'param',
  'source',
  'track',
  'wbr',
]);

/** locale-list keys emitted explicitly (so the passthrough loop skips them). */
const LOCALE_KNOWN_KEYS = new Set([
  'type',
  'if',
  'showCurrent',
  'showSeparator',
  'showFlag',
  'displayType',
  'style',
  'itemStyle',
  'activeItemStyle',
  'separatorStyle',
  'flagStyle',
  'interactiveStyles',
  'label',
  'generateElementClass',
]);

/** If `s` is exactly one `{{ identifier }}` template, return the identifier; else null. */
function bareTemplateIdent(s: string): string | null {
  const m = s.match(/^\{\{\s*([A-Za-z_$][\w$]*)\s*\}\}$/);
  return m ? (m[1] ?? null) : null;
}

/** If `s` is exactly one `{{ root.field }}` template (a two-part member ref, e.g. `tab.title`),
 *  return `{root, field, chain}`; else null. Used to spot a rich-text loop-item field binding. */
function memberTemplate(s: string): { root: string; field: string; chain: string } | null {
  const m = s.match(/^\{\{\s*([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\}\}$/);
  return m ? { root: m[1] ?? '', field: m[2] ?? '', chain: `${m[1]}.${m[2]}` } : null;
}

/** If `s` is exactly one `{{ cms.<field>… }}` template whose top-level field is a CMS rich-text
 *  field in scope, return the inner chain (e.g. `cms.content`); else null. */
function cmsRichTextChain(s: string, ctx: EmitContext): string | null {
  if (!ctx.cmsRichTextFields?.size) return null;
  const m = s.match(/^\{\{\s*(cms\.([A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*)\s*\}\}$/);
  return m && ctx.cmsRichTextFields.has(m[2] ?? '') ? (m[1] ?? null) : null;
}

/**
 * Render a string child (text node) at column 0.
 *
 * Rich text renders as REAL HTML through `<Fragment set:html={…} />` — a plain `{text}`
 * HTML-escapes the value, so a custom span / `<strong>` / `<a>` would ship as literal
 * `&lt;…&gt;` and its scoped CSS would match nothing. Two cases:
 *   - a bare ref to a `type:"rich-text"` prop (`{{text}}`) — recognized by prop type;
 *   - direct rich-text markup typed straight into the body — recognized by content.
 * (See `../richtext`.) Otherwise: a `{{…}}` template → `{expr}`; plain text stays pretty
 * raw when it is a sole, trimmed, markup-free child, else a `{"…"}` expression so adjacent
 * text nodes stay distinct on parse (`forceExpr`). Every form parses back to the same node.
 */
function emitTextChild(text: string, ctx: EmitContext, forceExpr = false): string {
  // A legacy-JSON raw-HTML child (`<!--MENO_RAW_HTML-->{{tab.title}}` or `…literal<br>…`)
  // must render as REAL HTML: strip the meno-core sentinel and route the payload — which may
  // be a bare binding with no detectable tag — through `<Fragment set:html>`. Without this the
  // marker + markup ship as escaped text (a hero heading shows `<!--MENO_RAW_HTML-->Raise
  // more.<br>…` literally). See `../richtext`.
  if (hasRawHtmlPrefix(text)) {
    return `<Fragment set:html={${templateToExpr(stripMenoSpanMarker(stripRawHtmlPrefix(text)), ctx)}} />`;
  }
  const ident = bareTemplateIdent(text);
  if (ident && ctx.richTextProps?.has(ident)) {
    // A `type:"rich-text"` prop can carry embedded project components — a CMS rich-text field
    // forwarded into this component's prop (`<RichBlock body={cms.content} />`) where the field
    // contains a `menoComponent` node. Render the prop through the SAME registry-backed pass the
    // CMS text-child path uses (`richTextWithComponents(<prop>, cmsComponents)`) so those
    // components render instead of leaking as empty `<div data-meno-component>` markers.
    // resolveProps already normalized the prop to an HTML string (URL embeds expanded, generic
    // component markers preserved) and richTextWithComponents is idempotent on strings, so this
    // composes. The parser reverses `richTextWithComponents(<ident>, cmsComponents)` → `{{ident}}`
    // (parseValue), which re-emits here because `ident` is a rich-text prop, so it round-trips.
    ctx.needsCmsComponents = true;
    return `<Fragment set:html={${needRuntime(ctx, 'richTextWithComponents')}(${ident}, cmsComponents)} />`;
  }
  // A CMS rich-text field bound as a text child (`{{cms.content}}`) renders its raw TipTap
  // value as HTML via the runtime `richTextWithComponents()` — a CMS page has no resolveProps,
  // so a plain `{i18n(cms.content)}` would string-coerce the object to "[object Object]", and
  // embedded `menoComponent` nodes need the registry (`cmsComponents`, the generated
  // `src/cmsComponents.ts` this flags an import for) to render as real components. The parser
  // reverses `richTextWithComponents(<chain>, cmsComponents)` → `{{…}}`, so this round-trips.
  const cmsRt = cmsRichTextChain(text, ctx);
  if (cmsRt) {
    ctx.needsCmsComponents = true;
    return `<Fragment set:html={${needRuntime(ctx, 'richTextWithComponents')}(${cmsRt}, cmsComponents)} />`;
  }
  // A rich-text field of a list loop item bound as a text child (`{{tab.title}}` where the
  // list's itemSchema declares `title` as rich-text). The list-item analog of the rich-text
  // PROP branch above: render as REAL HTML via richTextWithComponents (embedded components
  // resolve; inline marks/spans survive) instead of shipping ESCAPED as `{tab.title}` — the
  // literal `<br>`/`<span>`/`<div>` hero-heading bug. renderList registered the loop var's
  // rich-text field names in richTextLoopFields. Round-trips: the parser reverses
  // richTextWithComponents(<chain>, cmsComponents) → `{{chain}}`, re-emitted here next pass.
  const member = memberTemplate(text);
  if (member && ctx.richTextLoopFields?.some((f) => f.itemVar === member.root && f.fields.has(member.field))) {
    ctx.needsCmsComponents = true;
    return `<Fragment set:html={${needRuntime(ctx, 'richTextWithComponents')}(${member.chain}, cmsComponents)} />`;
  }
  // Direct rich-text content (checked before the generic template branch so HTML carrying a
  // {{template}} still renders as markup): strip the editor-only marker, turn {{…}} into ${…}.
  if (isRichTextHtml(text)) return `<Fragment set:html={${templateToExpr(stripMenoSpanMarker(text), ctx)}} />`;
  if (hasTemplate(text)) return `{${templateToExpr(text, ctx)}}`;
  // Multi-line text (contains a newline) is NOT raw-safe: as bare markup its continuation lines get
  // re-indented by `shift` every emit, growing the embedded whitespace each round-trip. The escaped
  // `{JSON.stringify(text)}` form keeps it single-line (and exact); parse reads the string back.
  const safeRaw = !forceExpr && text.length > 0 && text === text.trim() && !/[{}<>\n\r]/.test(text);
  if (safeRaw) return text;
  const literal = JSON.stringify(text);
  // Astro-compiler workaround: a text-expression string literal ENDING in a newline escape
  // (`{"…\n"}`), when the next sibling is an element with element children, miscompiles — the
  // compiler closes the render template early and emits a dangling `$$render\``, surfacing as
  // `Expected "}"`. Padding the braces (`{ "…\n" }`) so the literal doesn't abut `}` dodges it;
  // the parser trims the expression inner, so the text round-trips unchanged. (Webflow paragraph
  // /excerpt text carries trailing newlines, which is where this bites.)
  return /[\n\r]$/.test(text) ? `{ ${literal} }` : `{${literal}}`;
}

/** Render a children value (string | array) to an array of column-0 child blocks. */
function emitChildrenList(children: unknown, ctx: EmitContext): string[] {
  if (children === undefined || children === null) return [];
  if (typeof children === 'string') {
    return children.length ? [emitTextChild(children, ctx)] : [];
  }
  if (!Array.isArray(children)) return [];
  const multi = children.length > 1;
  return children.map((child) =>
    typeof child === 'string' ? emitTextChild(child, ctx, multi) : placeChild(renderNode(child as Node, ctx), 0),
  );
}

/**
 * Compose an element: `<tag attrs>children</tag>` (or self-closing). Returns markup
 * at column 0. Inlines a single one-line child for compactness.
 */
function composeElement(tag: string, attrs: string[], childBlocks: string[], forceVoid = false): string {
  const attrStr = attrs.length ? ` ${attrs.join(' ')}` : '';
  if (forceVoid || childBlocks.length === 0) {
    return `<${tag}${attrStr} />`;
  }
  const onlyChild = childBlocks[0];
  if (childBlocks.length === 1 && onlyChild !== undefined && !onlyChild.includes('\n')) {
    return `<${tag}${attrStr}>${onlyChild}</${tag}>`;
  }
  const inner = childBlocks.map((c) => shift(c, INDENT)).join('\n');
  return `<${tag}${attrStr}>\n${inner}\n</${tag}>`;
}

// ---------------------------------------------------------------------------
// Per-node renderers (build at column 0)
// ---------------------------------------------------------------------------

/**
 * Marker attribute opting an `<img>` into Astro `astro:assets` optimization. Set by the
 * editor; consumed here (emitted as `<MenoImage>` instead of `<img>`) and re-added on parse,
 * so it round-trips without ever appearing as a literal attribute in the output.
 */
export const OPTIMIZE_ATTR = 'data-meno-optimize';

function isOptimizedImg(node: Node): boolean {
  return (
    String(node.tag).toLowerCase() === 'img' &&
    (node.attributes as Record<string, unknown> | undefined)?.[OPTIMIZE_ATTR] === 'true'
  );
}

function renderHtml(node: Node, ctx: EmitContext): Rendered {
  // An `<img data-meno-optimize="true">` emits as the runtime `<MenoImage>` wrapper, which
  // renders Astro's optimizing `<Image>` (astro:assets). See renderMenoImage.
  if (isOptimizedImg(node)) return renderMenoImage(node, ctx);
  let tag = node.tag as string;
  // Dynamic tag (e.g. "h{{size}}") → a frontmatter const referenced as <Tag_N>.
  if (typeof tag === 'string' && hasTemplate(tag)) {
    const varName = `Tag_${ctx.tagCounter++}`;
    ctx.frontmatterConsts.push(`const ${varName} = ${tagToTemplateLiteral(tag)};`);
    tag = varName;
  } else if (typeof tag === 'string' && /^[A-Z]/.test(tag)) {
    // A capitalized static tag on a `type:'node'` is an unknown/custom HTML element —
    // meno-core renders it literally (renderHtmlElement('Container', …); the DOM is
    // case-insensitive). Astro/JSX (and our own parser, parseBody's /^[A-Z]/ rule)
    // would misread `<Container>` as an undefined component → "Component not found".
    // Lowercase it so it emits as — and round-trips back to — a literal element.
    tag = tag.toLowerCase();
  }
  const { attr: clsAttr, skipStatic } = classAttrFor(
    node,
    ctx,
    (node.attributes as Record<string, unknown> | undefined)?.class,
  );
  const attrs = [clsAttr, emitInlineStyleAttr(node, ctx), ...emitAttributes(node, ctx, skipStatic)].filter(
    Boolean,
  ) as string[];
  const isVoid = VOID_ELEMENTS.has(String(node.tag).toLowerCase());
  const childBlocks = isVoid ? [] : emitChildrenList(node.children, ctx);
  return { kind: 'element', markup: composeElement(tag, attrs, childBlocks, isVoid) };
}

/** A tag string with `{{…}}` → an Astro template-literal const value, e.g. `` `h${size}` ``. */
function tagToTemplateLiteral(tag: string): string {
  const body = tag.replace(TEMPLATE_RE, (_m, e) => `\${${String(e).trim()}}`);
  return `\`${body}\``;
}

function renderComponentInstance(node: Node, ctx: EmitContext): Rendered {
  // Dangling reference: an authoritative component registry is in scope (categorized convert /
  // editor save) and this name isn't in it — its source component was deleted while this body
  // kept referencing it. Render nothing (a JSX comment, like the unknown-type fallback in
  // renderNode) WITHOUT registering an import: a hard `import X from './X.astro'` to a file that
  // was never emitted crashes Astro SSR ("FailedToLoadModuleSSR: Could not import …"). The legacy
  // renderer rendered a missing component as nothing, so this preserves behavior + round-trips
  // (re-parse drops the comment; the dangling reference is simply gone). See EmitContext.knownComponents.
  if (ctx.knownComponents && !ctx.knownComponents.has(node.component)) {
    return { kind: 'element', markup: `{/* meno:missing-component ${JSON.stringify(node.component)} */}` };
  }
  const tag = componentIdentFor(ctx, node.component);
  ctx.components.add(node.component);
  const attrs: string[] = [];
  const explicitProps = node.props && typeof node.props === 'object' ? (node.props as Record<string, unknown>) : {};
  const cls = emitClassAttr(node, ctx, hasStyleContent(node.style) ? { instance: true } : undefined);
  // A static `class` prop merges into the style() class attr below (single-attribute rule).
  const statProp = cls ? staticClassOf(explicitProps.class) : undefined;
  for (const [k, v] of Object.entries(explicitProps)) {
    if (k === 'class' && statProp !== undefined) continue;
    attrs.push(emitAttr(k, v, ctx));
  }
  // A PROP-LESS component instance inside a list is an item-bound card (e.g. a
  // BlogListCard whose own body renders `{{post.title}}`): forward the active list
  // loop variables so it receives the item, which it declares from `Astro.props`
  // (see emitComponent). A component that already takes explicit props gets its data
  // that way and needs nothing extra.
  if (Object.keys(explicitProps).length === 0) {
    for (const v of ctx.loopVars) attrs.push(`${v}={${v}}`);
  }
  // Ambient prop forwarding: meno-core renders a nested component's body with access to the
  // ENCLOSING component's prop scope; Astro components are isolated files, so forward each
  // identifier the CHILD reads from `Astro.props` (its precomputed ambient bindings — e.g. an
  // `ArrowLink` whose body renders `{{ctaText}}` from its `CardWayToStart` parent) when it is
  // (a) not already an explicit prop, (b) not `cms` (handled by the special case below), and
  // (c) actually in scope here (a declared prop / this file's own ambient binding / an active
  // loop var) — so a forward never references an undefined variable. NOT gated on explicit-prop
  // count: a child can take a `class` prop AND need an ambient value. The child turns each
  // forward into an explicit instance prop on parse, so this round-trips (idempotent).
  for (const need of ctx.componentAmbientBindings?.[node.component] ?? []) {
    if (need === 'cms') continue;
    if (need in explicitProps) continue;
    if (!ctx.inScope.has(need) && !ctx.loopVars.includes(need)) continue;
    const forwarded = `${need}={${need}}`;
    if (attrs.includes(forwarded)) continue; // dedup vs the prop-less loop-var block above
    attrs.push(forwarded);
  }
  // In a CMS scope the `cms` item flows to every descendant (meno-core propagates it
  // implicitly). Astro components are isolated, so forward `cms={cms}` to each instance —
  // regardless of its other props, since a component can use `{{cms.X}}` internally while
  // also taking explicit props (e.g. `<BlogPostBody />` reading `cms.featuredImage`). Skip
  // when the instance already passes an explicit `cms`; a component that ignores it is
  // unharmed (resolveProps drops undeclared props).
  if (ctx.cmsInScope && !('cms' in explicitProps)) attrs.push('cms={cms}');
  if (cls) attrs.push(statProp !== undefined ? mergeStaticClass(cls, statProp) : cls);
  // The instance style OBJECT, forwarded so the child's root `inlineStyle()` can drop the
  // prop-bound inline declarations this instance overrides — otherwise the instance's utility
  // class (from the `class={style(…, { instance: true })}` above) loses to the root's inline
  // style, since inline outranks classes. Mirrors meno-core's instance-over-root object merge
  // (styleProcessor.mergeComponentStyles). Emit-only plumbing: the parser drops `__menoStyle` and
  // rebuilds `node.style` from the instance class call, so it round-trips (parse(emit(x))===x).
  if (hasStyleContent(node.style)) {
    attrs.push(`__menoStyle={${serializeLiteral(node.style, { indent: INDENT, width: ctx.width })}}`);
  }
  const inlineStyle = emitInlineStyleAttr(node, ctx);
  if (inlineStyle) attrs.push(inlineStyle);
  const childBlocks = emitChildrenList(node.children, ctx);
  return { kind: 'element', markup: composeElement(tag, attrs, childBlocks) };
}

/**
 * Render an island (`type:"island"`) — a BYO framework component placed as
 * `<Counter client:visible initial={3} />`. Unlike a Meno `component`, an island carries
 * no `style()` class, no instance-style merge and no cms/loop/ambient forwarding: it's a
 * framework file, so only its explicit props (and a single `client:*` directive) are
 * emitted. The import resolves to `src/islands/<src>` (buildImportLines + islandImportPath).
 */
function renderIslandInstance(node: Node, ctx: EmitContext): Rendered {
  const src = typeof node.src === 'string' ? node.src : '';
  const tag = islandIdentFor(ctx, src);
  ctx.islands.add(src);
  const attrs: string[] = [];
  // A single client:* hydration directive. Omitted entirely = a server-rendered island
  // (valid Astro, zero JS). `media`/`only` carry a value (media query / framework name);
  // `load`/`idle`/`visible` are bare.
  const client = node.client as { directive?: unknown; value?: unknown } | undefined;
  if (client && typeof client.directive === 'string') {
    attrs.push(
      client.value !== undefined && client.value !== ''
        ? `client:${client.directive}="${String(client.value)}"`
        : `client:${client.directive}`,
    );
  }
  const props = node.props && typeof node.props === 'object' ? (node.props as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(props)) attrs.push(emitAttr(k, v, ctx));
  const childBlocks = emitChildrenList(node.children, ctx);
  return { kind: 'element', markup: composeElement(tag, attrs, childBlocks) };
}

/**
 * Render a custom-`.astro` node (`type:"custom"`) — a hand-authored Astro component under
 * `src/custom/` that Meno treats as an OPAQUE black box. Like an island it carries no
 * `style()` class, no instance-style merge and no cms/loop/ambient forwarding (Meno can't
 * introspect a foreign file's prop needs, so only what the user explicitly sets is emitted):
 * just its explicit props and slotted children. Unlike an island it takes no `client:*`
 * directive — a `.astro` component is server-only by nature. The import resolves to
 * `src/custom/<src>` (buildImportLines + customAstroImportPath).
 */
function renderCustomAstro(node: Node, ctx: EmitContext): Rendered {
  const src = typeof node.src === 'string' ? node.src : '';
  const tag = customAstroIdentFor(ctx, src);
  ctx.customAstro.add(src);
  const attrs: string[] = [];
  const props = node.props && typeof node.props === 'object' ? (node.props as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(props)) attrs.push(emitAttr(k, v, ctx));
  const childBlocks = emitChildrenList(node.children, ctx);
  return { kind: 'element', markup: composeElement(tag, attrs, childBlocks) };
}

function renderSlot(node: Node, ctx: EmitContext): Rendered {
  // A named slot (`<slot name="header">`) lets a component expose multiple injection points;
  // the default (unnamed) slot omits the attribute. `node.default` is the fallback content.
  const attrs: string[] = [];
  if (typeof node.name === 'string' && node.name) attrs.push(`name=${JSON.stringify(node.name)}`);
  const def = node.default;
  const childBlocks = def === undefined ? [] : emitChildrenList(def, ctx);
  return { kind: 'element', markup: composeElement('slot', attrs, childBlocks) };
}

/**
 * A static link's `href` must be a string (or a prop-`_mapping`); `target` is a node
 * attribute. A legacy website import stored external links as a `LinkPropValue` object
 * (`{ href, target? }`) sitting at the node-`href` position. Emitting that through `href()`
 * flattens it to the bare URL at build (silently dropping `target`) and the round-tripped
 * object fails the editor's Link schema (`string | LinkMapping`). Flatten it before emit:
 * URL → `href`, `target` → attribute. Prop-`_mapping` / i18n hrefs are left untouched.
 */
function normalizeLinkHref(node: Node): Node {
  const h = node.href as Record<string, unknown> | undefined;
  if (!(h && typeof h === 'object' && !h._mapping && !h._i18n && typeof h.href === 'string')) return node;
  const attributes: Record<string, unknown> = { ...(node.attributes as Record<string, unknown> | undefined) };
  if (typeof h.target === 'string' && h.target && attributes.target === undefined) attributes.target = h.target;
  const next: Node = { ...node, href: h.href };
  if (Object.keys(attributes).length) next.attributes = attributes;
  else delete next.attributes;
  return next;
}

function renderLink(node: Node, ctx: EmitContext): Rendered {
  needRuntimeComponent(ctx, 'Link');
  node = normalizeLinkHref(node);
  const attrs: string[] = [emitHref(node.href, ctx)];
  // No reset marker in the source: the `.olink` reset is applied at render by the Link.astro
  // runtime component (linkClass), so it reaches every link without a per-instance marker or a
  // re-convert. A style-less link emits no class attr at all → Link.astro adds the full reset.
  const { attr: clsAttr, skipStatic } = classAttrFor(
    node,
    ctx,
    (node.attributes as Record<string, unknown> | undefined)?.class,
  );
  if (clsAttr) attrs.push(clsAttr);
  const inlineStyle = emitInlineStyleAttr(node, ctx);
  if (inlineStyle) attrs.push(inlineStyle);
  attrs.push(...emitAttributes(node, ctx, skipStatic));
  const childBlocks = emitChildrenList(node.children, ctx);
  return { kind: 'element', markup: composeElement('Link', attrs.filter(Boolean), childBlocks) };
}

function emitHref(href: unknown, ctx: EmitContext): string {
  if (typeof href === 'string') {
    if (hasTemplate(href)) return `href={${templateToExpr(href, ctx)}}`;
    // A bare `href="…"` attribute can't carry a `"` (or newline) without producing malformed
    // markup that won't re-parse. Mirror emitAttr: route those through the JSON-string
    // expression form `href={"…"}` (parse reverses it via interpretExprValue → parseLiteral).
    // Normal URLs (no quote/newline) keep the exact `href="…"` form, so existing files
    // round-trip identically.
    if (!href.includes('"') && !href.includes('\n')) return `href="${href}"`;
    return `href={${JSON.stringify(href)}}`;
  }
  // LinkMapping / i18n → carry the literal through a runtime resolver.
  if (isI18nValue(href)) {
    needRuntime(ctx, 'i18n');
    return `href={i18n(${serializeLiteral(href, { indent: INDENT, width: ctx.width })})}`;
  }
  needRuntime(ctx, 'href');
  // Thread the host component's resolved props (like style()) so a prop-bound LinkMapping
  // resolves at render. Pages have no props scope → 1-arg form (mapping degrades to "#").
  const hrefLit = serializeLiteral(href, { indent: INDENT, width: ctx.width });
  return ctx.propsVar ? `href={href(${hrefLit}, ${ctx.propsVar})}` : `href={href(${hrefLit})}`;
}

function renderEmbed(node: Node, ctx: EmitContext): Rendered {
  needRuntimeComponent(ctx, 'Embed');
  const attrs: string[] = [];
  if (typeof node.html === 'string') {
    // A `{{template}}` in the HTML (e.g. `{{item.icon}}`) resolves to a native expression
    // (templateToExpr) just like any other attribute — otherwise the literal `{{…}}` ships
    // to the browser. Verbatim HTML (no template) stays a backtick string literal.
    const expr = hasTemplate(node.html) ? templateToExpr(node.html, ctx) : `\`${escapeBacktick(node.html)}\``;
    if (node.html.includes('\n')) {
      // Multi-line HTML must not be re-indented by the placer — hoist it to a frontmatter
      // const (column 0, never shifted) and reference it by name.
      const name = `__embed${ctx.hoistCounter++}`;
      ctx.frontmatterConsts.push(`const ${name} = ${expr};`);
      attrs.push(`html={${name}}`);
    } else {
      attrs.push(`html={${expr}}`);
    }
    // An Embed bound entirely to a CMS rich-text field (`<Embed html={{cms.content}} />`) can
    // carry embedded `menoComponent` nodes — pass the component registry so Embed.astro renders
    // them (richTextWithComponents) instead of leaking empty markers. The `components` attr is
    // emit-only plumbing: re-derived here from the html binding, and dropped on parse, so it
    // round-trips. Same detection (cmsRichTextChain) + registry as the text-child path.
    if (cmsRichTextChain(node.html, ctx)) {
      ctx.needsCmsComponents = true;
      attrs.push('components={cmsComponents}');
    }
  } else {
    needRuntime(ctx, 'embedHtml');
    // Thread props (like style()/href()) so a prop-bound HtmlMapping resolves at render.
    const htmlLit = serializeLiteral(node.html, { indent: INDENT, width: ctx.width });
    attrs.push(ctx.propsVar ? `html={embedHtml(${htmlLit}, ${ctx.propsVar})}` : `html={embedHtml(${htmlLit})}`);
  }
  const { attr: clsAttr, skipStatic } = classAttrFor(
    node,
    ctx,
    (node.attributes as Record<string, unknown> | undefined)?.class,
  );
  if (clsAttr) attrs.push(clsAttr);
  const inlineStyle = emitInlineStyleAttr(node, ctx);
  if (inlineStyle) attrs.push(inlineStyle);
  attrs.push(...emitAttributes(node, ctx, skipStatic));
  return { kind: 'element', markup: composeElement('Embed', attrs, [], true) };
}

/**
 * Render an optimized image (`<img data-meno-optimize="true">`) as the runtime `<MenoImage>`
 * component, which wraps Astro's `astro:assets` `<Image>` (build-time optimization, responsive
 * output). The model stays a plain `img` node — only the marker attribute distinguishes it —
 * so non-optimized images keep emitting as bare `<img>`. The marker itself is consumed (NOT
 * emitted): it is the parse discriminator, re-added on parse. Every other attribute (`src`,
 * `alt`, `width`, `height`, …) plus class/inline-style passes through the same machinery as
 * `renderHtml`, so a templated `src` and full style()/interactive-style parity are preserved.
 */
function renderMenoImage(node: Node, ctx: EmitContext): Rendered {
  needRuntimeComponent(ctx, 'MenoImage');
  // Strip the discriminator marker before emitting attributes (re-added on parse).
  const attributes = { ...(node.attributes as Record<string, unknown>) };
  delete attributes[OPTIMIZE_ATTR];
  const imgNode = { ...node, attributes } as Node;
  // imgNode is a copy → never `=== ctx.structureRoot`, so classAttrFor takes the non-root
  // path here (an optimized image is not treated as a structure root, matching prior behavior).
  const { attr: clsAttr, skipStatic } = classAttrFor(imgNode, ctx, attributes.class);
  const attrs = [clsAttr, emitInlineStyleAttr(imgNode, ctx), ...emitAttributes(imgNode, ctx, skipStatic)].filter(
    Boolean,
  ) as string[];
  // `<img>` is void → self-closing, no children.
  return { kind: 'element', markup: composeElement('MenoImage', attrs, [], true) };
}

/**
 * Render a markdown node (`type:"markdown"`) as the runtime `<Markdown source={…} />`
 * component, which renders `set:html={renderMarkdown(source)}` at build. The source is
 * VERBATIM, whitespace-significant Markdown — never template-resolved (a literal `{{` or
 * `${` in Markdown must survive) — so it always emits as a backtick string literal
 * (escapeBacktick), and multi-line source is hoisted to a never-reindented frontmatter const
 * (`const __mdN = \`…\``) exactly like the embed-node verbatim-HTML path. Class / inline style
 * / passthrough attributes mirror renderEmbed so a styled markdown block round-trips.
 */
function renderMarkdown(node: Node, ctx: EmitContext): Rendered {
  needRuntimeComponent(ctx, 'Markdown');
  const attrs: string[] = [];
  const source = typeof node.source === 'string' ? node.source : '';
  const expr = `\`${escapeBacktick(source)}\``;
  if (source.includes('\n')) {
    // Multi-line Markdown must not be re-indented by the placer — hoist to a frontmatter const.
    const name = `__md${ctx.hoistCounter++}`;
    ctx.frontmatterConsts.push(`const ${name} = ${expr};`);
    attrs.push(`source={${name}}`);
  } else {
    attrs.push(`source={${expr}}`);
  }
  const { attr: clsAttr, skipStatic } = classAttrFor(
    node,
    ctx,
    (node.attributes as Record<string, unknown> | undefined)?.class,
  );
  if (clsAttr) attrs.push(clsAttr);
  const inlineStyle = emitInlineStyleAttr(node, ctx);
  if (inlineStyle) attrs.push(inlineStyle);
  attrs.push(...emitAttributes(node, ctx, skipStatic));
  return { kind: 'element', markup: composeElement('Markdown', attrs, [], true) };
}

function renderLocaleList(node: Node, ctx: EmitContext): Rendered {
  needRuntimeComponent(ctx, 'LocaleList');
  const attrs: string[] = [];
  const boolProps = ['showCurrent', 'showSeparator', 'showFlag'] as const;
  for (const p of boolProps) if (node[p] !== undefined) attrs.push(emitAttr(p, node[p], ctx));
  if (node.displayType !== undefined) attrs.push(emitAttr('displayType', node.displayType, ctx));
  const styleProps = ['style', 'itemStyle', 'activeItemStyle', 'separatorStyle', 'flagStyle'] as const;
  for (const sp of styleProps) {
    if (hasStyleContent(node[sp])) {
      needRuntime(ctx, 'style');
      attrs.push(`${sp}={style(${serializeLiteral(node[sp], { indent: INDENT, width: ctx.width })})}`);
    }
  }
  if (node.interactiveStyles !== undefined || node.label !== undefined || node.generateElementClass !== undefined) {
    const meta: Record<string, unknown> = {};
    if (node.interactiveStyles !== undefined) meta.interactive = node.interactiveStyles;
    if (node.label !== undefined) meta.label = node.label;
    if (node.generateElementClass !== undefined) meta.genClass = node.generateElementClass;
    attrs.push(`meta={${serializeLiteral(meta, { indent: INDENT, width: ctx.width })}}`);
  }
  // Preserve any passthrough scalar props (e.g. a legacy `separator` text).
  for (const [k, v] of Object.entries(node)) {
    if (LOCALE_KNOWN_KEYS.has(k)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      attrs.push(emitAttr(k, v, ctx));
    }
  }
  return { kind: 'element', markup: composeElement('LocaleList', attrs, [], true) };
}

/**
 * The body of `.map((item, …) => ( <body> ))` — a JS *expression* position, NOT JSX
 * children. A placed `{…}` child block (an `if`-wrapped item, a nested list, a text
 * interpolation) sitting bare here is read as an object literal: `( {item.isVisible …} )`
 * parses `item` as a shorthand key, then hits `.` → "Expected }" but found ".". A single
 * bare ELEMENT (or component instance) is already a valid expression and is emitted as-is;
 * anything else is wrapped in `<Fragment>…</Fragment>`, where `{…}` blocks become valid JSX
 * children again. `parseMapExpr` unwraps the Fragment back to the item children, so it
 * round-trips.
 */
function listMapBody(childBlocks: string[]): string {
  const single = childBlocks.length === 1 ? childBlocks[0] : undefined;
  const body =
    single !== undefined && !single.trimStart().startsWith('{') ? single : composeElement('Fragment', [], childBlocks);
  return shift(body, INDENT);
}

function renderList(node: Node, ctx: EmitContext): Rendered {
  const sourceType = node.sourceType ?? 'prop';
  // Loop vars of any ENCLOSING list, captured before this list pushes its own — a query
  // that references one (e.g. a nested docs list filtered by `{{category._id}}`) can't be
  // hoisted to frontmatter and must run inline (queryList). See the collection branch.
  const enclosingLoopVars = [...ctx.loopVars];
  // Compute the loop-item var BEFORE emitting children, and make it visible on the
  // loopVars stack while they emit — so a component instance used as the item
  // template receives the item as a prop (e.g. `<BlogListCard post={post} />`).
  const itemVar = node.itemAs ?? (sourceType === 'collection' && node.source ? singularize(node.source) : 'item');
  const indexVar = `${itemVar}Index`;

  // Resolve every loop reference in the item template to native JS off the `.map` args:
  // a `{{item.text}}` that should be `{{link.text}}` (mixed item/itemAs names), and the
  // metadata `{{itemFirst}}`/`{{itemLast}}` → `(index === 0)` / `(index === arr.length-1)`.
  // `needsArr` tells us whether `itemLast` was used, so the native 3rd `.map` arg (the
  // array) is only emitted when needed.
  const acc = { needsArr: false };
  const itemChildren = rewriteItemRefsInTree(node.children, itemVar, acc);
  const params = acc.needsArr ? `${itemVar}, ${indexVar}, ${itemVar}Arr` : `${itemVar}, ${indexVar}`;

  // Collection items are RAW entry data (getCollectionList returns entry.data), so the
  // loop var is a CMS-data root while the item template emits: bare `{{itemVar.*}}`
  // chains get the i18n() wrap (maybeWrapI18n). Prop lists are excluded — their values
  // arrive through props, which carry locale-resolved values for literal i18n props.
  const isCollection = (node.sourceType ?? 'prop') === 'collection';
  const hadI18nRoot = ctx.i18nRoots.has(itemVar);
  if (isCollection) ctx.i18nRoots.add(itemVar);
  // Activate this list's rich-text item fields for `itemVar` while its children emit, so a
  // `{{itemVar.field}}` binding to a rich-text `itemSchema` field renders as HTML (set:html)
  // rather than shipping escaped. Keyed by the source PROP name (`bareTemplateIdent` unwraps a
  // `{{tabs}}` source; a plain `tabs` passes through). Only prop lists have an itemSchema in the
  // interface, so collection/remote/etc. sources simply find nothing here.
  const sourceName = typeof node.source === 'string' ? (bareTemplateIdent(node.source) ?? node.source) : undefined;
  const richItemFields = sourceName ? ctx.richTextItemFields?.get(sourceName) : undefined;
  if (richItemFields?.size) (ctx.richTextLoopFields ??= []).push({ itemVar, fields: richItemFields });
  ctx.loopVars.push(itemVar);
  const childBlocks = emitChildrenList(itemChildren, ctx);
  ctx.loopVars.pop();
  if (richItemFields?.size) ctx.richTextLoopFields?.pop();
  if (isCollection && !hadI18nRoot) ctx.i18nRoots.delete(itemVar);
  const childRenderedAt2 = listMapBody(childBlocks);

  if (sourceType === 'collection') {
    needRuntime(ctx, 'getCollectionList');
    ctx.needsContentApi = true; // page/component must import + pass getCollection
    const queryKeys = ['filter', 'sort', 'limit', 'offset', 'items', 'excludeCurrentItem', 'emitTemplate'];

    // A query that references an ENCLOSING loop var (e.g. a docs sidebar's inner list
    // filtered by `{{category._id}}`) can't be hoisted — `category` only exists inside the
    // outer `.map`. Fetch the whole collection once in frontmatter, then apply the query
    // INLINE via queryList() where the loop var is in scope. The parser reverses
    // `queryList(<binding>, <query>)` back to this nested collection-list node.
    const queryObj: Record<string, unknown> = {};
    for (const k of queryKeys) if (node[k] !== undefined) queryObj[k] = node[k];
    if (enclosingLoopVars.length > 0 && queryRefsLoopVar(queryObj, enclosingLoopVars)) {
      const binding = uniqueBinding(ctx, `${sanitizeIdent(node.source)}List`);
      // Fetch the whole collection (empty query). The `{}` is REQUIRED: getCollectionList's
      // signature is (source, query, astro, getCollection) — drop it and `Astro` lands in
      // `query`, `getCollection` in `astro`, and the real getCollection arg is undefined →
      // getCollectionList returns [] (the docs-sidebar "all lists empty" bug).
      ctx.frontmatterConsts.push(
        `const ${binding} = await getCollectionList(${JSON.stringify(node.source)}, {}, Astro, getCollection);`,
      );
      needRuntime(ctx, 'queryList');
      const queryExpr = serializeExprLiteral(queryObj);
      // `excludeCurrentItem` needs Astro (reads Astro.props.cms); pass it only then.
      const head =
        queryObj.excludeCurrentItem !== undefined
          ? `queryList(${binding}, ${queryExpr}, Astro)`
          : `queryList(${binding}, ${queryExpr})`;
      const expr = `${head}.map((${params}) => (\n${childRenderedAt2}\n))`;
      return { kind: 'expr', expr };
    }

    const query = listQueryLiteral(node, ctx, queryKeys);
    const binding = uniqueBinding(ctx, `${sanitizeIdent(node.source)}List`);
    // Always emit a query arg (`{}` when none): getCollectionList is (source, query, astro,
    // getCollection); omitting it shifts Astro/getCollection into the wrong params and the
    // list silently returns [] (a query-less collection list — e.g. a plain "all items" loop).
    ctx.frontmatterConsts.push(
      `const ${binding} = await getCollectionList(${JSON.stringify(node.source)}, ${query || '{}'}, Astro, getCollection);`,
    );
    // A filter-wired list (`emitTemplate: true`) also ships its items as inline JSON for the
    // client MenoFilter runtime — registered here, emitted after the body by the page/component
    // assembler (buildClientDataScripts). `getCollectionList` already attached `_url`/`_id` to
    // each item, so the payload's card links resolve. The query keeps `emitTemplate` (it
    // round-trips via the list node), so this re-derives on every emit.
    const mapExpr = `${binding}.map((${params}) => (\n${childRenderedAt2}\n))`;
    if (node.emitTemplate === true) {
      needRuntime(ctx, 'serializeClientCmsData');
      ctx.clientDataCollections.push({ collection: String(node.source), binding });
      // The cards (mapExpr) PLUS a trailing `<template data-meno-item>` inside [data-meno-list]
      // — the template switches the runtime to JSON mode and keys the SSR cards by data-id.
      // Emitted as one element block so both land as children of the [data-meno-list] wrapper.
      const template = buildItemTemplate(itemVar, params, childRenderedAt2, itemChildren);
      return { kind: 'element', markup: `{${mapExpr}}\n${template}` };
    }
    return { kind: 'expr', expr: mapExpr };
  }

  if (sourceType === 'remote') {
    // HTTP-endpoint list: fetch the URL at build/SSR (getRemoteData), then map. The query
    // carries `path` (where the items array lives in the response) + the shared filter/sort/
    // limit/offset. No content API — it's a plain fetch. Parser reverses the binding.
    needRuntime(ctx, 'getRemoteData');
    const query = listQueryLiteral(node, ctx, ['path', 'filter', 'sort', 'limit', 'offset']);
    const binding = uniqueBinding(ctx, deriveRemoteBinding(node.url));
    ctx.frontmatterConsts.push(
      `const ${binding} = await getRemoteData(${JSON.stringify(node.url ?? '')}, ${query || '{}'}, Astro);`,
    );
    return { kind: 'expr', expr: `${binding}.map((${params}) => (\n${childRenderedAt2}\n))` };
  }

  if (sourceType === 'sanity') {
    // Sanity GROQ list: fetch the document type at build/SSR (getSanityData). The projectId/
    // dataset come from project.config.json at RUNTIME (not baked here), so only the document
    // type + the shared filter/sort/limit/offset query are emitted. Parser reverses the binding.
    needRuntime(ctx, 'getSanityData');
    const query = listQueryLiteral(node, ctx, ['filter', 'sort', 'limit', 'offset']);
    const binding = uniqueBinding(ctx, `${sanitizeIdent(node.documentType ?? 'sanity')}List`);
    ctx.frontmatterConsts.push(
      `const ${binding} = await getSanityData(${JSON.stringify(node.documentType ?? '')}, ${query || '{}'}, Astro);`,
    );
    return { kind: 'expr', expr: `${binding}.map((${params}) => (\n${childRenderedAt2}\n))` };
  }

  if (sourceType === 'expression') {
    // Verbatim-expression list: `<source>.map((item, i) => (…))` over arbitrary frontmatter
    // data the dialect can't model (an Astro Action result, a supabase query, …). The source
    // is emitted RAW (no list()/getCollectionList wrapper) — it stands for itself. The item
    // template still binds `itemVar` via the native `.map` args (rewriteItemRefsInTree above).
    return { kind: 'expr', expr: `${String(node.source ?? '')}.map((${params}) => (\n${childRenderedAt2}\n))` };
  }

  // prop list
  needRuntime(ctx, 'list');
  const sourceExpr =
    typeof node.source === 'string' && hasTemplate(node.source)
      ? templateToExpr(node.source)
      : sanitizeIdent(String(node.source));
  const opts = listQueryLiteral(node, ctx, ['limit', 'offset']);
  // Use the (possibly aliased) local name for the `list` helper: a prop named `list` shadows
  // the import, so `list(list)` would call the Array. When aliased, this emits `list$(list)`.
  const listFn = ctx.runtimeAliases?.get('list') ?? 'list';
  const listCall = opts ? `${listFn}(${sourceExpr}, ${opts})` : `${listFn}(${sourceExpr})`;
  const expr = `${listCall}.map((${params}) => (\n${childRenderedAt2}\n))`;
  return { kind: 'expr', expr };
}

/**
 * Inline CMS-data scripts for the filter-wired collection lists discovered while walking a
 * page/component body (`ctx.clientDataCollections`) — emitted by the page/component assembler
 * AFTER the body (a sibling of the page root / component structure root). One
 * `<script type="application/json" id="meno-cms-<collection>">` per DISTINCT collection,
 * carrying the items as escaped JSON via the `serializeClientCmsData(<binding>)` runtime
 * helper; the client MenoFilter runtime reads `#meno-cms-<collection>` on init.
 *
 * Emitted single-line (`…></script>`, no inner newline) so `splitComponentBody`'s
 * trailing-`<script>` regex never mistakes it for the component client-script block, and
 * dropped on parse (it's re-derived from each list's `emitTemplate` flag — see
 * parseBody.elementToNode). `''` when no filter-wired list was emitted.
 */
export function buildClientDataScripts(ctx: EmitContext, indent: number): string {
  if (ctx.clientDataCollections.length === 0) return '';
  const pad = ' '.repeat(indent);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const { collection, binding } of ctx.clientDataCollections) {
    if (seen.has(collection)) continue;
    seen.add(collection);
    lines.push(
      `${pad}<script type="application/json" id="meno-cms-${collection}" is:inline set:html={serializeClientCmsData(${binding})}></script>`,
    );
  }
  return lines.join('\n');
}

/**
 * The `<template data-meno-item>` a filter-wired collection list (`emitTemplate: true`)
 * emits as the LAST child of its `[data-meno-list]` container, after the SSR cards.
 *
 * Its PRESENCE is the switch that makes the client MenoFilter runtime (a) run in JSON mode
 * (filter the embedded data, with type coercion + numeric/range operators — DOM-only mode
 * can't) and (b) key the SSR cards by `data-id` so it reuses them instead of re-rendering.
 * Its CONTENT — the card rendered over a synthetic placeholder item — is only used to render
 * an item that was NOT server-rendered (a `data-id` miss): each `{{<item>.<field>}}` survives
 * as a literal placeholder the runtime substitutes, while `style()` (and any component) calls
 * still resolve to real build-time output, so a client-rendered card matches the SSR ones.
 *
 * The synthetic item supplies every `{{<item>.<field>}}` the card reads (plus `_id`) as that
 * literal string. The parser drops the whole `<template data-meno-item>` (elementToNode), and
 * it is re-derived from the list's `emitTemplate` flag on every emit, so the model round-trips.
 */
function buildItemTemplate(itemVar: string, params: string, childRenderedAt2: string, itemChildren: unknown): string {
  const escaped = itemVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fields = new Set<string>(['_id']);
  const scan = JSON.stringify(itemChildren ?? '');
  for (const m of scan.matchAll(new RegExp(`\\{\\{\\s*${escaped}\\.([\\w$]+)`, 'g'))) fields.add(m[1] ?? '');
  const synthetic = `{ ${[...fields].map((f) => `${JSON.stringify(f)}: ${JSON.stringify(`{{${itemVar}.${f}}}`)}`).join(', ')} }`;
  return `<template data-meno-item>{[${synthetic}].map((${params}) => (\n${childRenderedAt2}\n))[0]}</template>`;
}

/** Build a `{ … }` literal from selected list fields, or '' when none are set. */
function listQueryLiteral(node: Node, ctx: EmitContext, keys: string[]): string {
  const obj: Record<string, unknown> = {};
  for (const k of keys) if (node[k] !== undefined) obj[k] = node[k];
  if (Object.keys(obj).length === 0) return '';
  // A query value carrying a `{{template}}` (e.g. `items: "{{cms.category}}"` on a
  // reference list) must resolve to a JS expression — getCollectionList compares values
  // LITERALLY, so a raw "{{…}}" string matches nothing. Mirrors emitAttr: only switch to the
  // template-aware serializer when one is present, so template-free queries keep their
  // multi-line formatting and round-trip exactly.
  return deepHasTemplate(obj) ? serializeExprLiteral(obj) : serializeLiteral(obj, { indent: INDENT, width: ctx.width });
}

/** True when any `{{loopVar…}}` template (rooted at one of `vars`) appears anywhere in `value`. */
function queryRefsLoopVar(value: unknown, vars: string[]): boolean {
  if (typeof value === 'string') {
    if (!hasTemplate(value)) return false;
    for (const m of value.matchAll(/\{\{\s*([A-Za-z_$][\w$]*)/g)) {
      if (vars.includes(m[1] ?? '')) return true;
    }
    return false;
  }
  if (Array.isArray(value)) return value.some((v) => queryRefsLoopVar(v, vars));
  if (value && typeof value === 'object') return Object.values(value).some((v) => queryRefsLoopVar(v, vars));
  return false;
}

function uniqueBinding(ctx: EmitContext, base: string): string {
  const existing = ctx.frontmatterConsts.some((l) => l.startsWith(`const ${base} `));
  if (!existing) return base;
  return `${base}_${ctx.listCounter++}`;
}

function sanitizeIdent(s: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(s) ? s : s.replace(/[^A-Za-z0-9_$]/g, '_');
}

/**
 * Frontmatter binding name for a remote-data list, derived from its URL's last path segment
 * (`…/coins/markets?x=1` → `marketsList`). Falls back to `remoteList`. The name is emit-only
 * (re-derived every emit, deduped by `uniqueBinding`); the model carries the `url`.
 */
function deriveRemoteBinding(url: unknown): string {
  if (typeof url === 'string') {
    const m = url.replace(/[?#].*$/, '').match(/([A-Za-z0-9_$]+)\/*$/);
    if (m) return `${sanitizeIdent(m[1] ?? '')}List`;
  }
  return 'remoteList';
}

/** Astro component tag: components must be Capitalized identifiers. */
export function astroComponentName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_$]/g, '');
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** Tag identifiers a user component must never shadow: the dialect's own runtime tags
 *  (parseBody's RUNTIME_TAGS) — `<Link>` etc. would be misread as the runtime element. */
const RESERVED_IDENTS = new Set(['Link', 'Embed', 'LocaleList', 'BaseLayout', 'Fragment', 'MenoImage', 'Markdown']);

/**
 * The emitted tag identifier for a component name — `astroComponentName` made unique
 * within the file. Two names that sanitize identically (`container` / `Container`,
 * `GlobalPadding2` / `GlobalPadding 2`) or that would shadow a runtime tag get a
 * numbered suffix. Deterministic (assignment in body render order), and the import
 * path carries the true name, so the parser recovers it regardless of the identifier.
 */
export function componentIdentFor(ctx: EmitContext, name: string): string {
  const existing = ctx.componentIdents.get(name);
  if (existing) return existing;
  let base = astroComponentName(name) || 'Component';
  if (!/^[A-Za-z_$]/.test(base)) base = `C${base}`;
  // Islands + custom-`.astro` nodes share the file's tag namespace, so avoid their idents too.
  const taken = new Set([
    ...ctx.componentIdents.values(),
    ...ctx.islandIdents.values(),
    ...ctx.customAstroIdents.values(),
  ]);
  let ident = base;
  for (let n = 2; RESERVED_IDENTS.has(ident) || taken.has(ident); n++) ident = `${base}_${n}`;
  ctx.componentIdents.set(name, ident);
  return ident;
}

/** Basename of an island `src`, with directory + framework extension stripped. */
function islandBasename(src: string): string {
  const base = src.split('/').pop() ?? src;
  return base.replace(/\.(tsx|jsx|vue|svelte)$/i, '');
}

/**
 * The emitted tag identifier for an island `src` — its basename made a unique,
 * Capitalized JS identifier within the file. Uniquified against BOTH island and
 * component idents (one shared JSX-tag namespace per file) and the reserved runtime
 * tags. Deterministic in body render order; the import path carries the true `src`,
 * so the parser recovers it regardless of the identifier.
 */
export function islandIdentFor(ctx: EmitContext, src: string): string {
  const existing = ctx.islandIdents.get(src);
  if (existing) return existing;
  let base = astroComponentName(islandBasename(src)) || 'Island';
  if (!/^[A-Za-z_$]/.test(base)) base = `I${base}`;
  const taken = new Set([
    ...ctx.componentIdents.values(),
    ...ctx.islandIdents.values(),
    ...ctx.customAstroIdents.values(),
  ]);
  let ident = base;
  for (let n = 2; RESERVED_IDENTS.has(ident) || taken.has(ident); n++) ident = `${base}_${n}`;
  ctx.islandIdents.set(src, ident);
  return ident;
}

/** Basename of a custom-`.astro` `src`, with directory + `.astro` extension stripped. */
function customBasename(src: string): string {
  const base = src.split('/').pop() ?? src;
  return base.replace(/\.astro$/i, '');
}

/**
 * The emitted tag identifier for a custom-`.astro` `src` — its basename made a unique,
 * Capitalized JS identifier within the file. Uniquified against component AND island idents
 * (one shared JSX-tag namespace per file) and the reserved runtime tags. Deterministic in
 * body render order; the import path carries the true `src`, so the parser recovers it.
 */
export function customAstroIdentFor(ctx: EmitContext, src: string): string {
  const existing = ctx.customAstroIdents.get(src);
  if (existing) return existing;
  let base = astroComponentName(customBasename(src)) || 'Custom';
  if (!/^[A-Za-z_$]/.test(base)) base = `C${base}`;
  const taken = new Set([
    ...ctx.componentIdents.values(),
    ...ctx.islandIdents.values(),
    ...ctx.customAstroIdents.values(),
  ]);
  let ident = base;
  for (let n = 2; RESERVED_IDENTS.has(ident) || taken.has(ident); n++) ident = `${base}_${n}`;
  ctx.customAstroIdents.set(src, ident);
  return ident;
}

// ---------------------------------------------------------------------------
// Dispatch + placement
// ---------------------------------------------------------------------------

export function renderNode(node: Node, ctx: EmitContext): Rendered {
  // Verbatim-code marker → emit its JS expression inside `{ … }` (a marker never carries
  // structure or an `if`, so it bypasses the type switch and `applyIf`).
  if (isCodeMarker(node)) {
    return { kind: 'expr', expr: codeExpr(node.expr, ctx) };
  }
  let rendered: Rendered;
  switch (node.type) {
    case 'node':
      rendered = renderHtml(node, ctx);
      break;
    case 'component':
      rendered = renderComponentInstance(node, ctx);
      break;
    case 'slot':
      rendered = renderSlot(node, ctx);
      break;
    case 'link':
      rendered = renderLink(node, ctx);
      break;
    case 'embed':
      rendered = renderEmbed(node, ctx);
      break;
    case 'markdown':
      rendered = renderMarkdown(node, ctx);
      break;
    case 'locale-list':
      rendered = renderLocaleList(node, ctx);
      break;
    case 'list':
      rendered = renderList(node, ctx);
      break;
    case 'island':
      rendered = renderIslandInstance(node, ctx);
      break;
    case 'custom':
      rendered = renderCustomAstro(node, ctx);
      break;
    default:
      // Unknown node type → preserve as a comment so nothing is silently dropped.
      rendered = { kind: 'element', markup: `{/* meno:unknown ${JSON.stringify(node.type)} */}` };
  }
  return applyIf(node, rendered, ctx);
}

/** Wrap a rendered node in `cond && ( … )` when it has an `if` that is not literally `true`. */
function applyIf(node: Node, rendered: Rendered, ctx: EmitContext): Rendered {
  if (node.if === undefined || node.if === true) return rendered;
  // Parenthesize a condition whose top-level operator binds looser than `&&` (`||`, `??`,
  // ternary): `a || b && (…)` parses as `a || (b && …)`, dropping the element whenever `a`
  // is truthy. `(a || b) && (…)` keeps the intended meaning. (`when(…)` calls / atoms don't.)
  const raw = ifConditionExpr(node.if, ctx);
  const cond = condNeedsAndParens(raw) ? `(${raw})` : raw;
  if (rendered.kind === 'element') {
    return { kind: 'expr', expr: `${cond} && (\n${shift(rendered.markup, INDENT)}\n)` };
  }
  return { kind: 'expr', expr: `${cond} && (${rendered.expr})` };
}

/**
 * True when `expr`'s top-level operator binds LOOSER than `&&` — `||`, `??`, or a ternary
 * `?` — so emitting `expr && (…)` would mis-associate. Scans at bracket depth 0, skipping
 * string literals; `?.` (optional chaining) is not a ternary.
 */
function condNeedsAndParens(expr: string): boolean {
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === "'" || c === '`') {
      i++;
      while (i < expr.length && expr[i] !== c) {
        if (expr[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0) {
      if (c === '|' && expr[i + 1] === '|') return true;
      if (c === '?' && expr[i + 1] === '?') return true;
      if (c === '?' && expr[i + 1] !== '.') return true;
    }
  }
  return false;
}

function ifConditionExpr(cond: unknown, ctx: EmitContext): string {
  if (cond === false) return 'false';
  if (cond === true) return 'true';
  // Verbatim-code condition → its JS inline (`reverseCondition` reads it back; conditions
  // are single-line in practice, so they are not hoisted).
  if (isCodeMarker(cond)) return cond.expr;
  if (typeof cond === 'string') {
    if (hasTemplate(cond)) return templateToExpr(cond);
    // Plain literal string — runtime truthiness (ComponentBuilder.evaluateIfCondition):
    // '', 'false', '0' are falsy, anything else renders. JS truthiness differs for
    // 'false'/'0', so collapse meno-falsy strings to `false`; quote the rest (raw
    // emission would produce invalid JSX like `{ && (…)}`).
    if (cond === '' || cond === 'false' || cond === '0') return 'false';
    return JSON.stringify(cond);
  }
  // BooleanMapping `{ _mapping, prop, values }` → carry literal through `when()`, threading
  // the host props (like style()/href()) so it resolves; pages use the 1-arg form.
  needRuntime(ctx, 'when');
  const condLit = serializeLiteral(cond);
  return ctx.propsVar ? `when(${condLit}, ${ctx.propsVar})` : `when(${condLit})`;
}

/** Shift a rendered node to `indent`, wrapping `expr` nodes in `{ … }`. */
export function placeChild(rendered: Rendered, indent: number): string {
  if (rendered.kind === 'element') return shift(rendered.markup, indent);
  return shift(`{${rendered.expr}}`, indent);
}

/** Public entry: render a node (and any `if`) to placed markup at `indent`. */
export function emitNode(node: Node | string, ctx: EmitContext, indent: number): string {
  if (typeof node === 'string') return shift(emitTextChild(node, ctx), indent);
  return placeChild(renderNode(node, ctx), indent);
}
