/**
 * meno-astro — durable `__styleValues` side-channel for hash-fallback utility classes.
 *
 * A class-string-stored value that can't be reversibly encoded in a class attribute
 * (quotes/brackets/commas — e.g. `grid-template-areas:"a a" "b c"`) becomes a HASH-FALLBACK
 * class (`<root>-h<hash>` / `<cssprop>-h<hash>`) whose real value lives only in meno-core's
 * in-memory `styleValueRegistry` — NOT in the `.astro`. A fresh process that loads such a class
 * from disk loses the value (see meno-core `utilityClassMapper.durability.test.ts`).
 *
 * The codec closes this by emitting those (class → value) pairs into the `.astro` frontmatter as
 * `const __styleValues = {…}` ({@link emitStyleValuesConst}) and restoring them on parse / build
 * ({@link restoreStyleValuesFromCode}), so `classToStyle` and the build-time CSS generator recover
 * the value without a warm forward pass. The const is emit-only (re-derived every emit from the
 * warm registry; the parser drops it, see frontmatterScan `isRecognizedConst`), like `__meno`.
 *
 * ── Published-only by design ───────────────────────────────────────────────────────────────────
 * This module is bundled into published `meno-astro/dialect`, which keeps `meno-core` EXTERNAL
 * (resolved against npm meno-core at runtime). So it imports ONLY already-published meno-core
 * primitives (the registry get/register fns + `splitVariantPrefix`) and re-implements the
 * hash-fallback detection locally — adding a NEW core export here would crash the published
 * runtime with "does not provide an export" (cf. the [astro runtime uses npm meno-core] landmine).
 *
 * Format — keyed by class name, uniform `{ v, p? }` (`p` = the CSS property for unknown-root /
 * dynamic-hash classes, which the hash also hides):
 *   const __styleValues = { "grid-template-areas-h1abc": { "v": "\"a a\" \"b c\"", "p": "grid-template-areas" } };
 */
import {
  getStyleValue,
  getDynamicStyle,
  registerStyleValue,
  registerDynamicStyle,
  splitVariantPrefix,
} from 'meno-core/shared';
import { serializeLiteral } from './emit/serialize';

const ANCHOR = 'const __styleValues = ';

type StyleValueEntry =
  | { class: string; value: string | number }
  | { class: string; property: string; value: string | number };

/**
 * 32-bit FNV-1a hash, base36 — a byte-for-byte copy of meno-core `utilityClassMapper`'s private
 * `shortHash`, the function that mints `…-h<hash>` class suffixes. Copied (not imported) because
 * core does NOT export it AND the meno-core barrel's exported `shortHash` is a DIFFERENT algorithm
 * (DJB2, in `elementClassName`). Detection below recomputes this over a registered value and matches
 * it against the class's `-h<hash>` suffix — so a drift from core is caught by styleValues.test.ts
 * (emit would stop side-channelling the minted class).
 */
function fnvShortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/** Whether `cls` is a hash-fallback class for `value` — i.e. its name ends with the minted
 *  `-h<fnv(value)>` suffix (so its value is NOT recoverable from the name and must be side-channelled).
 *  Precise: a keyword class like `overflow-hidden` (value `hidden`) ends with `-hidden`, never
 *  `-h<fnv("hidden")>`, so it's correctly excluded. */
function isHashFallback(cls: string, value: string | number): boolean {
  return cls.endsWith(`-h${fnvShortHash(String(value))}`);
}

/** Deep-walk a model's node tree, collecting every utility-class token from element
 *  `attributes.class` and component-instance `props.class` strings. (Style OBJECTS in `style`
 *  carry their own literal value, so they're already durable — only class STRINGS need this.) */
function collectClassTokens(node: unknown, into: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) collectClassTokens(n, into);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const key of ['attributes', 'props'] as const) {
    const bag = obj[key];
    const cls = bag && typeof bag === 'object' ? (bag as Record<string, unknown>).class : undefined;
    if (typeof cls === 'string' && !cls.includes('{{')) {
      for (const t of cls.split(/\s+/)) if (t) into.add(t);
    }
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'style' || k === 'interactiveStyles' || k === 'attributes' || k === 'props') continue;
    collectClassTokens(v, into);
  }
}

/** The durable (class → value) entries for class tokens that need side-channelling (hash-fallback
 *  only). Reads the warm registry; variant prefixes are stripped (`tablet:x-h…` keys on `x-h…`). */
function collectStyleValueEntries(tokens: Iterable<string>): StyleValueEntry[] {
  const out: StyleValueEntry[] = [];
  const seen = new Set<string>();
  for (const raw of tokens) {
    const cls = splitVariantPrefix(raw).base;
    if (seen.has(cls)) continue;
    seen.add(cls);
    const dyn = getDynamicStyle(cls);
    if (dyn) {
      if (isHashFallback(cls, dyn.value)) out.push({ class: cls, property: dyn.property, value: dyn.value });
      continue;
    }
    const val = getStyleValue(cls);
    if (val !== undefined && isHashFallback(cls, val)) out.push({ class: cls, value: val });
  }
  return out;
}

/** Serialize entries to the `__styleValues` const object (keyed by class, `{ v, p? }`, stable order). */
function entriesToConstObject(entries: StyleValueEntry[]): Record<string, { v: string | number; p?: string }> {
  const out: Record<string, { v: string | number; p?: string }> = {};
  for (const e of [...entries].sort((a, b) => a.class.localeCompare(b.class))) {
    out[e.class] = 'property' in e ? { v: e.value, p: e.property } : { v: e.value };
  }
  return out;
}

/** Reverse {@link entriesToConstObject}: the parsed const object → entries. */
function constObjectToEntries(obj: unknown): StyleValueEntry[] {
  if (!obj || typeof obj !== 'object') return [];
  const out: StyleValueEntry[] = [];
  for (const [cls, raw] of Object.entries(obj as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const { v, p } = raw as { v?: string | number; p?: string };
    if (v === undefined) continue;
    out.push(typeof p === 'string' ? { class: cls, property: p, value: v } : { class: cls, value: v });
  }
  return out;
}

/**
 * The `const __styleValues = {…};` line for a model (page root or component definition), or null
 * when no node carries a hash-fallback class. Must run while the registry is warm (right after the
 * forward pass that minted the classes, or after a `restoreStyleValuesFromCode` earlier this
 * process) — see the module header.
 */
export function emitStyleValuesConst(model: unknown): string | null {
  const tokens = new Set<string>();
  collectClassTokens(model, tokens);
  if (tokens.size === 0) return null;
  const entries = collectStyleValueEntries(tokens);
  if (entries.length === 0) return null;
  return `${ANCHOR}${serializeLiteral(entriesToConstObject(entries), { indent: 0 })};`;
}

/** Read a `.astro`'s `__styleValues` const and re-register its values into meno-core's registry,
 *  so `classToStyle` / the build CSS scan recover hash-fallback values without a warm forward pass.
 *  No-op when the const is absent. */
export function restoreStyleValuesFromCode(
  code: string,
  readLiteralAfter: (code: string, anchor: string) => unknown,
): void {
  const literal = readLiteralAfter(code, ANCHOR);
  if (literal === undefined) return;
  for (const e of constObjectToEntries(literal)) {
    if ('property' in e) registerDynamicStyle(e.class, e.property, e.value);
    else registerStyleValue(e.class, e.value);
  }
}
