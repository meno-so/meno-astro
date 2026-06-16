/**
 * Value reversers — the inverse of the emitter's value/attribute encoders. Turn a
 * JSX attribute/expression string back into the Meno model value it came from.
 */

import { isSupportedTemplateExpression } from 'meno-core/shared';
import { parseLiteral, reverseDeadCmsGuard, reverseI18nWrap } from './parseLiteral';
import { scanBalanced, splitTopLevel } from './scan';
import { callArgsOf } from './callArgs';
import { addMenoSpanMarker } from '../richtext';
import type { ParseContext } from './parseContext';

/** A preserved arbitrary-JS expression the Meno model can't represent as a binding. */
export interface CodeMarker {
  _code: true;
  expr: string;
}

/** Tag an arbitrary JS expression as a verbatim-code marker. */
export function codeMarker(expr: string): CodeMarker {
  return { _code: true, expr };
}

/** Reverse `escapeBacktick` + `${expr}` interpolation: backtick content → Meno string.
 *  An interpolated CMS-data wrap (`${i18n(cms.x)}`) reverses to the bare-chain template
 *  (`{{cms.x}}`) — the emit side re-adds the wrap per scope (see emitNode's maybeWrapI18n). */
export function reverseTemplate(content: string): string {
  let out = '';
  let i = 0;
  while (i < content.length) {
    const c = content[i];
    if (c === '\\') {
      const n = content[i + 1];
      // escapeBacktick produced \\, \` and \${ — undo each (\$ leaves the following { literal).
      out += n === '\\' ? '\\' : n === '`' ? '`' : n === '$' ? '$' : n;
      i += 2;
      continue;
    }
    if (c === '$' && content[i + 1] === '{') {
      const end = scanBalanced(content, i + 1);
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

/**
 * Interpret a JSX expression-attribute value (the inner of `name={ … }`) back into a
 * Meno model value.
 */
export function interpretExprValue(expr: string, ctx: ParseContext): unknown {
  const e = expr.trim();

  if (ctx.embedConsts.has(e)) return ctx.embedConsts.get(e);
  // A hoisted `__codeN` reference → the verbatim JS expression it stands for.
  if (ctx.codeConsts.has(e)) return codeMarker(ctx.codeConsts.get(e)!);
  // The CMS-data wrap: `i18n(<bare member chain>)` → the `{{chain}}` binding (the emit
  // side wraps cms/collection-item roots so raw entry data resolves per locale).
  {
    const chain = reverseI18nWrap(e);
    if (chain) return `{{${chain}}}`;
  }
  // The dead-`cms` build guard (`typeof cms === 'undefined' ? '' : cms.field`) the emitter adds
  // for an out-of-scope `{{cms.*}}` binding on a non-CMS page → the bare-chain template. Reversed
  // before the generic `isSupportedTemplateExpression` path so the ternary isn't kept verbatim.
  {
    const chain = reverseDeadCmsGuard(e);
    if (chain) return `{{${chain}}}`;
  }
  // Only when the call spans the WHOLE expression — `i18n(cms.x) || undefined` (the
  // guarded whole-template attribute form) must fall through to the guard reversal below.
  if (e.startsWith('i18n(') && scanBalanced(e, 4) === e.length) {
    const arg = callArgsOf(e);
    // `i18n({ _i18n: true, … })` — an i18n VALUE literal carried through the resolver.
    if (arg.trimStart().startsWith('{')) return parseLiteral(arg);
    // A plain LITERAL arg (`i18n("Hello")`, `i18n(42)`, `i18n(["a"])`) — hand-authored;
    // i18n() is identity for non-i18n values, so the literal IS the model value and
    // stays editable (the next save normalizes the redundant wrap away). Gated on a
    // literal-leading first character: parseLiteral converts EXPRESSIONS to `{{…}}`
    // templates rather than throwing, so an unguarded parse would turn authored JS
    // like `i18n(fn(x))` into a garbage binding instead of preserving it verbatim.
    const t = arg.trim();
    if (/^["'[\d-]/.test(t) || t === 'true' || t === 'false') {
      try {
        return parseLiteral(arg);
      } catch {
        /* malformed literal — fall through to verbatim */
      }
    }
    // Any other i18n(…) (an expression argument, multi-arg override, …) is authored JS
    // the model can't represent as a binding — preserve it verbatim.
    return codeMarker(e);
  }
  // href()/embedHtml() may carry a threaded `__props` arg after the literal mapping (the
  // emitter passes the host component's props). Take only the first top-level arg.
  if (e.startsWith('href(')) return parseLiteral(splitTopLevel(callArgsOf(e), ',')[0]);
  if (e.startsWith('embedHtml(')) return parseLiteral(splitTopLevel(callArgsOf(e), ',')[0]);
  // The CMS rich-text render wrap (`richTextWithComponents(cms.content, cmsComponents)`)
  // → the field binding `{{cms.content}}`; the trailing registry arg is emit-only plumbing
  // (re-derived from ctx.needsCmsComponents on emit). The single-arg `richText(<chain>)`
  // predecessor still reverses via reverseI18nWrap above, so older files keep parsing.
  if (e.startsWith('richTextWithComponents(')) return parseLiteral(splitTopLevel(callArgsOf(e), ',')[0]);
  // Backtick literal → Meno string. Re-add the editor-only `data-meno-span` that emit strips
  // from custom spans (no-op for non-rich-text backticks like `/p/${slug}`), so rich-text
  // values round-trip to canonical meno-core HTML. See `../richtext`.
  if (e[0] === '`') return addMenoSpanMarker(reverseTemplate(e.slice(1, -1)));
  if (e[0] === '{' || e[0] === '[') return parseLiteral(e);
  if (e[0] === '"') return parseLiteral(e);
  if (e === 'true') return true;
  if (e === 'false') return false;
  if (e === 'null') return null;
  if (/^[-+]?(\d|\.\d)/.test(e) && !Number.isNaN(Number(e))) return Number(e);
  // Reverse the empty-template node-attribute guard `EXPR || undefined` (emitAttr adds it for
  // HTML attributes meno-core drops when they resolve to "") back to `{{EXPR}}`. Only when the
  // inner part is itself a modelable binding — bare or i18n()-wrapped (a whole-template CMS
  // attribute emits `i18n(cms.x) || undefined`) — so arbitrary `x || undefined` isn't mis-read.
  const guard = e.match(/^(.+?)\s*\|\|\s*undefined$/);
  if (guard) {
    const inner = guard[1].trim();
    const chain = reverseI18nWrap(inner);
    if (chain) return `{{${chain}}}`;
    if (isSupportedTemplateExpression(inner)) return `{{${inner}}}`;
  }
  // A binding the template engine can evaluate (identifier / member / operators /
  // ternary) → a Meno `{{template}}`. Anything else (function/method calls, arbitrary
  // JS) can't be modeled as a binding — preserve it verbatim so it is never lost and
  // still renders natively at build (see `isSupportedTemplateExpression`).
  if (isSupportedTemplateExpression(e)) return `{{${e}}}`;
  return codeMarker(e);
}

/** Reverse a `class={style(LIT[, META])}` attribute into { style, …meta fields }. */
export function interpretStyleCall(expr: string): {
  style?: unknown;
  interactiveStyles?: unknown;
  label?: unknown;
  generateElementClass?: unknown;
} {
  const args = callArgsOf(expr); // inside style( … )
  const parts = splitTopLevel(args, ',').filter((p) => p.length > 0);
  const out: Record<string, unknown> = {};
  if (parts[0]) out.style = parseLiteral(parts[0]);
  // Meta is the object-literal argument after the style object. Handles both the legacy
  // `style(obj, meta)` form and the current `style(obj, props, meta)` form — the `props`
  // argument is a bare identifier (`__props`/`undefined`) and is skipped.
  const metaPart = parts.slice(1).find((p) => p.trimStart().startsWith('{'));
  if (metaPart) {
    const meta = parseLiteral(metaPart) as Record<string, unknown>;
    if (meta.interactive !== undefined) out.interactiveStyles = meta.interactive;
    if (meta.label !== undefined) out.label = meta.label;
    if (meta.genClass !== undefined) out.generateElementClass = meta.genClass;
    // `instance` / `kind` are emit-only markers — intentionally dropped.
  }
  return out;
}

/** Reverse an `if` condition expression back into a Meno `if` value. */
export function reverseCondition(cond: string): boolean | string | unknown {
  const c = cond.trim();
  if (c === 'false') return false;
  if (c === 'true') return true;
  // `when(mapping[, __props])` — strip the threaded props arg, take the literal mapping.
  if (c.startsWith('when(')) return parseLiteral(splitTopLevel(callArgsOf(c), ',')[0]);
  // A quoted string literal (emit of a plain-string `if`) → the string itself, not a
  // `{{…}}` binding (jsep would otherwise accept it as a Literal). Trailing content
  // (e.g. `"a" || x`) makes parseLiteral throw → fall through to the JS paths.
  if (c.startsWith('"')) {
    try {
      return parseLiteral(c) as string;
    } catch {
      /* not a bare string literal */
    }
  }
  // A condition the template engine can evaluate → a `{{template}}`; arbitrary JS is
  // preserved verbatim (symmetric with interpretExprValue). The emitter parenthesizes a
  // compound condition for `&&` precedence (`(a || b) && (…)`); strip a fully-enclosing
  // pair first so `(a || b)` reverses to the original `{{a || b}}`, not `{{(a || b)}}`.
  const bare = stripEnclosingParens(c);
  if (isSupportedTemplateExpression(bare)) return `{{${bare}}}`;
  if (isSupportedTemplateExpression(c)) return `{{${c}}}`;
  return codeMarker(c);
}

/** Strip fully-enclosing `( … )` pairs (the emitter's `&&`-precedence guard); leaves
 *  `(a)(b)` / `(a) || (b)` (where the first `(` doesn't match the last `)`) untouched. */
function stripEnclosingParens(s: string): string {
  let c = s.trim();
  while (c.length >= 2 && c[0] === '(' && c[c.length - 1] === ')') {
    let depth = 0;
    let encloses = true;
    for (let i = 0; i < c.length; i++) {
      const ch = c[i];
      if (ch === '"' || ch === "'" || ch === '`') {
        i++;
        while (i < c.length && c[i] !== ch) {
          if (c[i] === '\\') i++;
          i++;
        }
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0 && i < c.length - 1) {
          encloses = false;
          break;
        }
      }
    }
    if (!encloses || depth !== 0) break;
    c = c.slice(1, -1).trim();
  }
  return c;
}
