/**
 * Markup parser — the inverse of the node walker. Parses meno-astro dialect template
 * markup back into the Meno node tree, reversing every emitter encoding (style()/i18n()
 * calls, {{}} templates, {cond && (…)} conditionals, list .map(), runtime components).
 */

import { singularize } from 'meno-core/shared';
import {
  scanBalanced,
  scanBalancedJsx,
  scanJsxElement,
  isJsxStart,
  findTrailingGroup,
  splitTopLevel,
  scanString,
  scanTemplate,
} from './scan';
import { parseLiteral } from './parseLiteral';
import { interpretExprValue, interpretClassExpr, reverseCondition } from './parseValue';
import { callArgsOf } from './callArgs';
import { hasStyleContent, normalizeNode } from '../normalize';
import { createEmitContext } from '../emit/emitContext';
import { renderNode } from '../emit/emitNode';
import type { ParseContext } from './parseContext';

type Node = Record<string, unknown>;
type Child = Node | string;

const WS = new Set([' ', '\t', '\r', '\n']);
const RUNTIME_TAGS = new Set(['Link', 'Embed', 'LocaleList', 'BaseLayout', 'MenoImage', 'Markdown']);
const LOCALE_STYLE_PROPS = new Set(['style', 'itemStyle', 'activeItemStyle', 'separatorStyle', 'flagStyle']);

function skipWs(src: string, i: number): number {
  while (i < src.length && WS.has(src[i] ?? '')) i++;
  return i;
}

interface Attr {
  name: string;
  raw: string;
  isExpr: boolean;
  shorthand?: boolean;
}

// ---------------------------------------------------------------------------
// Tag + attribute scanning
// ---------------------------------------------------------------------------

function readTagName(src: string, i: number): { name: string; end: number } {
  let j = i;
  while (j < src.length && /[A-Za-z0-9.\-_]/.test(src[j] ?? '')) j++;
  return { name: src.slice(i, j), end: j };
}

/** Like {@link readTagName} but allows `:` so Astro directives (`set:html`) read as one name. */
function readAttrName(src: string, i: number): { name: string; end: number } {
  let j = i;
  while (j < src.length && /[A-Za-z0-9.\-_:]/.test(src[j] ?? '')) j++;
  return { name: src.slice(i, j), end: j };
}

function parseAttributes(src: string, i: number): { attrs: Attr[]; end: number; selfClose: boolean } {
  const attrs: Attr[] = [];
  let j = i;
  for (;;) {
    j = skipWs(src, j);
    if (src[j] === '/' && src[j + 1] === '>') return { attrs, end: j + 2, selfClose: true };
    if (src[j] === '>') return { attrs, end: j + 1, selfClose: false };
    const { name, end } = readAttrName(src, j);
    if (!name) throw new Error(`parseAttributes: expected attribute name at ${j} ("${src.slice(j, j + 15)}")`);
    j = end;
    if (src[j] === '=') {
      j++;
      if (src[j] === '"' || src[j] === "'") {
        const q = src[j];
        let k = j + 1;
        while (k < src.length && src[k] !== q) {
          if (src[k] === '\\') k++;
          k++;
        }
        attrs.push({ name, raw: src.slice(j + 1, k), isExpr: false });
        j = k + 1;
      } else if (src[j] === '{') {
        const close = scanBalanced(src, j);
        attrs.push({ name, raw: src.slice(j + 1, close - 1), isExpr: true });
        j = close;
      } else {
        throw new Error(`parseAttributes: bad attribute value for "${name}" at ${j}`);
      }
    } else {
      attrs.push({ name, raw: '', isExpr: false, shorthand: true });
    }
  }
}

function attrValue(a: Attr, ctx: ParseContext): unknown {
  if (a.shorthand) return true;
  if (!a.isExpr) return a.raw;
  return interpretExprValue(a.raw, ctx);
}

// ---------------------------------------------------------------------------
// Element + children
// ---------------------------------------------------------------------------

/**
 * `base` is the absolute offset (in the original full source) of `src[0]`, so recorded
 * spans are absolute even though parsing happens on extracted substrings. It defaults
 * to 0 and is only consulted when `ctx.spans` is set (line-map mode); normal parsing
 * ignores it entirely.
 */
/** Skip from just after a `<template …>` open tag to just past its matching `</template>`,
 *  honoring nested `<template>` (a card may itself contain a filter-wired list). */
function skipToTemplateClose(src: string, from: number): number {
  let depth = 1;
  let j = from;
  while (j < src.length && depth > 0) {
    const open = src.indexOf('<template', j);
    const close = src.indexOf('</template>', j);
    if (close === -1) return src.length;
    if (open !== -1 && open < close) {
      depth++;
      j = open + '<template'.length;
    } else {
      depth--;
      j = close + '</template>'.length;
    }
  }
  return j;
}

