/**
 * Frontmatter structural scanner — the shared "what does the dialect recognize?" pass used
 * by both the foreign-frontmatter detector (`detectForeign.ts`) and the verbatim
 * passthrough extractor (`extractFrontmatterPassthrough`).
 *
 * It blanks string/template/comment interiors, then marks (covers) every span the emitter
 * REGENERATES on the next save: the runtime/component imports, `getStaticPaths`, and the
 * named/shaped consts `parseFrontmatter` reads back. Whatever is left uncovered is
 * hand-authored frontmatter the codec doesn't model — the detector reports it, the extractor
 * captures it verbatim.
 *
 * The recognized set must mirror `parseFrontmatter` + the `emit*` frontmatter assemblers
 * exactly — the no-false-positives test over `example/` (detectForeign.test.ts) is the guard.
 */

import { scanBalanced, scanString, scanTemplate, scanExprToSemicolon, splitTopLevel } from './scan';
import type { NodeSpan } from './parseContext';

/** Recognized named-const RHS prefixes (any const name is allowed when the RHS matches). */
const GET_COLLECTION_LIST = 'await getCollectionList(';
const GET_REMOTE_DATA = 'await getRemoteData(';
const GET_SANITY_DATA = 'await getSanityData(';
const LOAD_PAGE_DATA = 'await loadPageData('; // SSR-page data destructure RHS
const RESOLVE_PROPS = 'resolveProps(Astro';
/** Recognized destructure RHS forms (`const { … } = <here>`): `__props`, `Astro.props`. */
const ASTRO_PROPS = 'Astro.props';

/**
 * Return a copy of `code` with the INTERIORS of strings, template literals and comments
 * replaced by spaces (delimiters and newlines preserved, length unchanged). Lets the
 * regex/scan passes below treat code structurally without tripping over `//` in a URL or a
 * `{`/`;` inside a string. Throws (via scanString/scanTemplate) on an unterminated literal.
 */
