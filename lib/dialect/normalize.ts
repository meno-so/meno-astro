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

function normalizeNode(node: unknown): unknown {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return node;
  // Verbatim-code marker ({ _code, expr }) is canonical by construction — pass through
  // untouched so it stays idempotent and is never mistaken for a structural node.
  if ((node as Record<string, unknown>)._code === true) return node;
  const out = migrateLegacy({ ...(node as Record<string, unknown>) });

  if ('style' in out && !hasStyleContent(out.style)) delete out.style;
  if (out.style !== undefined) out.style = sanitizeStyleValue(out.style);
  if (Array.isArray(out.interactiveStyles)) out.interactiveStyles = sanitizeInteractive(out.interactiveStyles);

  // Legacy HTML `props` is the old way of specifying attributes (backward-compat
  // field on `node`). Merge it into `attributes` (newer wins) and drop it.
  if (out.type === 'node' && out.props && typeof out.props === 'object') {
    out.attributes = { ...(out.props as object), ...((out.attributes as object) ?? {}) };
    delete out.props;
  }

  if (out.type === 'list') {
    const sourceType = (out.sourceType as string) ?? 'prop';
    // Prop-list source: bare `items` ≡ `{{items}}` (canonical form the editor uses).
    if (sourceType !== 'collection' && typeof out.source === 'string' && !out.source.includes('{{')) {
      out.source = `{{${out.source}}}`;
    }
    // Drop a redundant `itemAs` that equals the implicit default.
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
    return { ...m, component: comp };
  }

  // Page: { meta?, root?, … }
  const out: Record<string, unknown> = { ...m };
  if ('meta' in out && (!out.meta || Object.keys(out.meta as object).length === 0)) delete out.meta;
  if (out.root !== undefined) out.root = normalizeNode(out.root);
  return out;
}
