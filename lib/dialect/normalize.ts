/**
 * Canonicalization for the round-trip contract. The emitter drops content-free
 * defaults (empty styles, empty `children`, empty `meta`) and a single text child is
 * indistinguishable from a one-element array on parse. `normalizeModel` puts a model
 * into the canonical form the parser produces, so the contract is:
 *
 *   parse(emit(x)) === normalizeModel(x)            (exact up to normalization)
 *   parse(emit(normalizeModel(x))) === normalizeModel(x)   (exact on canonical input)
 *
 * The codec applies this on load, so the editor always works with canonical models.
 */

import { singularize } from 'meno-core/shared';
import { isStyleMapping } from 'meno-core/shared';
import { sanitizeCssValue } from '../runtime/cssValue';
import { isBindableIdent } from './ident';
import { scanTemplate, scanString } from './parse/scan';
import { inlineStyleToStyleDecls } from './inlineStyle';

export function hasStyleContent(style: unknown): boolean {
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

// ---------------------------------------------------------------------------
// Style-value sanitization (see runtime/cssValue.ts for the why): canonical models
// never carry a declaration value that would corrupt the generated stylesheet.
// Junk after a real value is truncated browser-style; a value with nothing valid
// left is dropped. Authored values (incl. `''` and `{{templates}}` without junk)
// pass through unchanged, and untouched objects keep their identity.
// ---------------------------------------------------------------------------

/** Sanitize one declaration value; `undefined` means "drop the declaration". */
function sanitizeDeclValue(v: unknown): unknown {
  if (typeof v !== 'string' || v === '') return v;
  const clean = sanitizeCssValue(v);
  return clean === '' ? undefined : clean;
}

/** Sanitize a flat `{ prop: value }` style object (values may be `_mapping`s). */
function sanitizeFlatStyle(flat: Record<string, unknown>): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [prop, v] of Object.entries(flat)) {
    if (isStyleMapping(v)) {
      const m = v as unknown as { values?: Record<string, unknown> };
      const values = m.values ?? {};
      let mChanged = false;
      const nv: Record<string, unknown> = {};
      for (const [k, mv] of Object.entries(values)) {
        const c = sanitizeDeclValue(mv);
        if (c !== mv) mChanged = true;
        if (c !== undefined) nv[k] = c;
      }
      if (mChanged) {
        out[prop] = { ...(v as object), values: nv };
        changed = true;
      } else {
        out[prop] = v;
      }
      continue;
    }
    const c = sanitizeDeclValue(v);
    if (c !== v) changed = true;
    if (c !== undefined) out[prop] = c;
  }
  return changed ? out : flat;
}

/** Sanitize a StyleValue — flat or responsive `{ base/tablet/mobile }`. */
function sanitizeStyleValue(style: unknown): unknown {
  if (!style || typeof style !== 'object') return style;
  const s = style as Record<string, unknown>;
  if ('base' in s || 'tablet' in s || 'mobile' in s) {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [bp, bpStyle] of Object.entries(s)) {
      if (bpStyle && typeof bpStyle === 'object') {
        const c = sanitizeFlatStyle(bpStyle as Record<string, unknown>);
        if (c !== bpStyle) changed = true;
        out[bp] = c;
      } else {
        out[bp] = bpStyle;
      }
    }
    return changed ? out : style;
  }
  return sanitizeFlatStyle(s);
}

/** Sanitize every rule's style in an `interactiveStyles` array. */
function sanitizeInteractive(rules: unknown[]): unknown[] {
  let changed = false;
  const out = rules.map((r) => {
    if (!r || typeof r !== 'object') return r;
    const rule = r as Record<string, unknown>;
    const c = sanitizeStyleValue(rule.style);
    if (c === rule.style) return r;
    changed = true;
    return { ...rule, style: c };
  });
  return changed ? out : rules;
}

/** Canonicalize a children/default list: normalize items, drop if empty, collapse a lone string. */
function normalizeChildren(children: unknown): unknown {
  if (typeof children === 'string') return children;
  if (!Array.isArray(children)) return undefined;
  const items = children.map(normalizeChild);
  if (items.length === 0) return undefined;
  if (items.length === 1 && typeof items[0] === 'string') return items[0];
  return items;
}