export function parseElement(src: string, i: number, ctx: ParseContext, base = 0): { node: Child | null; end: number } {
  i = skipWs(src, i);
  if (src[i] !== '<') throw new Error(`parseElement: expected "<" at ${i}`);
  const { name: tag, end: afterTag } = readTagName(src, i + 1);
  const { attrs, end: afterAttrs, selfClose } = parseAttributes(src, afterTag);

  // Emit-derived item template (`<template data-meno-item>…</template>`, see
  // emitNode.buildItemTemplate) — its body is build-time JS, not model markup, and would not
  // parse as nodes. Skip the whole element (return null → parseNodes drops it). Re-derived from
  // the list node's `emitTemplate` flag on every emit, so the model round-trips.
  if (tag === 'template' && !selfClose && attrs.some((a) => a.name === 'data-meno-item')) {
    return { node: null, end: skipToTemplateClose(src, afterAttrs) };
  }

  let children: Child[] = [];
  let end = afterAttrs;
  if (!selfClose) {
    // Children share `src` (and therefore `base`) — only `{…}`/substring re-parsing shifts it.
    const inner = parseNodes(src, afterAttrs, ctx, tag, base);
    children = inner.nodes;
    const close = src.indexOf('>', inner.end);
    end = close + 1;
  }
  return { node: elementToNode(tag, attrs, children, ctx), end };
}

/** Record an object node's absolute span when the line-map sink is active. */
function recordSpan(ctx: ParseContext, node: Child, start: number, end: number): void {
  if (ctx.spans && node && typeof node === 'object') ctx.spans.set(node, { start, end });
}

export function parseNodes(
  src: string,
  i: number,
  ctx: ParseContext,
  stopTag?: string,
  base = 0,
): { nodes: Child[]; end: number } {
  const nodes: Child[] = [];
  let j = i;
  while (j < src.length) {
    const k = skipWs(src, j);
    if (k >= src.length) {
      j = k;
      break;
    }
    if (stopTag && src[k] === '<' && src[k + 1] === '/') return { nodes, end: k };
    if (src[k] === '<') {
      const { node, end } = parseElement(src, k, ctx, base);
      // `null` = an emit-derived artifact elementToNode drops (e.g. the inline CMS-data
      // script for a filter-wired list) — not part of the model, so don't push it.
      if (node !== null) {
        recordSpan(ctx, node, base + k, base + end);
        nodes.push(node);
      }
      j = end;
      continue;
    }
    if (src[k] === '{') {
      // JSX-aware: a body `{…}` child may wrap JSX whose TEXT contains `'`/`"`/backtick
      // (`{false && ( <p>We'll…</p> )}`). Plain scanBalanced would mis-read that apostrophe
      // as a JS string start; scanBalancedJsx treats JSX child text as opaque.
      const end = scanBalancedJsx(src, k);
      const child = interpretChildExpr(src.slice(k + 1, end - 1), ctx, base + k + 1);
      if (child !== undefined && child !== null && child !== '') {
        // Record the whole `{…}` span for the resulting node (list / if-wrapped element).
        recordSpan(ctx, child, base + k, base + end);
        nodes.push(child);
      }
      j = end;
      continue;
    }
    // text run until the next tag/expression
    let t = k;
    while (t < src.length && src[t] !== '<' && src[t] !== '{') t++;
    const text = src.slice(k, t).trim();
    if (text.length) nodes.push(text);
    j = t;
  }
  return { nodes, end: j };
}

// ---------------------------------------------------------------------------
// Expression children: if-wrappers, list .map(), text/value
// ---------------------------------------------------------------------------

/**
 * The un-parenthesized inline conditional `{cond && <element>}` (no wrapping parens) → the
 * dialect if-node. Returns the parsed element with its `if` set, or null when `e` is not that
 * form (so it falls through to interpretExprValue and is preserved verbatim).
 *
 * Match rule: the FIRST top-level `&&` (outside strings/templates/brackets) whose right side is
 * a single complete JSX element consuming the entire remainder. This keeps `{a && b}` a template
 * and `{a && <x> && <y>}` verbatim, while turning `{error && <p>…</p>}` (the shape a promoted
 * custom component or hand-authored conditional produces) into an editable if-node. The condition
 * may itself be arbitrary JS — reverseCondition preserves it (a `{_code}` if is valid).
 * The parenthesized form `{cond && ( … )}` is handled separately above (findTrailingGroup).
 */
