/**
 * meno-astro — interactive (state) styles as Tailwind-style VARIANT CLASSES.
 *
 * Meno models hover/focus/active styling as `interactiveStyles` rules (`{ name?, prefix?, postfix,
 * style }`). The class-string migration moves the losslessly-expressible ones into the class string
 * as variant tokens — `hover:bg-[#222]`, `focus:text-[red]`, `active:opacity-[0.8]` — so they live
 * alongside the rest of the styling instead of in a separate style-object field. The codec converts
 * convertible rules ⇄ tokens (emit preprocess / parse postprocess); anything not losslessly
 * convertible (a `prefix`, a context/compound `postfix`, a responsive/`_mapping`/hash-fallback
 * style, a non-canonical `name`, or a duplicated postfix) stays on the existing
 * `style(…, { interactive })` path (the remainder) — the same self-gating pattern as prop→variant.
 *
 * ── Published-only by design (see dialect/styleValues.ts) ──────────────────────────────────────
 * Bundled into published `meno-astro/dialect` + `/integration` with `meno-core` EXTERNAL, so this
 * uses ONLY already-published meno-core primitives (`stylesToClasses`/`classesToStyles`/
 * `classToStyle`/`generateRuleForClass`/`splitVariantPrefix`) and inlines the tiny CSS-class escaper
 * — the CSS-generation extension ships in the meno-astro tarball, needing NO meno-core publish.
 */
import { stylesToClasses, classesToStyles, classToStyle, generateRuleForClass } from 'meno-core/shared';
import type { InteractiveStyleRule, StyleValue, StyleObject } from 'meno-core/shared';
import { applyRemConversion, type RemConversionConfig } from './remConversion';

/** The supported state variants — token ⇄ pseudo-class ⇄ canonical rule name (the names the
 *  website analyzer / editor assign, so reconstructed rules round-trip exactly). v1 = the three the
 *  converter actually emits; extend the table to add more pseudo-states. */
const VARIANTS: ReadonlyArray<{ token: string; postfix: string; name: string }> = [
  { token: 'hover', postfix: ':hover', name: 'onHover' },
  { token: 'focus', postfix: ':focus', name: 'onFocus' },
  { token: 'active', postfix: ':active', name: 'onActive' },
];
const BY_POSTFIX = new Map(VARIANTS.map((v) => [v.postfix, v]));
const BY_TOKEN = new Map(VARIANTS.map((v) => [v.token, v]));

/** CSS-class escaper — a byte-for-byte copy of meno-core cssGeneration's private `escapeCSSClassName`
 *  (not exported). Escapes everything outside the safe identifier charset, so `hover:bg-[#222]` →
 *  `hover\:bg-\[#222\]`. */