function normalizeChild(child: unknown): unknown {
  return typeof child === 'string' ? child : normalizeNode(child);
}

/** Migrate legacy node types (cms-list, image) to the unified model. */
function migrateLegacy(n: Record<string, unknown>): Record<string, unknown> {
  if (n.type === 'cms-list') {
    const { type, collection, style, attributes, children, ...rest } = n;
    const list: Record<string, unknown> = {
      type: 'list',
      sourceType: 'collection',
      source: collection,
      ...rest,
    };
    // Legacy cms-list children reference `{{item.*}}`, so bind the loop to `item`
    // (otherwise the migrated collection list would default to singularize(source)
    // and the generated loop var wouldn't match the children's templates).
    if (list.itemAs === undefined) list.itemAs = 'item';
    if (children !== undefined) list.children = children;
    // A cms-list bundled a styled container + repeater → split into div > list.
    if (style !== undefined || attributes !== undefined) {
      const wrapper: Record<string, unknown> = { type: 'node', tag: 'div' };
      if (style !== undefined) wrapper.style = style;
      if (attributes !== undefined) wrapper.attributes = attributes;
      wrapper.children = [list];
      return wrapper;
    }
    return list;
  }
  if (n.type === 'image') {
    const { type, src, alt, style, attributes, ...rest } = n;
    const attrs: Record<string, unknown> = { ...(attributes as object) };
    if (src !== undefined) attrs.src = src;
    if (alt !== undefined) attrs.alt = alt;
    const img: Record<string, unknown> = { type: 'node', tag: 'img', ...rest };
    if (Object.keys(attrs).length) img.attributes = attrs;
    if (style !== undefined) img.style = style;
    return img;
  }
  return n;
}

/**
 * Canonicalize a verbatim multi-line `_code` expression by stripping the common leading
 * indentation of lines 2..n (line 1 follows `{` so it carries no source indent). The emit placer
 * re-indents the whole block per nesting level, so an inline multi-line expr (one containing JSX,
 * which can't hoist to the TS frontmatter) would otherwise re-capture the added indent on each
 * round-trip and the next emit would add it AGAIN (unbounded drift). Dedenting to a fixed point
 * here AND in parse's codeMarker makes emit∘parse stable. Single-line exprs are untouched.
 *
 * A line whose start is INSIDE a backtick template literal is left alone — that leading whitespace
 * is significant string content (`` `…\n    sig\n  ` ``), so dedenting it would silently corrupt
 * the verbatim value the `_code` escape hatch exists to preserve.
 */
export function dedentCode(expr: string): string {
  if (!expr.includes('\n')) return expr;
  // Offsets inside a template-literal interior are protected (string content, never code indent).
  // No backtick → cheap path. scanTemplate/scanString skip interpolation + escapes correctly.
  const protectedRanges: Array<[number, number]> = [];
  if (expr.includes('`')) {
    let i = 0;
    while (i < expr.length) {
      const c = expr[i];
      if (c === '`') {
        const end = scanTemplate(expr, i);
        protectedRanges.push([i + 1, end - 1]);
        i = end;
      } else if (c === '"' || c === "'") {
        i = scanString(expr, i);
      } else i++;
    }
  }
  const isProtected = (off: number): boolean => protectedRanges.some(([s, e]) => off >= s && off < e);
  const lines = expr.split('\n');
  const starts: number[] = [];
  for (let k = 0, acc = 0; k < lines.length; k++) {
    starts.push(acc);
    acc += lines[k]!.length + 1;
  }
  let min = Number.POSITIVE_INFINITY;
  for (let k = 1; k < lines.length; k++) {
    const l = lines[k]!;
    if (!l.trim() || isProtected(starts[k]!)) continue;
    min = Math.min(min, l.length - l.trimStart().length);
  }
  if (!Number.isFinite(min) || min === 0) return expr;
  return [lines[0], ...lines.slice(1).map((l, idx) => (isProtected(starts[idx + 1]!) ? l : l.slice(min)))].join('\n');
}