function inlineCondElement(e: string, ctx: ParseContext, base: number): Child | null {
  let depth = 0;
  for (let i = 0; i < e.length; i++) {
    const c = e[i] ?? '';
    if (c === '"' || c === "'") {
      i = scanString(e, i) - 1;
      continue;
    }
    if (c === '`') {
      i = scanTemplate(e, i) - 1;
      continue;
    }
    // A JSX element in JS-expression position (a leading bare element, or an element to the
    // LEFT of the conditional `&&`) is opaque — skip it so its child-text quotes aren't read
    // as JS strings. The conditional's own right-hand element is matched by the `&&` branch
    // below (which slices from after `&&`), so this only fires for non-conditional shapes,
    // where returning null (→ verbatim) is preferable to a scanString throw.
    if (c === '<' && isJsxStart(e, i)) {
      i = scanJsxElement(e, i) - 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === '&' && e[i + 1] === '&') {
      const right = e.slice(i + 2).replace(/^\s+/, '');
      // Only treat as a conditional when an element immediately follows this `&&`. If this `&&`
      // is followed by a non-element (`{a && b}`), keep scanning for a later element-`&&`.
      if (/^<[A-Za-z]/.test(right)) {
        const { node, end } = parseElement(right, 0, ctx, base + (e.length - right.length));
        // Must be ONE complete element (nothing trailing) — else leave the whole expr verbatim.
        if (!node || typeof node !== 'object' || end < right.trimEnd().length) return null;
        (node as Node).if = reverseCondition(e.slice(0, i).trim());
        return node;
      }
      i++; // skip the second '&' and continue
    }
  }
  return null;
}

export function interpretChildExpr(inner: string, ctx: ParseContext, base = 0): Child | undefined {
  const e = inner.trim();
  if (!e) return undefined;
  const eBase = base + leadingWs(inner);

  const grp = findTrailingGroup(e, '(');
  if (grp) {
    const before = e.slice(0, grp.open).trim();
    if (before.endsWith('&&')) {
      const cond = before.slice(0, -2).trim();
      const bodyRaw = grp.inner;
      const body = bodyRaw.trim();
      const bodyBase = eBase + grp.open + 1 + leadingWs(bodyRaw);
      const node = body.startsWith('<')
        ? parseElement(body, 0, ctx, bodyBase).node
        : interpretChildExpr(body, ctx, bodyBase);
      if (node && typeof node === 'object') node.if = reverseCondition(cond);
      return node ?? undefined;
    }
    if (before.endsWith('.map')) {
      // Only a genuine Meno list is a list node: a prop list `list(src).map(…)`, a collection
      // list off a `getCollectionList` binding, or an inline-queried nested collection list
      // `queryList(binding, query).map(…)`. A bare `items.map(…)` is arbitrary JS — fall
      // through to interpretExprValue, which preserves it verbatim.
      const head = before.slice(0, -'.map'.length).trim();
      if (
        head.startsWith(`${ctx.listHelperLocal ?? 'list'}(`) ||
        head.startsWith('queryList(') ||
        ctx.collectionBindings.has(head) ||
        ctx.remoteBindings.has(head) ||
        ctx.sanityBindings.has(head)
      ) {
        return parseMapExpr(e, ctx, eBase);
      }
      // An arbitrary `<simple-data-expr>.map(…)` (e.g. `notes?.map(...)` over an Astro Action /
      // supabase result the dialect can't model as a prop/collection) → an EDITABLE
      // expression-list, but only when the modeled node round-trips (see expressionListRoundTrips).
      // Otherwise it falls through to interpretExprValue and is preserved verbatim as `{_code}`.
      if (isSimpleDataExpr(head) && mapBodyIsParenWrapped(e)) {
        const candidate = parseMapExpr(e, ctx, eBase);
        if (ctx._expressionListReparse) return candidate;
        if (expressionListRoundTrips(candidate, ctx)) return candidate;
      }
    }
  }

  // Un-parenthesized inline conditional `{cond && <element>}` → an editable if-node.
  const cond = inlineCondElement(e, ctx, eBase);
  if (cond !== null) return cond;

  const val = interpretExprValue(e, ctx);
  return val as Child;
}

/** Count of leading whitespace characters (how far `s.trim()` shifts `s`'s start). */
function leadingWs(s: string): number {
  return s.length - s.trimStart().length;
}

/**
 * A `.map` body emitted as `<Fragment>…</Fragment>` (the emit wrapper for an item template
 * that isn't a single bare element — an `if`-wrapped node, a nested list, a text
 * interpolation, or multiple roots; a bare `{…}` there would be invalid JS in the arrow's
 * expression position) → its children ARE the list's item children. Unwrap so the list node
 * round-trips. A plain `<Fragment>` (no `set:html`) only ever appears here as that wrapper.
 */
function unwrapMapFragment(children: Child[]): Child[] {
  if (children.length !== 1) return children;
  const only = children[0];
  if (
    only &&
    typeof only === 'object' &&
    (only as Node).type === 'component' &&
    (only as Node).component === 'Fragment'
  ) {
    const inner = (only as Node).children;
    return Array.isArray(inner) ? inner : inner == null ? [] : [inner as Child];
  }
  return children;
}

