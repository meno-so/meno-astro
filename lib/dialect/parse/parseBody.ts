/**
 * Markup parser — the inverse of the node walker. Parses meno-astro dialect template
 * markup back into the Meno node tree, reversing every emitter encoding (style()/i18n()
 * calls, {{}} templates, {cond && (…)} conditionals, list .map(), runtime components).
 */

import { singularize } from 'meno-core/shared';
import { scanBalanced, findTrailingGroup, splitTopLevel } from './scan';
import { parseLiteral } from './parseLiteral';
import { interpretExprValue, interpretStyleCall, reverseCondition } from './parseValue';
import { callArgsOf } from './callArgs';
import { hasStyleContent } from '../normalize';
import type { ParseContext } from './parseContext';

type Node = Record<string, any>;
type Child = Node | string;

const WS = new Set([' ', '\t', '\r', '\n']);
const RUNTIME_TAGS = new Set(['Link', 'Embed', 'LocaleList', 'BaseLayout']);
const LOCALE_STYLE_PROPS = new Set(['style', 'itemStyle', 'activeItemStyle', 'separatorStyle', 'flagStyle']);

function skipWs(src: string, i: number): number {
  while (i < src.length && WS.has(src[i])) i++;
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
  while (j < src.length && /[A-Za-z0-9.\-_]/.test(src[j])) j++;
  return { name: src.slice(i, j), end: j };
}

/** Like {@link readTagName} but allows `:` so Astro directives (`set:html`) read as one name. */
function readAttrName(src: string, i: number): { name: string; end: number } {
  let j = i;
  while (j < src.length && /[A-Za-z0-9.\-_:]/.test(src[j])) j++;
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
      const end = scanBalanced(src, k);
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
      if (head.startsWith('list(') || head.startsWith('queryList(') || ctx.collectionBindings.has(head)) {
        return parseMapExpr(e, ctx, eBase);
      }
    }
  }

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
  const argEnd = scanBalanced(e, argOpen);
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

  if (head.startsWith('list(')) {
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
    const binding = ctx.collectionBindings.get(parts[0]);
    const source = binding?.source ?? parts[0];
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

// ---------------------------------------------------------------------------
// Element → node
// ---------------------------------------------------------------------------

/** The dialect's own `class={style(…)}` encoding, vs a foreign (hand-authored) class. */
function isStyleCallAttr(a: Attr): boolean {
  return a.isExpr && a.raw.trimStart().startsWith('style(');
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
  const parsed = interpretStyleCall(cls.raw);
  // A content-free style (`style({}, __props, { root: true })` — a style-less component
  // root emitted only to land the instance class) parses back to NO `style` key, keeping
  // parse output canonical (normalizeModel deletes empty styles).
  if (parsed.style !== undefined && hasStyleContent(parsed.style)) node.style = parsed.style;
  if (parsed.interactiveStyles !== undefined) node.interactiveStyles = parsed.interactiveStyles;
  if (parsed.label !== undefined) node.label = parsed.label;
  if (parsed.generateElementClass !== undefined) node.generateElementClass = parsed.generateElementClass;
  return staticClassSuffix(cls.raw);
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
    if (Object.keys(rest).length) node.attributes = rest;
    if (children.length) node.children = children;
    return node;
  }

  if (tag === 'Embed') {
    const node: Node = { type: 'embed' };
    const html = attrs.find((a) => a.name === 'html');
    if (html) node.html = attrValue(html, ctx);
    const extraClass = applyClass(node, attrs);
    const rest = otherAttrs(attrs, ctx, new Set(['html', 'class', 'style']));
    landStaticClass(rest, extraClass);
    if (Object.keys(rest).length) node.attributes = rest;
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