/** The static `base` declaration object of a StyleValue (responsive `{base,…}` or flat), or `{}`. */
function styleBaseOf(style: unknown): Record<string, unknown> {
  if (!style || typeof style !== 'object') return {};
  const s = style as Record<string, unknown>;
  if ('base' in s || 'tablet' in s || 'mobile' in s) {
    return s.base && typeof s.base === 'object' ? (s.base as Record<string, unknown>) : {};
  }
  return s; // flat
}

/** Merge `decls` into a StyleValue's base (decls win — an inline `style=` outranks a class in the
 *  browser, so absorbing it must preserve that precedence). Keeps any tablet/mobile breakpoints. */
function mergeStyleBase(style: unknown, decls: Record<string, string>): Record<string, unknown> {
  const s = style && typeof style === 'object' ? { ...(style as Record<string, unknown>) } : {};
  const responsive = 'base' in s || 'tablet' in s || 'mobile' in s;
  if (!responsive && Object.keys(s).length > 0) return { ...s, ...decls }; // flat existing style
  const base = s.base && typeof s.base === 'object' ? (s.base as Record<string, unknown>) : {};
  s.base = { ...base, ...decls };
  return s;
}

/**
 * Absorb a foreign inline `style=` attribute into `node.style` (one style system, editable in the
 * Styles panel) — static declarations and CSS-literal-ternary bindings become `style.base`. An
 * inline style that can't be modeled (a non-CSS-literal dynamic binding) is left as the verbatim
 * `attributes.style` it already is. Mutates `out`. See ./inlineStyle.
 */
function absorbInlineStyle(out: Record<string, unknown>): void {
  const attrs = out.attributes;
  if (!attrs || typeof attrs !== 'object') return;
  const raw = (attrs as Record<string, unknown>).style;
  if (typeof raw !== 'string') return;
  const decls = inlineStyleToStyleDecls(raw, styleBaseOf(out.style));
  if (!decls) return;
  out.style = mergeStyleBase(out.style, decls);
  // Replace (don't mutate) the attributes object — normalizeNode shallow-copies the node, so
  // `attrs` is shared with the input; an in-place delete would corrupt it (e.g. the candidate the
  // expression-list round-trip gate normalizes for comparison).
  const nextAttrs = { ...(attrs as Record<string, unknown>) };
  delete nextAttrs.style;
  if (Object.keys(nextAttrs).length === 0) delete out.attributes;
  else out.attributes = nextAttrs;
}

/**
 * Does this `<img>` src point at a LOCAL, raster image worth routing through `astro:assets`
 * (the `<MenoImage>` wrapper)? Local images opt INTO optimization by DEFAULT — `normalizeNode`
 * stamps the `data-meno-optimize="true"` marker on them, and the editor's "Optimize with Astro"
 * toggle reads on for them — so every local image lazy-loads / gets responsive output unless the
 * author explicitly opts out (`data-meno-optimize="false"`). Remote / protocol-relative / data:
 * / `.svg` srcs are NEVER defaulted (they stay a bare `<img>` unless the marker is set explicitly),
 * mirroring `MenoImage`'s "optimize only where Astro can" graceful degradation. The editor mirrors
 * this exact predicate in `PropsPanel/AttributesEditor` to render the same default-on state.
 */
