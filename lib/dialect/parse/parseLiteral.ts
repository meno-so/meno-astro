/**
 * Recursive-descent parser for the JS-literal subset that `serialize.ts` emits —
 * its exact inverse. Grammar: object | array | string | number | boolean | null,
 * with identifier-or-quoted object keys and JSON string escaping. Total over that
 * grammar; throws on anything outside it (which, for in-dialect input, never occurs).
 *
 * This is the "tiny total evaluator" that reads back `style(…)`, `i18n(…)`,
 * `export const meta = …`, the `resolveProps(Astro, {…})` argument, etc. — no
 * `eval`, no JS engine.
 *
 * It additionally reverses the two *expression* forms `serializeExprLiteral` emits for
 * a `{{template}}` nested inside a structured prop value (e.g. `link={{ href: link.href }}`):
 * a bare identifier/member chain (`link.href` → `{{link.href}}`) and a backtick template
 * literal (`` `/p/${slug}` `` → `/p/{{slug}}`). Quoted strings / numbers / booleans are
 * unaffected, so existing literal input parses exactly as before.
 */

import { scanBalanced } from './scan';

export interface LiteralResult {
  value: unknown;
  /** Index just past the parsed value. */
  end: number;
}

const WS = new Set([' ', '\t', '\r', '\n']);
const IDENT_START = /[A-Za-z_$]/;
const IDENT_CHAR = /[A-Za-z0-9_$]/;

function skipWs(src: string, i: number): number {
  while (i < src.length && WS.has(src[i])) i++;
  return i;
}

function fail(src: string, i: number, msg: string): never {
  const around = src.slice(Math.max(0, i - 20), i + 20);
  throw new Error(`parseLiteral: ${msg} at index ${i} (…${around}…)`);
}

function parseString(src: string, i: number): LiteralResult {
  // src[i] === '"'. Scan to the matching unescaped quote, then JSON.parse the span.
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '"') {
      j++;
      break;
    }
    j++;
  }
  const raw = src.slice(i, j);
  return { value: JSON.parse(raw) as string, end: j };
}

function parseNumber(src: string, i: number): LiteralResult {
  let j = i;
  while (j < src.length && /[-+0-9.eE]/.test(src[j])) j++;
  const raw = src.slice(i, j);
  const n = Number(raw);
  if (Number.isNaN(n) && raw !== 'NaN') fail(src, i, `invalid number "${raw}"`);
  return { value: n, end: j };
}

function parseKey(src: string, i: number): LiteralResult {
  if (src[i] === '"') return parseString(src, i);
  if (!IDENT_START.test(src[i])) fail(src, i, 'expected object key');
  let j = i + 1;
  while (j < src.length && IDENT_CHAR.test(src[j])) j++;
  return { value: src.slice(i, j), end: j };
}

function parseObject(src: string, i: number): LiteralResult {
  const obj: Record<string, unknown> = {};
  let j = skipWs(src, i + 1);
  if (src[j] === '}') return { value: obj, end: j + 1 };
  for (;;) {
    j = skipWs(src, j);
    const key = parseKey(src, j);
    j = skipWs(src, key.end);
    if (src[j] !== ':') fail(src, j, 'expected ":"');
    j = skipWs(src, j + 1);
    const val = parseValueAt(src, j);
    obj[key.value as string] = val.value;
    j = skipWs(src, val.end);
    if (src[j] === ',') {
      j++;
      continue;
    }
    if (src[j] === '}') return { value: obj, end: j + 1 };
    fail(src, j, 'expected "," or "}"');
  }
}

function parseArray(src: string, i: number): LiteralResult {
  const arr: unknown[] = [];
  let j = skipWs(src, i + 1);
  if (src[j] === ']') return { value: arr, end: j + 1 };
  for (;;) {
    j = skipWs(src, j);
    const val = parseValueAt(src, j);
    arr.push(val.value);
    j = skipWs(src, val.end);
    if (src[j] === ',') {
      j++;
      continue;
    }
    if (src[j] === ']') return { value: arr, end: j + 1 };
    fail(src, j, 'expected "," or "]"');
  }
}

/**
 * The emit-side CMS-data binding wraps: `i18n(<bare member chain>)` → the inner chain
 * (`i18n(cms.title)` → `cms.title`), and `richText(<chain>)` → the chain
 * (`richText(cms.content)` → `cms.content`, the rich-text-field `set:html` wrap). Returns
 * null for anything else (an `i18n({…})` VALUE literal, a multi-arg call, arbitrary JS). The
 * argument shape disambiguates the two `i18n()` forms: object literal = i18n VALUE
 * (`i18n({ _i18n: true, … })`), bare chain = wrapped BINDING. Parse ALWAYS reverses a
 * bare-chain wrap to the `{{chain}}` template, regardless of root: the emitter is the sole
 * authority on where wraps (re)appear (cms / collection-item roots, rich-text fields), so an
 * authored wrap outside those scopes normalizes to the unwrapped binding on the next save
 * (documented; `i18n()`/`richText()` re-apply deterministically from the model on re-emit).
 */