function parseMapExpr(e: string, ctx: ParseContext, base = 0): Node {
  const mapIdx = e.indexOf('.map(');
  const head = e.slice(0, mapIdx).trim();
  const argOpen = mapIdx + 4; // '(' of '.map('
  // JSX-aware: the `.map( … )` arg holds the item-template arrow `(x) => ( <jsx> )`, whose JSX
  // child text may contain `'`/`"`/backtick (`<li>don't…</li>`). scanBalancedJsx keeps those
  // literal; plain scanBalanced would throw on the apostrophe.
  const argEnd = scanBalancedJsx(e, argOpen);
  const argRaw = e.slice(argOpen + 1, argEnd - 1); // interior of `.map( … )`
  const arg = argRaw.trim(); // (item, index) => ( children )
  const argBase = base + argOpen + 1 + leadingWs(argRaw);

  const paramsEnd = scanBalanced(arg, 0);
  const params = splitTopLevel(arg.slice(1, paramsEnd - 1), ',').filter(Boolean);
  const itemVar = params[0];
  const afterParams = arg.slice(paramsEnd);
  const bodyGrp = findTrailingGroup(afterParams.trim(), '(');
  let children: Child[] = [];
  if (bodyGrp) {
    const childrenBase = argBase + paramsEnd + leadingWs(afterParams) + bodyGrp.open + 1;
    children = parseNodes(bodyGrp.inner, 0, ctx, undefined, childrenBase).nodes;
  }
  children = unwrapMapFragment(children);

  if (head.startsWith(`${ctx.listHelperLocal ?? 'list'}(`)) {
    const inner = callArgsOf(head);
    const parts = splitTopLevel(inner, ',').filter(Boolean);
    const opts = parts[1] ? (parseLiteral(parts[1]) as Record<string, unknown>) : {};
    const node: Node = {
      type: 'list',
      sourceType: 'prop',
      source: `{{${parts[0]}}}`,
      ...opts,
      children,
    };
    if (itemVar && itemVar !== 'item') node.itemAs = itemVar;
    return node;
  }

  if (head.startsWith('queryList(')) {
    // Inline-queried nested collection list: `queryList(<binding>, <query>[, Astro]).map(…)`.
    // The binding was fetched whole in frontmatter; the real query is the 2nd arg here
    // (its `{{loopVar…}}` bindings come back from parseLiteral's expression reversal).
    const parts = splitTopLevel(callArgsOf(head), ',').map((s) => s.trim());
    const firstArg = parts[0] ?? '';
    const binding = ctx.collectionBindings.get(firstArg);
    const source = binding?.source ?? firstArg;
    const query = parts[1] ? (parseLiteral(parts[1]) as Record<string, unknown>) : {};
    const node: Node = {
      type: 'list',
      sourceType: 'collection',
      source,
      ...query,
      children,
    };
    if (itemVar && itemVar !== singularize(source)) node.itemAs = itemVar;
    return node;
  }

  const remote = ctx.remoteBindings.get(head);
  if (remote) {
    // Remote-data list: the binding carries the URL + query (path/filter/sort/limit/offset).
    const node: Node = {
      type: 'list',
      sourceType: 'remote',
      url: remote.url,
      ...(remote.query ?? {}),
      children,
    };
    if (itemVar && itemVar !== 'item') node.itemAs = itemVar;
    return node;
  }

  const sanity = ctx.sanityBindings.get(head);
  if (sanity) {
    // Sanity GROQ list: the binding carries the document type + query (filter/sort/limit/offset).
    const node: Node = {
      type: 'list',
      sourceType: 'sanity',
      documentType: sanity.documentType,
      ...(sanity.query ?? {}),
      children,
    };
    if (itemVar && itemVar !== 'item') node.itemAs = itemVar;
    return node;
  }

  // An arbitrary simple data expression (NOT a known list/collection/remote/sanity binding) →
  // an expression-list: iterate the verbatim `source` via native `.map`. The item template
  // (`children`) is editable; the source is a black box. Only reached for hand-authored
  // `<expr>.map(…)` — Meno never emits a bare `.map` (prop lists wear a `list(…)` wrapper).
  // The caller gates this against a round-trip check before accepting it (interpretChildExpr).
  if (isSimpleDataExpr(head) && !ctx.collectionBindings.has(head)) {
    const node: Node = { type: 'list', sourceType: 'expression', source: head, children };
    if (itemVar && itemVar !== 'item') node.itemAs = itemVar;
    return node;
  }

  const binding = ctx.collectionBindings.get(head);
  const source = binding?.source ?? head;
  const node: Node = {
    type: 'list',
    sourceType: 'collection',
    source,
    ...(binding?.query ?? {}),
    children,
  };
  if (itemVar && itemVar !== singularize(source)) node.itemAs = itemVar;
  return node;
}

/**
 * A "simple data expression" eligible to be an expression-list source: an identifier or member
 * chain (with optional chaining), e.g. `notes`, `notes?`, `data.notes`, `user?.notes`. NO calls
 * (`foo()`), brackets, or operators — those aren't a re-emittable bare source and stay verbatim.
 */