export function isLocalOptimizableSrc(src: unknown): boolean {
  if (typeof src !== 'string') return false;
  const s = src.trim();
  if (s === '') return false;
  if (/^https?:\/\//i.test(s)) return false; // remote — opt-in only (the default is local-scoped)
  if (s.startsWith('//')) return false; // protocol-relative remote
  if (/^data:/i.test(s)) return false; // inline data URI — not a fetchable file
  if (/\.svg(?:[?#]|$)/i.test(s)) return false; // vector — no raster gain, and Image can choke on it
  return true;
}

export function normalizeNode(node: unknown): unknown {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return node;
  // Verbatim-code marker ({ _code, expr }) — canonicalize its indentation (see dedentCode) so it
  // stays idempotent, then pass through (never mistaken for a structural node).
  if ((node as Record<string, unknown>)._code === true) {
    const expr = (node as Record<string, unknown>).expr;
    return typeof expr === 'string' ? { ...(node as Record<string, unknown>), expr: dedentCode(expr) } : node;
  }
  const out = migrateLegacy({ ...(node as Record<string, unknown>) });

  // Fold a foreign inline `style=` (kept verbatim by the parser as attributes.style) into the
  // Meno `node.style` model, so a hand-authored element styles like any other node — one system,
  // editable in the Styles panel. Runs before the style cleanup below so the merged style is
  // sanitized. Un-modelable dynamic styles stay as the attributes.style binding they already are.
  absorbInlineStyle(out);

  if ('style' in out && !hasStyleContent(out.style)) delete out.style;
  if (out.style !== undefined) out.style = sanitizeStyleValue(out.style);
  if (Array.isArray(out.interactiveStyles)) out.interactiveStyles = sanitizeInteractive(out.interactiveStyles);

  // Legacy HTML `props` is the old way of specifying attributes (backward-compat
  // field on `node`). Merge it into `attributes` (newer wins) and drop it.
  if (out.type === 'node' && out.props && typeof out.props === 'object') {
    out.attributes = { ...(out.props as object), ...((out.attributes as object) ?? {}) };
    delete out.props;
  }

  // Local images opt INTO `astro:assets` optimization by default: stamp the marker the emitter
  // (`isOptimizedImg` → `<MenoImage>`) and editor toggle read, unless the author already chose
  // (an explicit `"true"`/`"false"` is left intact — `"false"` is the per-image opt-out). Runs
  // after legacy `props` fold so a migrated `image` node is covered. Idempotent: a stamped node
  // re-normalizes to itself. Replace (don't mutate) `attributes` — it is shared with the input.
  if (
    out.type === 'node' &&
    String(out.tag).toLowerCase() === 'img' &&
    out.attributes &&
    typeof out.attributes === 'object'
  ) {
    const attrs = out.attributes as Record<string, unknown>;
    if (attrs['data-meno-optimize'] === undefined && isLocalOptimizableSrc(attrs.src)) {
      out.attributes = { ...attrs, 'data-meno-optimize': 'true' };
    }
  }

  if (out.type === 'list') {
    // Legacy list nodes stored the collection name in the deprecated `collection` field
    // (pre `source`/`sourceType` unification). Promote a STRING `collection` to `source`
    // when `source` is absent, and infer `sourceType: 'collection'` when it wasn't set —
    // so the unified emit path resolves it and singularize() never sees an undefined
    // source ("collection.endsWith" crash). An ARRAY `collection` is the old item-ID list
    // (different semantics) and is left untouched.
    if (typeof out.collection === 'string') {
      if (out.source === undefined || out.source === '') {
        out.source = out.collection;
        if (out.sourceType === undefined) out.sourceType = 'collection';
      }
      // Legacy collection lists always used `item` as the implicit loop var (the old cms-list
      // model — see the migration above), and their children/sub-components reference `{{item.*}}`.
      // The unified model instead defaults the loop var to singularize(source), which both
      // mismatches those children and can be an invalid JS `.map` arg for a hyphenated collection
      // (e.g. "case-study" → `.map((case-study) => …)`). So bind the loop to `item` whenever the
      // deprecated `collection` field marks this as legacy data and no explicit itemAs was set.
      if (out.itemAs === undefined) out.itemAs = 'item';
      // Drop the now-redundant deprecated field once `source` carries the value (emit reads
      // only `source`); keep it only if it disagrees with a pre-existing source (no data loss).
      if (out.source === out.collection) delete out.collection;
    }
    const sourceType = (out.sourceType as string) ?? 'prop';
    // Prop-list source: bare `items` ≡ `{{items}}` (canonical form the editor uses). Gated to
    // 'prop' so a 'remote' list's `url` is never wrapped (remote uses `url`, not `source`).
    if (sourceType === 'prop' && typeof out.source === 'string' && !out.source.includes('{{')) {
      out.source = `{{${out.source}}}`;
    }
    // Drop a redundant `itemAs` that equals the implicit default (singular collection name for
    // 'collection'; 'item' for 'prop' and 'remote').
    const defaultItem = sourceType === 'collection' ? singularize(String(out.source)) : 'item';
    if (out.itemAs === defaultItem) delete out.itemAs;
  }

  if ('children' in out) {
    const c = normalizeChildren(out.children);
    if (c === undefined) delete out.children;
    else out.children = c;
  }
  if ('default' in out) {
    const d = normalizeChildren(out.default);
    if (d === undefined) delete out.default;
    else out.default = d;
  }
  return out;
}

/**
 * Canonicalize a component's `defineVars` so round-trip is exact (mutates `comp`):
 *
 *  - **Collapse "all props" → `true`.** A `string[]` whose set equals all interface
 *    prop names (excluding `children`) becomes `true`. So model `true` → emit
 *    `define:vars={{ …all… }}` → parse `[…all…]` → normalize back to `true`. An
 *    explicit list that happens to name every prop is semantically identical and is
 *    canonicalized the same way (matching how the editor regenerates props on save).
 *  - **Drop a meaningless `defineVars`.** With no `javascript` there is no `<script>`
 *    to carry the directive, so `defineVars` round-trips as absent → drop it here.
 *
 * Idempotent: re-running over canonical output is a no-op.
 */
function normalizeDefineVars(comp: Record<string, unknown>): void {
  if (comp.defineVars === undefined) return;

  // No script → no `define:vars` directive emitted → drop the meaningless field.
  if (!comp.javascript) {
    delete comp.defineVars;
    return;
  }

  if (Array.isArray(comp.defineVars)) {
    // Compare against the BINDABLE interface props — emit can only inject those into
    // `define:vars={{ … }}` (defineVarNames filters identically), so a list equal to
    // them is what `true` round-trips through.
    const names = comp.defineVars as string[];
    const all = Object.keys((comp.interface as Record<string, unknown>) ?? {}).filter(
      (k) => k !== 'children' && isBindableIdent(k),
    );
    const sameSet =
      names.length === all.length && new Set(names).size === all.length && all.every((k) => names.includes(k));
    if (sameSet) comp.defineVars = true;
  }
}

/**
 * Canonicalize a verbatim frontmatter passthrough field (`_frontmatter`): trim surrounding
 * whitespace and drop it when empty, so parse (which always trims) and a hand-written model
 * agree, and the round-trip stays idempotent.
 */
function normalizeFrontmatter(obj: Record<string, unknown>): void {
  if (!('_frontmatter' in obj)) return;
  const v = obj._frontmatter;
  if (typeof v !== 'string' || !v.trim()) delete obj._frontmatter;
  else obj._frontmatter = v.trim();
}

export function normalizeModel(model: unknown): unknown {
  if (!model || typeof model !== 'object') return model;
  const m = model as Record<string, unknown>;

  // Component file: { component: { structure, … } }
  if (m.component && typeof m.component === 'object') {
    const comp = { ...(m.component as Record<string, unknown>) };
    if ('interface' in comp && (!comp.interface || Object.keys(comp.interface as object).length === 0)) {
      delete comp.interface;
    }
    if (comp.structure !== undefined) comp.structure = normalizeNode(comp.structure);
    normalizeDefineVars(comp);
    normalizeFrontmatter(comp);
    return { ...m, component: comp };
  }

  // Page: { meta?, root?, … } — or a raw component definition (handled by emit()'s dispatch);
  // both carry `_frontmatter`, so canonicalize it here too.
  const out: Record<string, unknown> = { ...m };
  if ('meta' in out && (!out.meta || Object.keys(out.meta as object).length === 0)) delete out.meta;
  if (out.root !== undefined) out.root = normalizeNode(out.root);
  normalizeFrontmatter(out);
  return out;
}
