/**
 * CSS declaration-value sanitizer, shared by the dialect's `normalizeModel` (cleans
 * style values at convert/save time) and the runtime `style()` resolver (cleans at
 * class-name computation, so hashes match the build-time sheet even for stale files).
 *
 * Why: imported style data can carry junk pasted after a real value (e.g.
 * `box-shadow: 0 0 56px 0 rgba(…); Assets Videos …`). In a browser <style> tag the
 * junk is dropped by CSS error recovery and the real value applies — but the
 * meno-astro utility sheet goes through PostCSS, which hard-fails the ENTIRE file
 * (`CssSyntaxError: Unknown word`), taking every page down. Sanitizing at generation
 * time reproduces the browser's effective behavior.
 */

/**
 * Truncate a CSS declaration value at the first top-level `;`, `{`, `}` or unmatched
 * `)` — characters that would terminate the declaration or corrupt the rule when the
 * value is emitted into a stylesheet. Mirrors browser error recovery: in
 * `box-shadow: X; <junk>` the browser applies X and drops the junk as a separate
 * invalid declaration; we keep the same X prefix.
 *
 * Quote- and paren-aware: `;` `{` `}` inside strings or `url(data:image/png;base64,…)`
 * are part of the value and kept. A value that ends with an unclosed quote or paren
 * (e.g. `url(foo`) returns `''` — emitted as-is it would swallow the rest of the sheet,
 * so callers drop the declaration. Identity for well-formed values, so existing
 * utility-class hashes are unchanged.
 */
export function sanitizeCssValue(value: string): string {
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{' && value[i + 1] === '{') {
      // A `{{template}}` binding is an opaque token (rendered via the inline style
      // attr, never into the sheet) — skip it; an unterminated one truncates here.
      const end = value.indexOf('}}', i + 2);
      if (end === -1) return value.slice(0, i).trimEnd();
      i = end + 1;
    } else if (c === '(') depth++;
    else if (c === ')') {
      if (depth === 0) return value.slice(0, i).trimEnd();
      depth--;
    } else if (depth === 0 && (c === ';' || c === '{' || c === '}')) {
      return value.slice(0, i).trimEnd();
    }
  }
  return quote !== null || depth > 0 ? '' : value;
}

/**
 * The CSS custom-property name that bridges a `{{template}}`-bound style declaration in a
 * NON-base breakpoint (`tablet`/`mobile`) to a real CSS rule.
 *
 * A prop-bound value can't be a static utility class (its value is unknown at build time) and an
 * inline `style` attribute can't carry a media query — so a templated `tablet`/`mobile` declaration
 * is bridged: the build-time utility scan (utilityCss.collectClasses) and the runtime `style()`
 * resolver both emit a breakpoint-scoped rule `…{ <prop>: var(--m-<bp>-<prop>) }`, and the element
 * sets that variable inline to its render-resolved value (emitNode.emitInlineStyleAttr). Because the
 * inline style sets the VARIABLE — not the property — the property itself is only ever assigned by
 * class rules, so a `:checked`/`:hover` interactive override still wins by normal specificity
 * instead of losing to an inline declaration (the bug this fixes: a CSS-checkbox mobile menu whose
 * closed state lived in `tablet:{opacity:"{{isOpen?1:0}}"}` was dropped, leaving it open by default).
 *
 * The three sites MUST agree byte-for-byte on this name, hence one shared helper. `base` is never
 * bridged — a base template renders directly inline (it needs no media query).
 */
export function templateVarName(breakpoint: string, cssProp: string): string {
  const kebab = cssProp.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  return `--m-${breakpoint}-${kebab}`;
}