function escapeClass(cls: string): string {
  return cls.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

/** Split a class token into its state variant + base utility, or null if it isn't a state-variant
 *  class. `hover:bg-[#222]` → `{ variant, base: 'bg-[#222]' }`. (Breakpoint-prefixed forms like
 *  `tablet:hover:…` are NOT recognized — v1 converts base-only interactive styles.) */
function splitStateVariant(
  cls: string,
): { variant: { token: string; postfix: string; name: string }; base: string } | null {
  const colon = cls.indexOf(':');
  if (colon < 0) return null;
  const variant = BY_TOKEN.get(cls.slice(0, colon));
  if (!variant) return null;
  const base = cls.slice(colon + 1);
  return base ? { variant, base } : null;
}

/** True for a class token that is a state-variant class (`hover:…`/`focus:…`/`active:…`). */
export function isStateVariantClass(cls: string): boolean {
  return splitStateVariant(cls) !== null;
}

// ---------------------------------------------------------------------------
// Build-time CSS generation (the publish-sensitive part).
// ---------------------------------------------------------------------------

/**
 * Generate the CSS for state-variant class tokens: `hover:bg-[#222]` →
 * `.hover\:bg-\[#222\]:hover { background-color: #222; }`. The base utility's declarations come from
 * the published meno-core `generateRuleForClass`; the selector escapes the full token and appends the
 * pseudo-class. Tokens that aren't state-variant classes, or whose base yields no rule, are skipped.
 *
 * `remConfig` (the project's "Convert px to rem" setting) converts each rule's px declarations to rem —
 * the meno-core generators do this for base/interactive CSS internally, so applying it here keeps the
 * state-variant rules consistent (same conversion the base utilities get). A no-op when disabled.
 */
export function generateStateVariantCss(classes: Iterable<string>, remConfig?: RemConversionConfig): string {
  const rules: string[] = [];
  const seen = new Set<string>();
  for (const cls of classes) {
    if (seen.has(cls)) continue;
    seen.add(cls);
    const split = splitStateVariant(cls);
    if (!split) continue;
    const decls = generateRuleForClass(split.base);
    if (!decls) continue;
    rules.push(`.${escapeClass(cls)}${split.variant.postfix} { ${applyRemConversion(decls, remConfig)} }`);
  }
  return rules.join('\n');
}

// ---------------------------------------------------------------------------
// Codec: interactiveStyles ⇄ variant tokens.
// ---------------------------------------------------------------------------

function isResponsive(style: StyleValue): boolean {
  return typeof style === 'object' && style !== null && ('base' in style || 'tablet' in style || 'mobile' in style);
}

/** The flat base StyleObject of a rule's style — flat objects pass through; `{ base }` unwraps;
 *  a style with tablet/mobile (responsive interactive) is rejected (null) for v1. */
function flatBaseStyle(style: StyleValue): StyleObject | null {
  if (!style || typeof style !== 'object') return null;
  if (isResponsive(style)) {
    const r = style as Record<string, unknown>;
    if (r.tablet || r.mobile) return null; // responsive interactive → remainder
    return (r.base as StyleObject) ?? null;
  }
  return style as StyleObject;
}

/** A deterministic JSON of a style object for lossless-round-trip comparison (key order normalized). */
function styleKey(style: StyleObject): string {
  return JSON.stringify(Object.fromEntries(Object.entries(style).sort(([a], [b]) => a.localeCompare(b))));
}

/** The base utility classes a rule's style losslessly maps to, or null when it can't be a variant
 *  class — responsive, prop-`_mapping`, hash-fallback (un-encodable) value, or any value that doesn't
 *  round-trip exactly through `classesToStyles`. Mirrors the prop→variant convertibility gate. */
function styleToBaseClasses(style: StyleValue): string[] | null {
  const flat = flatBaseStyle(style);
  if (!flat || Object.keys(flat).length === 0) return null;
  // A prop `_mapping` value (object with `_mapping`) can't be a static class.
  for (const v of Object.values(flat)) {
    if (v && typeof v === 'object') return null;
    if (typeof v === 'string' && v.includes('{{')) return null; // template → not static
  }
  const classes = stylesToClasses(flat);
  if (classes.length === 0) return null;
  // Lossless gate: the classes must reverse to exactly the input (rejects hash-fallback values too —
  // those reverse to null/registry-dependent, so the round-trip won't match). The base classes are
  // never variant-prefixed (a flat style mints unprefixed utilities), so an arbitrary-property class
  // like `[background:#222]` is fine — its `:` is inside brackets, escaped in the selector.
  const back = classesToStyles(classes);
  const backBase = back && typeof back === 'object' ? ((back as Record<string, unknown>).base as StyleObject) : null;
  if (!backBase || styleKey(backBase) !== styleKey(flat)) return null;
  return classes;
}

/** Is a single rule losslessly convertible to variant tokens? */
function isConvertibleRule(rule: InteractiveStyleRule): boolean {
  if (rule.prefix) return false; // context/descendant selector → remainder
  if (rule.previewProp) return false;
  const variant = rule.postfix ? BY_POSTFIX.get(rule.postfix) : undefined;
  if (!variant) return false; // unknown/compound postfix (`.is-active:hover`, ` ~ `, …) → remainder
  if (rule.name !== undefined && rule.name !== variant.name) return false; // non-canonical name → remainder
  return styleToBaseClasses(rule.style) !== null;
}

/**
 * Convert a node's whole `interactiveStyles` array to variant-class tokens, or null when ANY rule is
 * not losslessly convertible OR two rules share a postfix (would merge on parse) — all-or-nothing, so
 * a partially-converted node never reorders/loses rules on round-trip. Each rule's style classes are
 * prefixed with the variant token (`bg-[#222]` → `hover:bg-[#222]`), in rule order.
 */
export function interactiveToTokens(rules: InteractiveStyleRule[] | undefined): string[] | null {
  if (!rules || rules.length === 0) return null;
  const postfixes = new Set<string>();
  const tokens: string[] = [];
  for (const rule of rules) {
    if (!isConvertibleRule(rule)) return null;
    if (postfixes.has(rule.postfix!)) return null; // duplicate postfix → ambiguous on parse
    postfixes.add(rule.postfix!);
    const variant = BY_POSTFIX.get(rule.postfix!)!;
    const base = styleToBaseClasses(rule.style)!;
    for (const c of base) tokens.push(`${variant.token}:${c}`);
  }
  return tokens;
}

/** Reconstruct `interactiveStyles` rules from state-variant tokens (the inverse of
 *  {@link interactiveToTokens}), grouping by variant in first-appearance order so the rule order
 *  matches emit. Each variant becomes one rule `{ name, postfix, style: { base } }`. */
export function reconstructInteractive(tokens: string[]): InteractiveStyleRule[] {
  const order: string[] = [];
  const byVariant = new Map<
    string,
    { variant: { token: string; postfix: string; name: string }; style: StyleObject }
  >();
  for (const tok of tokens) {
    const split = splitStateVariant(tok);
    if (!split) continue;
    const entry = classToStyle(split.base);
    if (!entry) continue;
    let group = byVariant.get(split.variant.token);
    if (!group) {
      group = { variant: split.variant, style: {} };
      byVariant.set(split.variant.token, group);
      order.push(split.variant.token);
    }
    group.style[entry.prop] = entry.value;
  }
  return order.map((token) => {
    const g = byVariant.get(token)!;
    return { name: g.variant.name, postfix: g.variant.postfix, style: { base: g.style } };
  });
}

/** Partition a class string into its state-variant tokens (in order) and the remaining (non-variant)
 *  class string. Used by parse to lift variant tokens out of `attributes.class` into interactiveStyles. */
export function extractStateVariantTokens(classString: string): { tokens: string[]; rest: string } {
  const tokens: string[] = [];
  const rest: string[] = [];
  for (const tok of classString.split(/\s+/)) {
    if (!tok) continue;
    if (isStateVariantClass(tok)) tokens.push(tok);
    else rest.push(tok);
  }
  return { tokens, rest: rest.join(' ') };
}

// ---------------------------------------------------------------------------
// Codec transforms: lower on emit, lift on parse.
// ---------------------------------------------------------------------------

/** A plain HTML element node (carries `attributes`), not a component instance (carries `props`). */
function isElementNode(obj: Record<string, unknown>): boolean {
  // Nodes that store styling on `attributes.class`: HTML elements (have a `tag`) plus the html-like
  // content nodes embed/link/markdown. Mirrors meno-core's `isClassStylableNode` (the class-styling
  // eligible set) — inlined here because the published codec can't import a non-published meno-core
  // helper. Component instances use the `class` PROP (not attributes.class), so stay excluded.
  if (typeof obj.tag === 'string' && obj.component === undefined) return true;
  return obj.type === 'embed' || obj.type === 'link' || obj.type === 'markdown';
}

function mergeClassTokens(existing: unknown, tokens: string[]): string {
  const set = new Set(typeof existing === 'string' ? existing.split(/\s+/).filter(Boolean) : []);
  for (const t of tokens) set.add(t);
  return [...set].join(' ');
}

/**
 * EMIT preprocess — return a transformed copy of the model in which every element node whose WHOLE
 * `interactiveStyles` array is losslessly convertible has those rules lowered into variant-class
 * tokens on `attributes.class` (and `interactiveStyles` dropped). Non-convertible nodes pass through
 * unchanged (their interactiveStyles stay on the `style(…, { interactive })` path). Deep-clones every
 * node (new objects) — emit's only identity dependency is the structure root, which is re-derived
 * from the cloned tree consistently. Skips `style`/`interactiveStyles` leaves in the recursion.
 */
export function lowerInteractiveToTokens(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(lowerInteractiveToTokens);
  if (!node || typeof node !== 'object') return node;
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let tokens: string[] | null = null;
  if (Array.isArray(obj.interactiveStyles) && isElementNode(obj)) {
    tokens = interactiveToTokens(obj.interactiveStyles as InteractiveStyleRule[]);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (tokens && k === 'interactiveStyles') continue; // lowered into the class below — drop
    if (k === 'style' || k === 'interactiveStyles')
      out[k] = v; // style leaves: copy as-is
    else out[k] = lowerInteractiveToTokens(v);
  }
  if (tokens) {
    const attrs = (
      out.attributes && typeof out.attributes === 'object' ? { ...(out.attributes as object) } : {}
    ) as Record<string, unknown>;
    attrs.class = mergeClassTokens(attrs.class, tokens);
    out.attributes = attrs;
  }
  return out;
}

/**
 * PARSE postprocess — MUTATE the parsed model in place (preserving node identity, so span tracking
 * still works), lifting any state-variant tokens out of each node's `attributes.class` back into
 * reconstructed `interactiveStyles` rules. The non-variant remainder stays on `attributes.class`
 * (deleted when empty). The inverse of {@link lowerInteractiveToTokens}.
 */
export function liftTokensToInteractive(node: unknown): void {
  if (Array.isArray(node)) {
    for (const n of node) liftTokensToInteractive(n);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const attrs = obj.attributes as Record<string, unknown> | undefined;
  if (attrs && typeof attrs.class === 'string') {
    const { tokens, rest } = extractStateVariantTokens(attrs.class);
    if (tokens.length > 0) {
      const reconstructed = reconstructInteractive(tokens);
      obj.interactiveStyles = Array.isArray(obj.interactiveStyles)
        ? [...(obj.interactiveStyles as InteractiveStyleRule[]), ...reconstructed]
        : reconstructed;
      if (rest) {
        attrs.class = rest;
      } else {
        delete attrs.class;
        if (Object.keys(attrs).length === 0) delete obj.attributes; // don't leave an empty attributes:{}
      }
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'style' || k === 'interactiveStyles' || k === 'attributes') continue;
    liftTokensToInteractive(v);
  }
}
