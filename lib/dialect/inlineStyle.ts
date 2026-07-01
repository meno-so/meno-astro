/**
 * Absorb a foreign inline `style=` attribute into the Meno `node.style` model, so a
 * hand-authored element's styling becomes first-class editable (one style system, not two).
 *
 *  - A STATIC `style="display:flex;gap:12px"` → `{ display: "flex", gap: "12px" }`.
 *  - A MIXED `style="color: {{c}}"` → `{ color: "{{c}}" }` (template values pass through).
 *  - A DYNAMIC ternary `style={cond ? 'text-decoration:line-through;color:#9ca3af' : undefined}`
 *    (parsed to the whole-template binding `{{cond ? '…' : undefined}}`) → per-property
 *    TEMPLATE values: `{ textDecoration: "{{cond ? 'line-through' : 'unset'}}", color: "{{cond ?
 *    '#9ca3af' : <base|unset>}}" }`. The `: undefined` (no-override) branch becomes the element's
 *    existing static value for that property, or `unset` (the universal "no override" reset).
 *
 * Returns `null` when the inline style can't be modeled as style declarations (e.g. a dynamic
 * `style={someVar}` that isn't a CSS-literal ternary) — the caller leaves it as a verbatim
 * `attributes.style` binding. Used by normalizeNode, so it runs on every parsed model.
 */

import { scanString, scanTemplate } from './parse/scan';

/** kebab-case CSS property → camelCase model key (inverse of emit's cssPropName). CSS custom
 *  properties (`--x`) are case-sensitive and kept verbatim. */
function cssKeyToModel(prop: string): string {
  if (prop.startsWith('--')) return prop;
  return prop.toLowerCase().replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Parse an inline `style` declaration string into `{ camelProp: value }`. Values may carry
 *  `{{templates}}`. Returns null when nothing parses. NOTE: naive `;`/`:` split — a value with a
 *  literal `;` (e.g. a `url(data:…;base64,…)`) isn't supported (rare in hand-authored inline). */
function parseCssDecls(css: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':');
    if (i === -1) continue;
    const prop = decl.slice(0, i).trim();
    const value = decl.slice(i + 1).trim();
    if (!prop || !value) continue;
    out[cssKeyToModel(prop)] = value;
  }
  return Object.keys(out).length ? out : null;
}

/** If `e` is exactly one quoted string literal (`'x'` / `"x"`), return its content; else null. */
function stringLiteralValue(e: string): string | null {
  const c = e[0];
  if ((c === "'" || c === '"') && scanString(e, 0) === e.length) return e.slice(1, -1);
  return null;
}

/** A ternary branch → its CSS declarations: `{}` for undefined/null/empty-string, the parsed
 *  decls for a CSS string literal, or null when the branch isn't a literal (→ not convertible). */
function branchDecls(expr: string): Record<string, string> | null {
  const e = expr.trim();
  if (e === 'undefined' || e === 'null' || e === "''" || e === '""') return {};
  const lit = stringLiteralValue(e);
  if (lit === null) return null;
  return parseCssDecls(lit) ?? {};
}

/** Split `COND ? CONSEQUENT : ALTERNATE` at the top level (respecting strings, brackets, nested
 *  ternaries, `?.` optional chaining and `??`). Returns null when it isn't a ternary. */
function splitTernary(s: string): { cond: string; consequent: string; alternate: string } | null {
  let depth = 0;
  let qi = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? '';
    if (c === '"' || c === "'") {
      i = scanString(s, i) - 1;
      continue;
    }
    if (c === '`') {
      i = scanTemplate(s, i) - 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && c === '?') {
      if (s[i + 1] === '.') continue; // optional chaining `?.`
      if (s[i + 1] === '?') {
        i++; // nullish `??`
        continue;
      }
      qi = i;
      break;
    }
  }
  if (qi === -1) return null;
  // Find the `:` matching this `?`, accounting for nested ternaries.
  let tern = 0;
  let depth2 = 0;
  for (let i = qi + 1; i < s.length; i++) {
    const c = s[i] ?? '';
    if (c === '"' || c === "'") {
      i = scanString(s, i) - 1;
      continue;
    }
    if (c === '`') {
      i = scanTemplate(s, i) - 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth2++;
    else if (c === ')' || c === ']' || c === '}') depth2--;
    else if (depth2 === 0 && c === '?') {
      if (s[i + 1] === '.') continue;
      if (s[i + 1] === '?') {
        i++;
        continue;
      }
      tern++;
    } else if (depth2 === 0 && c === ':') {
      if (tern === 0) {
        return {
          cond: s.slice(0, qi).trim(),
          consequent: s.slice(qi + 1, i).trim(),
          alternate: s.slice(i + 1).trim(),
        };
      }
      tern--;
    }
  }
  return null;
}

/** Quote a CSS value as a single-quoted JS string literal; null if it contains a quote that
 *  would break the generated expression (rare in CSS — keep it verbatim instead). */
function cssValLiteral(v: string): string | null {
  return v.includes("'") || v.includes('`') ? null : `'${v}'`;
}

/**
 * A whole-template style binding `{{ COND ? '<decls>' : '<decls>'|undefined }}` → per-property
 * templated style values. `existingBase` supplies the false-branch default for a property the
 * branch omits (the element's own static value, else `unset`). Returns null when the binding
 * isn't a ternary whose branches are CSS-string literals (those stay a verbatim binding).
 */
function ternaryStyleToTemplates(inner: string, existingBase: Record<string, unknown>): Record<string, string> | null {
  const t = splitTernary(inner);
  if (!t) return null;
  const cons = branchDecls(t.consequent);
  const alt = branchDecls(t.alternate);
  if (cons === null || alt === null) return null;
  const keys = new Set([...Object.keys(cons), ...Object.keys(alt)]);
  if (keys.size === 0) return null;

  /** Default value for a property the branch omits: the element's own static base value
   *  (a plain non-template string), else the universal `unset` reset. */
  const fallback = (k: string): string => {
    const base = existingBase[k];
    return typeof base === 'string' && !base.includes('{{') ? base : 'unset';
  };

  const out: Record<string, string> = {};
  for (const k of keys) {
    const cv = cssValLiteral(k in cons ? (cons[k] as string) : fallback(k));
    const av = cssValLiteral(k in alt ? (alt[k] as string) : fallback(k));
    if (cv === null || av === null) return null; // unquotable value → leave the whole thing verbatim
    out[k] = `{{${t.cond} ? ${cv} : ${av}}}`;
  }
  return out;
}

/**
 * Convert a foreign inline `style` attribute value into Meno style declarations, or null when it
 * can't be modeled (caller keeps it as a verbatim `attributes.style` binding). `existingBase` is
 * the node's current static `style.base` (for dynamic-ternary false-branch defaults).
 */
export function inlineStyleToStyleDecls(
  raw: string,
  existingBase: Record<string, unknown>,
): Record<string, string> | null {
  const whole = raw.trim().match(/^\{\{([\s\S]+)\}\}$/);
  if (whole) return ternaryStyleToTemplates((whole[1] ?? '').trim(), existingBase);
  return parseCssDecls(raw);
}