export function blankNonCode(code: string): string {
  const out = code.split('');
  const blank = (s: number, e: number): void => {
    for (let k = s; k < e && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"' || c === "'") {
      const end = scanString(code, i);
      blank(i + 1, end - 1);
      i = end;
    } else if (c === '`') {
      const end = scanTemplate(code, i);
      blank(i + 1, end - 1);
      i = end;
    } else if (c === '/' && code[i + 1] === '/') {
      let k = i;
      while (k < code.length && code[k] !== '\n') out[k++] = ' ';
      i = k;
    } else if (c === '/' && code[i + 1] === '*') {
      let k = i + 2;
      while (k < code.length && !(code[k] === '*' && code[k + 1] === '/')) k++;
      blank(i, Math.min(k + 2, code.length));
      out[i] = ' ';
      out[i + 1] = ' ';
      i = k + 2;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Read a JS identifier starting at `i`; returns `''` if none. */
function readIdent(code: string, i: number): string {
  const m = /^[A-Za-z_$][\w$]*/.exec(code.slice(i));
  return m ? m[0] : '';
}

/** Index of the next non-whitespace char at or after `i`. */
function skipWs(code: string, i: number): number {
  while (i < code.length && /\s/.test(code[i] ?? '')) i++;
  return i;
}

/** Add every binding name in a destructuring pattern interior to `out` (recursing nested patterns). */
function addPatternNames(inner: string, isObject: boolean, out: Set<string>): void {
  for (const part of splitTopLevel(inner, ',')) {
    let tok = part.trim();
    if (!tok) continue; // array hole `[a, , b]`
    if (tok.startsWith('...')) tok = tok.slice(3).trim(); // rest element
    const eq = tok.indexOf('='); // default value `a = 1` → keep the LHS
    if (eq >= 0) tok = tok.slice(0, eq).trim();
    if (isObject) {
      // `key: local` — the BOUND name is the local (right of the colon), possibly itself a pattern.
      const colon = tok.indexOf(':');
      if (colon >= 0) tok = tok.slice(colon + 1).trim();
    }
    if (tok.startsWith('{')) addPatternNames(tok.slice(1, scanBalanced(tok, 0) - 1), true, out);
    else if (tok.startsWith('[')) addPatternNames(tok.slice(1, scanBalanced(tok, 0) - 1), false, out);
    else {
      const id = readIdent(tok, 0);
      if (id) out.add(id);
    }
  }
}

/**
 * Collect the top-level binding names DECLARED in a frontmatter passthrough block:
 * `const`/`let`/`var` (including object/array destructuring), `function`/`class`, and the
 * bindings introduced by an `import` (default, namespace, and named — honoring `as` aliases).
 *
 * Why this exists: the component emitter synthesizes an ambient `const { … } = Astro.props;`
 * destructure for every body identifier that isn't a declared prop (`collectItemBindings`).
 * A hand-authored passthrough (escalation-ladder rung 2/3 — a custom component reborn as a
 * Meno component) often ALREADY declares those identifiers (`const next =
 * Astro.url.searchParams.get('next')`, then `value={next}` in the body). Without subtracting
 * these names, emit would write a SECOND `const next` and the duplicate declaration breaks the
 * real `astro build`. Over-capture is safe here (it only suppresses an unneeded destructure);
 * under-capture is not. The body's reference then resolves to the passthrough const.
 */
export function collectFrontmatterDeclaredNames(frontmatter: string | undefined): string[] {
  if (!frontmatter) return [];
  let code: string;
  try {
    code = blankNonCode(frontmatter); // neutralize string/template/comment interiors
  } catch {
    return []; // unterminated literal — reported unparseable elsewhere
  }
  const names = new Set<string>();

  // const / let / var — named or destructuring.
  for (const m of code.matchAll(/\b(?:const|let|var)\s+/g)) {
    const at = skipWs(code, m.index! + m[0].length);
    const ch = code[at];
    if (ch === '{' || ch === '[') {
      addPatternNames(code.slice(at + 1, scanBalanced(code, at) - 1), ch === '{', names);
    } else {
      const id = readIdent(code, at);
      if (id) names.add(id);
    }
  }
  // function NAME / function* NAME / class NAME
  for (const m of code.matchAll(/\b(?:function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]!);
  }
  // imports — default, `* as NS`, and `{ a, b as c }` (side-effect `import '…'` declares nothing).
  for (const m of code.matchAll(/\bimport\b([\s\S]*?)\bfrom\b/g)) {
    let clause = m[1]!;
    if (/^\s*type\b/.test(clause)) clause = clause.replace(/^\s*type\b/, ''); // `import type { … }` binds no value
    const def = clause.match(/^\s*([A-Za-z_$][\w$]*)/);
    if (def) names.add(def[1]!);
    const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (ns) names.add(ns[1]!);
    const braced = clause.match(/\{([\s\S]*?)\}/);
    if (braced) {
      for (const part of splitTopLevel(braced[1]!, ',')) {
        const tok = part.trim();
        if (!tok) continue;
        const asM = tok.match(/\bas\s+([A-Za-z_$][\w$]*)/);
        const id = asM ? asM[1]! : readIdent(tok.replace(/^type\s+/, ''), 0);
        if (id) names.add(id);
      }
    }
  }
  return [...names];
}

/**
 * Is a `const` whose name is `name` and whose RHS (trimmed) is `rhs` one of the recognized
 * dialect forms? Mirrors the `matchAll` passes in `parseFrontmatter`.
 */
function isRecognizedConst(name: string, rhs: string): boolean {
  if (rhs.startsWith('`')) return true; // backtick template const (embed / Tag_N / hand-authored)
  if (rhs.startsWith(GET_COLLECTION_LIST)) return true; // collection-list binding
  if (rhs.startsWith(GET_REMOTE_DATA)) return true; // remote-data list binding
  if (rhs.startsWith(GET_SANITY_DATA)) return true; // sanity-data list binding
  if (rhs.startsWith(RESOLVE_PROPS)) return true; // `const __props = resolveProps(Astro, {…})`
  if (name === 'meta' || name === '__meno') return true; // page/component meta literals
  if (name === '__styleValues') return true; // emit-only durable hash-fallback value side-channel
  if (name === 'params' && rhs.startsWith('Astro.params')) return true; // SSR dynamic-route param scope
  if (name === 'prerender') return true; // emit-only CMS-route boilerplate (`export const prerender = true`)
  if (name === 'isEditorMode') return true; // emit-injected meno-core global (`= false`)
  if (/^Tag_\d+$/.test(name)) return true; // dynamic-tag const
  if (/^__code\d+$/.test(name)) return true; // hoisted verbatim-code const
  return false;
}

/**
 * Whether an `import` whose module specifier is `spec` is one the emitter REGENERATES on
 * save (so it must be covered — never captured as passthrough, or it would be duplicated).
 * `bare` is a side-effect import (`import '…'`, no bindings).
 *
 * Everything else — a user's `import { x } from '../lib/db.ts'`, an npm package, a custom
 * `import '../styles/extra.css'` — is FOREIGN and left uncovered so passthrough preserves it.
 */
function isRegeneratedImport(spec: string, bare: boolean): boolean {
  if (spec === 'meno-astro' || spec.startsWith('meno-astro/')) return true; // runtime + components
  if (spec === 'astro:content') return true; // getCollection (CMS boilerplate)
  if (spec.startsWith('./') || spec.startsWith('../')) {
    if (spec.endsWith('.astro')) return true; // local component import
    if (/\/islands\/.+\.(?:tsx|jsx|vue|svelte)$/i.test(spec)) return true; // island import
    if (spec.endsWith('/cmsComponents') || spec === './cmsComponents') return true; // rich-text registry
    if (bare && spec.endsWith('styles/theme.css')) return true; // generated theme stylesheet
    if (bare && spec.includes('/libraries/')) return true; // local library side-effect import
  }
  return false;
}

export interface CoverResult {
  /** `code` with string/template/comment interiors blanked (delimiters + newlines kept). */
  code: string;
  /** `covered[k] === 1` ⇔ source char `k` belongs to a recognized (emit-regenerated) span. */
  covered: Uint8Array;
}

export interface CoverOptions {
  /**
   * Cover EVERY import (the detector's behavior — it only asks "is there foreign code?",
   * and a foreign import is not itself flag-worthy). When false (the passthrough extractor),
   * only emit-regenerated imports are covered, so a foreign import stays captured.
   */
  coverAllImports: boolean;
}

/**
 * Mark every span of `raw` the dialect recognizes (and the emitter regenerates). Throws via
 * `blankNonCode` on an unterminated string/template — callers decide how to degrade.
 */
export function computeCover(raw: string, opts: CoverOptions): CoverResult {
  const code = blankNonCode(raw);
  const n = raw.length;
  const covered = new Uint8Array(n);
  const cover = (s: number, e: number): void => {
    for (let k = Math.max(0, s); k < e && k < n; k++) covered[k] = 1;
  };

  // 1. Imports — `import … from '<spec>'` and the side-effect `import '<spec>'` (multi-line
  //    tolerant). Cover all when `coverAllImports`, else only emit-regenerated specifiers.
  //    NB: the specifier is read from `raw` (not blanked `code`) — `blankNonCode` empties
  //    string interiors, so the spec must come from the un-blanked source slice.
  const specOf = (start: number, len: number, re: RegExp): string => {
    const sm = raw.slice(start, start + len).match(re);
    return sm ? (sm[1] ?? '') : '';
  };
  for (const m of code.matchAll(/\bimport\b[\s\S]*?\bfrom\s+(['"])([^'"]*)\1\s*;?/g)) {
    const spec = specOf(m.index!, m[0].length, /\bfrom\s+['"]([^'"]*)['"]/);
    if (opts.coverAllImports || isRegeneratedImport(spec, false)) cover(m.index!, m.index! + m[0].length);
  }
  for (const m of code.matchAll(/\bimport\s+(['"])([^'"]*)\1\s*;?/g)) {
    if (covered[m.index!]) continue; // already counted by the `from` pass
    const spec = specOf(m.index!, m[0].length, /\bimport\s+['"]([^'"]*)['"]/);
    if (opts.coverAllImports || isRegeneratedImport(spec, true)) cover(m.index!, m.index! + m[0].length);
  }

  // 2. CMS-template boilerplate: `export async function getStaticPaths() { … }` (no trailing `;`).
  for (const m of code.matchAll(/\b(?:export\s+)?(?:async\s+)?function\s+getStaticPaths\s*\([^)]*\)\s*/g)) {
    if (covered[m.index!]) continue;
    const brace = code.indexOf('{', m.index! + m[0].length - 1);
    if (brace < 0) continue;
    try {
      cover(m.index!, scanBalanced(code, brace));
    } catch {
      /* unbalanced: leave uncovered → reported/captured as foreign */
    }
  }

  // 3. Recognized const declarations (name/RHS-shape based — see isRecognizedConst).
  for (const m of code.matchAll(/\bconst\b/g)) {
    const at = m.index!;
    if (covered[at]) continue; // inside an import / function body / earlier const's RHS
    const afterConst = skipWs(code, at + 'const'.length);
    let rhsStart: number;
    let recognized: boolean;
    if (code[afterConst] === '{') {
      // Destructure: `const { … } = <rhs>`
      let eq: number;
      try {
        eq = scanBalanced(code, afterConst); // index just past the `}` pattern
      } catch {
        continue;
      }
      const afterEq = skipWs(code, eq);
      if (code[afterEq] !== '=') continue; // not a `= …` declarator we understand → leave foreign
      rhsStart = skipWs(code, afterEq + 1);
      const rhs = code.slice(rhsStart);
      // `const { … } = __props` (the resolveProps binding) / `= Astro.props` / `= resolveProps(Astro,…)`
      // / `= await loadPageData(meta.data, Astro)` (the SSR-page data destructure).
      recognized =
        /^__props\b/.test(rhs) ||
        rhs.startsWith(ASTRO_PROPS) ||
        rhs.startsWith(RESOLVE_PROPS) ||
        rhs.startsWith(LOAD_PAGE_DATA);
    } else {
      // Named const: `const <ident> = <rhs>`
      const name = readIdent(code, afterConst);
      if (!name) continue;
      const afterName = skipWs(code, afterConst + name.length);
      if (code[afterName] !== '=') continue; // e.g. `const x: T = …` (typed) → leave foreign
      rhsStart = skipWs(code, afterName + 1);
      recognized = isRecognizedConst(name, code.slice(rhsStart).trimStart());
    }
    if (recognized) {
      try {
        // Include a leading `export ` if present — the parser reads the legacy `export const
        // meta = …` form too (`const meta = ` is a substring it anchors on), so it's in-dialect.
        const exp = code.slice(0, at).match(/export\s+$/);
        const coverStart = exp ? at - exp[0].length : at;
        cover(coverStart, scanExprToSemicolon(code, rhsStart) + 1); // include the `;`
      } catch {
        /* leave uncovered → foreign */
      }
    }
  }

  return { code, covered };
}

/**
 * Extract hand-authored (foreign) frontmatter from `raw` as a single verbatim block plus the
 * source spans it occupied. Returns `null` when the frontmatter is entirely in-dialect (no
 * passthrough needed). Throws-tolerant: an unterminated string/template returns the special
 * `{ unparseable: true }` sentinel so the caller can fall back to read-only.
 *
 * Strategy: cover the emit-regenerated spans (foreign imports left uncovered), then collect
 * the maximal uncovered, non-whitespace runs and join them with newlines. Re-emitting that
 * block and re-parsing yields the same block (the block is contiguous foreign code on the way
 * back in), so the round-trip is byte-stable and idempotent.
 */
export function extractFrontmatterPassthrough(
  raw: string,
): { block: string; spans: NodeSpan[] } | { unparseable: true } | null {
  if (!raw?.trim()) return null;

  let cover: CoverResult;
  try {
    cover = computeCover(raw, { coverAllImports: false });
  } catch {
    return { unparseable: true };
  }
  const { covered } = cover;
  const n = raw.length;

  // Maximal uncovered runs.
  const runs: NodeSpan[] = [];
  let s = -1;
  for (let k = 0; k < n; k++) {
    if (covered[k] === 0) {
      if (s < 0) s = k;
    } else if (s >= 0) {
      runs.push({ start: s, end: k });
      s = -1;
    }
  }
  if (s >= 0) runs.push({ start: s, end: n });

  // Trim each run to its non-whitespace extent; drop whitespace-only runs (blank lines
  // between recognized statements).
  const spans: NodeSpan[] = [];
  for (const r of runs) {
    let a = r.start;
    let b = r.end;
    while (a < b && /\s/.test(raw[a] ?? '')) a++;
    while (b > a && /\s/.test(raw[b - 1] ?? '')) b--;
    if (b > a) spans.push({ start: a, end: b });
  }
  if (!spans.length) return null;

  const block = spans.map((sp) => raw.slice(sp.start, sp.end)).join('\n');
  return { block, spans };
}