export function reverseI18nWrap(expr: string): string | null {
  const m = expr.match(/^(?:i18n|richText)\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\)$/);
  return m ? m[1] : null;
}

/**
 * Reverse the dead-`cms` build guard the emitter adds for an out-of-scope `{{cms.*}}` binding
 * (a `{{cms.field}}` doc-binding on a non-CMS page, where `cms` is undeclared): the guard
 * `typeof cms === 'undefined' ? '' : cms.field` → the bare chain `cms.field` (→ `{{cms.field}}`).
 * Null for anything else. The `cms`-anchored chain pattern keeps it from matching authored JS.
 * See `guardUnscopedCms` in emitNode.
 */
export function reverseDeadCmsGuard(expr: string): string | null {
  const m = expr.trim().match(/^typeof cms === 'undefined' \? '' : (cms(?:\.[A-Za-z_$][\w$]*)*)$/);
  return m ? m[1] : null;
}

/** Reverse a backtick template-literal body to a `{{…}}` template string. Mirrors the
 *  emitter's `escapeBacktick` + `${expr}` interpolation (the inverse of `templateToExpr`),
 *  including the CMS-data wrap (`${i18n(cms.x)}` → `{{cms.x}}`). */
function reverseBacktickBody(content: string): string {
  let out = '';
  let i = 0;
  while (i < content.length) {
    const c = content[i];
    if (c === '\\') {
      const n = content[i + 1];
      out += n === '\\' ? '\\' : n === '`' ? '`' : n === '$' ? '$' : n;
      i += 2;
      continue;
    }
    if (c === '$' && content[i + 1] === '{') {
      const end = scanBalanced(content, i + 1); // index past the matching '}'
      const inner = content.slice(i + 2, end - 1).trim();
      out += '{{' + (reverseDeadCmsGuard(inner) ?? reverseI18nWrap(inner) ?? inner) + '}}';
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Parse a backtick template literal (`src[i] === '\`'`) → reversed `{{…}}` template string. */
function parseBacktick(src: string, i: number): LiteralResult {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '`') {
      j++;
      break;
    }
    if (c === '$' && src[j + 1] === '{') {
      j = scanBalanced(src, j + 1);
      continue;
    }
    j++;
  }
  return { value: reverseBacktickBody(src.slice(i + 1, j - 1)), end: j };
}

/**
 * Parse a bare expression (identifier/member chain, possibly with calls/indexing) up to
 * the first top-level `,`/`}`/`]`, and reverse it to a `{{…}}` template. Only reached for
 * the expression form `serializeExprLiteral` emits inside a structured prop value.
 */
function parseExprToken(src: string, i: number): LiteralResult {
  let j = i;
  let depth = 0;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      j++;
      while (j < src.length && src[j] !== q) {
        if (src[j] === '\\') j++;
        j++;
      }
      j++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
      j++;
      continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) break;
      depth--;
      j++;
      continue;
    }
    if (depth === 0 && c === ',') break;
    j++;
  }
  const raw = src.slice(i, j).trim();
  // The CMS-data wrap inside a structured value (`{ href: i18n(cms.url) }`) reverses to
  // the bare-chain template, like every other expression position.
  return { value: `{{${reverseI18nWrap(raw) ?? raw}}}`, end: j };
}

/** Parse a single literal value starting at `i` (after leading whitespace). */
export function parseValueAt(src: string, i: number): LiteralResult {
  i = skipWs(src, i);
  const c = src[i];
  if (c === '{') return parseObject(src, i);
  if (c === '[') return parseArray(src, i);
  if (c === '"') return parseString(src, i);
  if (c === '`') return parseBacktick(src, i);
  // Keyword literals — guarded so an identifier that merely *starts* with the keyword
  // (`trueValue`, `nullable`) falls through to the bare-expression branch instead.
  if (src.startsWith('true', i) && !IDENT_CHAR.test(src[i + 4] ?? '')) return { value: true, end: i + 4 };
  if (src.startsWith('false', i) && !IDENT_CHAR.test(src[i + 5] ?? '')) return { value: false, end: i + 5 };
  if (src.startsWith('null', i) && !IDENT_CHAR.test(src[i + 4] ?? '')) return { value: null, end: i + 4 };
  if (c === '-' || c === '+' || (c >= '0' && c <= '9')) return parseNumber(src, i);
  if (c !== undefined && IDENT_START.test(c)) return parseExprToken(src, i); // bare expr → {{…}}
  return fail(src, i, `unexpected character "${c ?? '<eof>'}"`);
}

/** Parse a whole literal string (the entire trimmed input must be one literal). */
export function parseLiteral(src: string): unknown {
  const { value, end } = parseValueAt(src, 0);
  const rest = skipWs(src, end);
  if (rest !== src.length) fail(src, rest, 'trailing content after literal');
  return value;
}