function isSimpleDataExpr(head: string): boolean {
  // Strip a single trailing optional-chaining `?` (from `notes?.map`).
  const base = head.endsWith('?') ? head.slice(0, -1) : head;
  return /^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*$/.test(base);
}

/**
 * True when `<head>.map(…)`'s arrow body is a single fully-enclosing `( … )` group —
 * `(item) => ( <jsx> )`, the only shape parseMapExpr parses without loss. An unparenthesized
 * element body (`x => <li/>`), a block body (`x => { return … }`), or a ternary/expression body
 * (`x => cond ? (<a/>) : (<b/>)`) would parse to EMPTY children (silent drop), so those are NOT
 * promoted — they stay verbatim `{_code}`. (The round-trip gate can't catch this on its own: a
 * dropped body is absent from both the candidate and its re-parse, so they compare "stable".)
 */
function mapBodyIsParenWrapped(e: string): boolean {
  const mapIdx = e.indexOf('.map(');
  if (mapIdx < 0) return false;
  const argOpen = mapIdx + 4;
  try {
    // JSX-aware on the spans that can hold JSX (the whole `.map( … )` arg and its `( <jsx> )`
    // body) so an apostrophe in the item text doesn't throw; the inner `(params)` group has no
    // JSX, so a plain scan there is fine.
    const argEnd = scanBalancedJsx(e, argOpen);
    const arg = e.slice(argOpen + 1, argEnd - 1).trim(); // (params) => BODY
    if (arg[0] !== '(') return false; // params must be parenthesized (x) / (x, i)
    const paramsEnd = scanBalanced(arg, 0);
    const after = arg.slice(paramsEnd).trim(); // => BODY
    if (!after.startsWith('=>')) return false;
    const body = after.slice(2).trim();
    if (body[0] !== '(') return false; // body must open with `(`
    return scanBalancedJsx(body, 0) === body.length; // …and that group must span the whole body
  } catch {
    return false;
  }
}

/** Order-insensitive structural deep-equality (object key order may differ between parse paths). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
}

/**
 * The round-trip gate for an expression-list candidate: re-emit the node and re-parse it; accept
 * the conversion only when the modeled node is STABLE (emit → parse reproduces it). A body the
 * dialect can't model losslessly fails this and stays a verbatim `{_code}` marker, so converting a
 * hand-authored `.map` to an editable list never silently drops or corrupts content. (Conversion
 * DOES canonicalize the emitted source on the next save — the model is what's pinned, not the
 * original text.) Errs toward `false` (keep verbatim) on any throw.
 */
function expressionListRoundTrips(node: Child, ctx: ParseContext): boolean {
  if (!node || typeof node !== 'object') return false;
  try {
    const gctx = createEmitContext();
    gctx.propsVar = '__props';
    const r = renderNode(node as Node, gctx);
    const exprStr = r.kind === 'expr' ? r.expr : r.markup;
    // Re-parse with the SAME imports/bindings (so components/bindings resolve identically), but
    // without the span sink and with the recursion guard so the gate doesn't re-enter itself.
    const reparseCtx: ParseContext = { ...ctx, spans: undefined, _expressionListReparse: true };
    const back = interpretChildExpr(exprStr, reparseCtx, 0);
    if (!back || typeof back !== 'object') return false;
    return deepEqual(normalizeNode(node), normalizeNode(back));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Element → node
// ---------------------------------------------------------------------------

/**
 * The dialect's own class encoding — `class={style(…)}` or the prop-variant forms
 * `class={variants(…)}` / `class={cx(style(…), variants(…))}` — vs a foreign (hand-authored) class.
 */
function isStyleCallAttr(a: Attr): boolean {
  if (!a.isExpr) return false;
  const r = a.raw.trimStart();
  return r.startsWith('style(') || r.startsWith('cx(') || r.startsWith('variants(');
}

/**
 * The dialect's own DERIVED inline `style=` attribute, vs a foreign (hand-authored) one.
 *
 * Emit re-derives a node's templated `node.style` into an inline `style=` attribute in two
 * forms (emitInlineStyleAttr): `style={inlineStyle(…, __props)}` on a component root, and
 * `style={`…`}` (a backtick template, the `--m-<bp>-<prop>` var bridge) elsewhere — but ONLY
 * alongside the `class={style(…)}` that carries the same node.style. On parse that style is
 * reconstructed from `class={style(…)}` (applyClass), so the derived `style=` is redundant and
 * must be dropped to keep `parse(emit(x)) === x`. A FOREIGN inline style (a literal
 * `style="…"`, or an arbitrary `style={expr}` like `note.done ? '…' : undefined`) has no such
 * reconstruction — it is preserved as a plain `attributes.style` so it round-trips.
 */
function isDerivedStyleAttr(a: Attr, attrs: Attr[]): boolean {
  if (!a.isExpr) return false; // a literal style="…" is always foreign
  const raw = a.raw.trimStart();
  if (raw.startsWith('inlineStyle(')) return true;
  // A `style={`…`}` backtick is the var-bridge form — derived only when emitted with the
  // reconstructable `class={style(…)}`; a lone backtick style is hand-authored, keep it.
  if (raw.startsWith('`')) return attrs.some((x) => x.name === 'class' && isStyleCallAttr(x));
  return false;
}

/**
 * Trailing static-class concat on a `class={style(…) + " swiper is-logos"}` attribute
 * (emit's mergeStaticClass single-attribute form) → the static class string, or undefined.
 */
function staticClassSuffix(raw: string): string | undefined {
  const open = raw.indexOf('(');
  const end = scanBalanced(raw, open);
  const rest = raw.slice(end).trim();
  const m = rest.match(/^\+\s*"((?:[^"\\]|\\.)*)"$/);
  if (!m) return undefined;
  const v = (JSON.parse(`"${m[1]}"`) as string).trim();
  return v || undefined;
}

/**
 * Applies the style() class attr to the node and returns the foreign static class merged
 * into it (the `+ "…"` suffix), if any — the caller lands it in attributes/props `class`.
 */
function applyClass(node: Node, attrs: Attr[]): string | undefined {
  const cls = attrs.find((a) => a.name === 'class' && isStyleCallAttr(a));
  if (!cls) return undefined;
  const parsed = interpretClassExpr(cls.raw);
  // A content-free style — the legacy style-less component root (`style({}, __props, { root: true })`)
  // or the current `cx(className)` form, both emitted only to land the instance class — parses back
  // to NO `style` key, keeping parse output canonical (normalizeModel deletes empty styles).
  if (parsed.style !== undefined && hasStyleContent(parsed.style)) node.style = parsed.style;
  if (parsed.interactiveStyles !== undefined) node.interactiveStyles = parsed.interactiveStyles;
  if (parsed.label !== undefined) node.label = parsed.label;
  if (parsed.generateElementClass !== undefined) node.generateElementClass = parsed.generateElementClass;
  // Foreign static class: the structure-root `cx("…", className)` folds it in as a bare string arg
  // (parsed.staticClass); the legacy `style(…) + " …"` form carries it as a trailing concat.
  return parsed.staticClass ?? staticClassSuffix(cls.raw);
}

/** Land a foreign class from applyClass into an attributes/props record's `class`. */
function landStaticClass(rec: Record<string, unknown>, extra: string | undefined): void {
  if (!extra) return;
  rec.class = typeof rec.class === 'string' && rec.class ? `${rec.class} ${extra}` : extra;
}

function otherAttrs(attrs: Attr[], ctx: ParseContext, skip: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of attrs) {
    // A foreign class — static `class="swiper …"` or a non-style() expression, possibly
    // alongside the dialect's own `class={style(…)}` on the same element — has no style()
    // to reverse. Preserve it as a plain attribute: meno-core merges `attributes.class`
    // into the element's class (ComponentBuilder.mergeAttributes) and emit re-emits it
    // after the style() class, so it round-trips. applyClass consumes only style() calls.
    if (a.name === 'class' && !isStyleCallAttr(a)) {
      out[a.name] = attrValue(a, ctx);
      continue;
    }
    // A foreign inline `style=` (hand-authored, not the dialect's derived re-emission of
    // node.style) is real content with no style() to reverse — preserve it as a plain
    // attribute. The derived form is reconstructed from `class={style(…)}`, so it's dropped.
    // Handled before the generic skip check because `style` is always in the caller's skip set.
    if (a.name === 'style') {
      if (!isDerivedStyleAttr(a, attrs)) out[a.name] = attrValue(a, ctx);
      continue;
    }
    if (skip.has(a.name)) continue;
    // Drop the ambient CMS forward `cms={cms}` — emit-only plumbing that
    // renderComponentInstance threads for Astro's component isolation (the CMS item flows
    // down implicitly in meno-core). `cms` is a reserved ambient name, never an authored
    // prop, so this never strips real data; it keeps `parse(emit(x)) === x`.
    if (a.name === 'cms' && a.isExpr && a.raw.trim() === 'cms') continue;
    // Drop the instance style forward `__menoStyle={…}` — emit-only plumbing
    // (renderComponentInstance) so the child's root `inlineStyle()` can read which props the
    // instance overrides. The instance `node.style` is reconstructed from the instance
    // `class={style(…, { instance: true })}` call (applyClass), so dropping this re-derived
    // duplicate keeps `parse(emit(x)) === x`. Reserved name, never an authored prop.
    if (a.name === '__menoStyle') continue;
    out[a.name] = attrValue(a, ctx);
  }
  return out;
}

function elementToNode(tag: string, attrs: Attr[], children: Child[], ctx: ParseContext): Child | null {
  // Emit-derived inline CMS-data script for a filter-wired collection list
  // (`<script type="application/json" id="meno-cms-<collection>" … set:html={serializeClientCmsData(…)}>`)
  // — NOT part of the model. It is re-derived from the list node's `emitTemplate` flag on
  // every emit (see emitNode.buildClientDataScripts), so drop it here to keep the round-trip
  // stable. Keyed on the reserved id prefix (a hand-authored JSON script would never use it).
  if (tag === 'script') {
    const id = attrs.find((a) => a.name === 'id');
    if (id && !id.isExpr && id.raw.startsWith('meno-cms-')) return null;
  }
  // (The emit-derived `<template data-meno-item>` is dropped earlier, in parseElement, so its
  // build-time-JS body is never parsed as markup.)

  // `<Fragment set:html={…} />` is the emit form for a rich-text text child (a bare
  // `type:"rich-text"` prop ref, or direct rich-text markup). Reverse it back to the text
  // child: a bare identifier → `{{ident}}`; a backtick HTML literal → the HTML string (with
  // `data-meno-span` re-added by interpretExprValue). See emitTextChild + `../richtext`.
  if (tag === 'Fragment') {
    const setHtml = attrs.find((a) => a.name === 'set:html');
    if (setHtml) return attrValue(setHtml, ctx) as Child;
  }

  // Dynamic tag: `<Tag_0 …>` → an HTML node whose tag is the original `h{{size}}`.
  if (ctx.tagConsts.has(tag)) {
    const node: Node = { type: 'node', tag: ctx.tagConsts.get(tag)! };
    const extraClass = applyClass(node, attrs);
    const attributes = otherAttrs(attrs, ctx, new Set(['class', 'style']));
    landStaticClass(attributes, extraClass);
    if (Object.keys(attributes).length) node.attributes = attributes;
    if (children.length) node.children = children;
    return node;
  }

  if (tag === 'slot') {
    const node: Node = { type: 'slot' };
    // Named slot: `<slot name="header">`. A static string attr (a.raw); the default slot has none.
    const nameAttr = attrs.find((a) => a.name === 'name');
    if (nameAttr && !nameAttr.isExpr && nameAttr.raw) node.name = nameAttr.raw;
    if (children.length) node.default = children;
    return node;
  }

  if (tag === 'Link') {
    const node: Node = { type: 'link' };
    const href = attrs.find((a) => a.name === 'href');
    if (href) node.href = attrValue(href, ctx);
    const extraClass = applyClass(node, attrs);
    const rest = otherAttrs(attrs, ctx, new Set(['href', 'class', 'style']));
    landStaticClass(rest, extraClass);
    // Flatten a legacy `LinkPropValue` object href (`{ href, target? }`) — the shape an old
    // website import wrote at the node-`href` position — into the canonical link-node form
    // (`href` is a string | prop-`_mapping`; `target` is a node attribute). Left as an object
    // it fails the editor's Link schema ("invalid data") and `href()` drops `target` at build.
    const lh = node.href as Record<string, unknown> | undefined;
    if (lh && typeof lh === 'object' && !lh._mapping && !lh._i18n && typeof lh.href === 'string') {
      if (typeof lh.target === 'string' && lh.target && rest.target === undefined) rest.target = lh.target;
      node.href = lh.href;
    }
    if (Object.keys(rest).length) node.attributes = rest;
    if (children.length) node.children = children;
    return node;
  }

  if (tag === 'Embed') {
    const node: Node = { type: 'embed' };
    const html = attrs.find((a) => a.name === 'html');
    if (html) {
      // A bare `html={ident}` referencing a hoisted frontmatter backtick const is verbatim
      // HTML — resolve it to the const's value even when the const was hand-authored under a
      // name OTHER than `__embedN`. Without this the identifier is misread as a `{{ident}}`
      // binding to a phantom prop, the const is dropped, and the payload (e.g. a multi-line
      // SVG) is silently lost on the next emit. The emitter re-hoists it as `__embedN`, so the
      // const NAME normalizes on save while the HTML round-trips intact.
      const ident = html.isExpr ? html.raw.trim() : undefined;
      node.html =
        ident !== undefined && ctx.templateConsts.has(ident) ? ctx.templateConsts.get(ident) : attrValue(html, ctx);
    }
    const extraClass = applyClass(node, attrs);
    // `components` is emit-only plumbing (the registry passed when the html binds a CMS rich-text
    // field; renderEmbed) — exclude it so it never lands in the model; re-derived on emit.
    const rest = otherAttrs(attrs, ctx, new Set(['html', 'class', 'style', 'components']));
    landStaticClass(rest, extraClass);
    if (Object.keys(rest).length) node.attributes = rest;
    return node;
  }

  if (tag === 'Markdown') {
    // Inverse of renderMarkdown: a `<Markdown source={__mdN} />` (or inline backtick literal).
    // The source is verbatim Markdown — resolve a hoisted backtick const via templateConsts
    // (same as the Embed `html={ident}` path), else read the inline literal.
    const node: Node = { type: 'markdown', source: '' };
    const source = attrs.find((a) => a.name === 'source');
    if (source) {
      const ident = source.isExpr ? source.raw.trim() : undefined;
      node.source =
        ident !== undefined && ctx.templateConsts.has(ident) ? ctx.templateConsts.get(ident) : attrValue(source, ctx);
    }
    const extraClass = applyClass(node, attrs);
    const rest = otherAttrs(attrs, ctx, new Set(['source', 'class', 'style']));
    landStaticClass(rest, extraClass);
    if (Object.keys(rest).length) node.attributes = rest;
    return node;
  }

  if (tag === 'MenoImage') {
    // Inverse of renderMenoImage: an optimized `<img>`. Rebuild the img node and re-add the
    // `data-meno-optimize` marker the emitter consumed (the discriminator round-trips this way).
    const node: Node = { type: 'node', tag: 'img' };
    const extraClass = applyClass(node, attrs);
    const attributes = otherAttrs(attrs, ctx, new Set(['class', 'style']));
    landStaticClass(attributes, extraClass);
    attributes['data-meno-optimize'] = 'true';
    node.attributes = attributes;
    return node;
  }

  if (tag === 'LocaleList') {
    const node: Node = { type: 'locale-list' };
    for (const a of attrs) {
      if (LOCALE_STYLE_PROPS.has(a.name) && a.isExpr && a.raw.trimStart().startsWith('style(')) {
        node[a.name] = parseLiteral(callArgsOf(a.raw));
      } else if (a.name === 'meta' && a.isExpr) {
        const meta = parseLiteral(a.raw) as Record<string, unknown>;
        if (meta.interactive !== undefined) node.interactiveStyles = meta.interactive;
        if (meta.label !== undefined) node.label = meta.label;
        if (meta.genClass !== undefined) node.generateElementClass = meta.genClass;
      } else {
        node[a.name] = attrValue(a, ctx);
      }
    }
    return node;
  }

  // Island instance: a tag whose import resolves to a BYO framework component under
  // `src/islands/` (a `.tsx/.jsx/.vue/.svelte` file). `client:*` directives become
  // `node.client` (Astro allows a single one); every other attribute is a prop. The import
  // path carried the `src` (relative to `src/islands/`); the framework is its extension.
  const islandSrc = ctx.islandImports.get(tag);
  if (islandSrc !== undefined) {
    const node: Node = { type: 'island', src: islandSrc };
    const props: Record<string, unknown> = {};
    for (const a of attrs) {
      if (a.name.startsWith('client:')) {
        if (node.client) continue;
        const directive = a.name.slice('client:'.length);
        node.client = a.shorthand ? { directive } : { directive, value: String(attrValue(a, ctx)) };
      } else {
        props[a.name] = attrValue(a, ctx);
      }
    }
    if (Object.keys(props).length) node.props = props;
    if (children.length) node.children = children;
    return node;
  }

  // Custom-`.astro` instance: a tag whose import resolves to an opaque hand-authored `.astro`
  // component under `src/custom/`. Meno doesn't model its internals — every attribute is a
  // verbatim prop and its children are slotted (default slot). No `client:*` (server-only).
  const customSrc = ctx.customAstroImports.get(tag);
  if (customSrc !== undefined) {
    const node: Node = { type: 'custom', src: customSrc };
    const props: Record<string, unknown> = {};
    for (const a of attrs) props[a.name] = attrValue(a, ctx);
    if (Object.keys(props).length) node.props = props;
    if (children.length) node.children = children;
    return node;
  }

  // Component instance (Capitalized, or a known imported component). The tag is the
  // emitter's sanitized identifier — the component's true name is the imported file's
  // basename (`<Container>` ← container.astro → component "container"); an unimported
  // tag (fixtures/hand-authored without frontmatter) falls back to the tag itself.
  const isComponent = /^[A-Z]/.test(tag) && !RUNTIME_TAGS.has(tag);
  if (isComponent) {
    const node: Node = { type: 'component', component: ctx.componentImports.get(tag) ?? tag };
    const extraClass = applyClass(node, attrs);
    const props = otherAttrs(attrs, ctx, new Set(['class', 'style']));
    landStaticClass(props, extraClass);
    if (Object.keys(props).length) node.props = props;
    if (children.length) node.children = children;
    return node;
  }

  // HTML element.
  const node: Node = { type: 'node', tag };
  const extraClass = applyClass(node, attrs);
  const attributes = otherAttrs(attrs, ctx, new Set(['class', 'style']));
  landStaticClass(attributes, extraClass);
  if (Object.keys(attributes).length) node.attributes = attributes;
  if (children.length) node.children = children;
  return node;
}
