/**
 * Low-level scanners for the parser: skip strings / template literals and find
 * matching delimiters, so higher layers can treat `{ … }`, `( … )`, `[ … ]` as
 * opaque balanced spans without tripping over braces inside strings or `${…}`.
 */

const CLOSERS: Record<string, string> = { '{': '}', '(': ')', '[': ']' };

/** From a quote at `i`, return the index just past the matching closing quote. */
export function scanString(src: string, i: number): number {
  const q = src[i];
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') {
      j += 2;
      continue;
    }
    if (src[j] === q) return j + 1;
    j++;
  }
  throw new Error(`scanString: unterminated string from ${i}`);
}

/** From a backtick at `i`, return the index just past the matching backtick (handles `${…}`). */
export function scanTemplate(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length) {
    if (src[j] === '\\') {
      j += 2;
      continue;
    }
    if (src[j] === '`') return j + 1;
    if (src[j] === '$' && src[j + 1] === '{') {
      j = scanBalanced(src, j + 1);
      continue;
    }
    j++;
  }
  throw new Error(`scanTemplate: unterminated template from ${i}`);
}

/** From an opening delimiter at `i` ({ ( [), return the index just past its match. */
export function scanBalanced(src: string, i: number): number {
  const open = src[i];
  if (open === undefined || !CLOSERS[open]) throw new Error(`scanBalanced: no open delimiter at ${i} ("${src[i]}")`);
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'") {
      j = scanString(src, j);
      continue;
    }
    if (c === '`') {
      j = scanTemplate(src, j);
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      depth++;
      j++;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      depth--;
      j++;
      if (depth === 0) return j;
      continue;
    }
    j++;
  }
  throw new Error(`scanBalanced: unbalanced from ${i}`);
}

// ---------------------------------------------------------------------------
// JSX-aware scanning (BODY expressions only — never frontmatter)
// ---------------------------------------------------------------------------

/**
 * True when the `<` at `src[i]` opens a JSX element rather than being a JS less-than /
 * shift / arrow operator. The emitter pretty-prints binary operators with surrounding
 * spaces (`a < b`, `a <= b`), so a `<` is JSX only when IMMEDIATELY followed by a tag-name
 * letter or a fragment `>` (`<div`, `<Fragment`, `<>`). A `<` followed by a space, `=`,
 * `<`, a digit, etc. is an operator. (Close tags `</…>` only occur inside JSX child text,
 * which {@link scanJsxElement} handles internally — they are never a JS-context element start.)
 */
export function isJsxStart(src: string, i: number): boolean {
  if (src[i] !== '<') return false;
  return /[A-Za-z>]/.test(src[i + 1] ?? '');
}

/**
 * From the `<` of a JSX element at `src[i]`, return the index just past the whole element
 * (past its `/>` self-close or its matching `</…>`). The crucial difference from a pure-JS
 * scan: inside JSX CHILD TEXT, `'` / `"` / backtick are LITERAL characters, not string
 * delimiters — so an apostrophe in `<p>We'll…</p>` no longer trips scanString.
 *
 * Two sub-contexts, mirroring how the markup parser itself reads an element:
 *  - the OPENING TAG (`<tag … >` / `<tag … />`): attribute strings are real JS strings and
 *    attribute `{…}` values are JS expressions (which may themselves embed JSX) — so quotes
 *    and braces here ARE scanned as JS (via scanString / scanBalancedJsx);
 *  - the CHILD CONTENT (after `>`, until the matching `</…>`): free text where quotes are
 *    opaque, `{…}` opens a nested JS expression, and `<child …>` recurses.
 *
 * Self-close and `</…>` return to the parent context. Element nesting is handled by recursion,
 * so the first `</…>` seen in a given element's child scan is that element's own close tag —
 * the same structural assumption the markup parser (parseElement/parseNodes) already makes
 * (every non-self-closed element has a matching close tag; void tags are emitted self-closed).
 */
export function scanJsxElement(src: string, i: number): number {
  let j = i + 1;
  // --- Opening tag: scan to `>` (open) or `/>` (self-close). ---
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'") {
      j = scanString(src, j); // attribute string literal (JS)
      continue;
    }
    if (c === '`') {
      j = scanTemplate(src, j);
      continue;
    }
    if (c === '{') {
      j = scanBalancedJsx(src, j); // attribute expression value (may itself embed JSX)
      continue;
    }
    if (c === '/' && src[j + 1] === '>') return j + 2; // self-close → done
    if (c === '>') {
      j++; // open tag complete → fall through to child content
      break;
    }
    j++;
  }
  // --- Child content: text (quotes opaque) until the matching `</…>`. ---
  while (j < src.length) {
    const c = src[j];
    if (c === '<') {
      if (src[j + 1] === '/') {
        const gt = src.indexOf('>', j); // close tag `</tag>` — no `>` inside a close tag
        return gt === -1 ? src.length : gt + 1;
      }
      if (/[A-Za-z>]/.test(src[j + 1] ?? '')) {
        j = scanJsxElement(src, j); // nested child element / fragment
        continue;
      }
      j++; // a stray `<` in text (invalid JSX, but be lenient) — treat literally
      continue;
    }
    if (c === '{') {
      j = scanBalancedJsx(src, j); // JS expression child
      continue;
    }
    j++; // text char — `'` / `"` / `` ` `` are LITERAL here (the whole point)
  }
  return src.length;
}

/**
 * JSX-aware twin of {@link scanBalanced}: from an opening delimiter at `i` (`{ ( [`), return
 * the index just past its match, but treat a `<jsx>` element encountered in JS-expression
 * position as opaque (its child text's quotes are literal, via {@link scanJsxElement}). Used
 * for BODY `{…}` children whose expression wraps JSX — `{cond && ( <p>We'll…</p> )}` and
 * `{list.map((x) => ( <li>don't…</li> ))}` — where plain scanBalanced would mis-read an
 * apostrophe in the JSX text as the start of a JS string and throw "unterminated string".
 * Frontmatter (pure JS) keeps using the plain {@link scanBalanced}.
 */
export function scanBalancedJsx(src: string, i: number): number {
  const open = src[i];
  if (open === undefined || !CLOSERS[open]) throw new Error(`scanBalancedJsx: no open delimiter at ${i} ("${src[i]}")`);
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'") {
      j = scanString(src, j);
      continue;
    }
    if (c === '`') {
      j = scanTemplate(src, j);
      continue;
    }
    if (c === '<' && isJsxStart(src, j)) {
      j = scanJsxElement(src, j);
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      depth++;
      j++;
      continue;
    }
    if (c === '}' || c === ')' || c === ']') {
      depth--;
      j++;
      if (depth === 0) return j;
      continue;
    }
    j++;
  }
  throw new Error(`scanBalancedJsx: unbalanced from ${i}`);
}

/**
 * Find the first top-level `openChar … close` group whose close is the very end of
 * `expr` (e.g. the `( … )` of `cond && ( … )` or `head.map(…)`). Returns the inner
 * content, or null. Skips strings/templates/nested groups.
 *
 * BODY-ONLY and JSX-aware: this is only ever called on body expressions (parseBody —
 * `interpretChildExpr` and `parseMapExpr`), never frontmatter, so it skips `<jsx>` elements
 * (and dives into groups with scanBalancedJsx) to keep literal quotes in JSX child text from
 * being mis-scanned as JS strings. The un-parenthesized `{cond && <p>don't…</p>}` shape thus
 * scans cleanly to "no trailing group" (→ null) instead of throwing, leaving the markup parser
 * to handle it (inlineCondElement).
 */
export function findTrailingGroup(
  expr: string,
  openChar: '(' | '{' | '[' = '(',
): { open: number; inner: string } | null {
  let j = 0;
  while (j < expr.length) {
    const c = expr[j];
    if (c === '"' || c === "'") {
      j = scanString(expr, j);
      continue;
    }
    if (c === '`') {
      j = scanTemplate(expr, j);
      continue;
    }
    if (c === '<' && isJsxStart(expr, j)) {
      j = scanJsxElement(expr, j);
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      const end = scanBalancedJsx(expr, j);
      if (c === openChar && end === expr.length) {
        return { open: j, inner: expr.slice(j + 1, end - 1) };
      }
      j = end;
      continue;
    }
    j++;
  }
  return null;
}

/**
 * Scan a statement's RHS expression from `i` to its terminating top-level `;`, skipping over
 * strings, template literals, and balanced bracket groups. Returns the index of that `;` (or
 * end-of-string if none). Used for hoisted-const RHS and the foreign-frontmatter detector.
 */
export function scanExprToSemicolon(code: string, i: number): number {
  let j = i;
  while (j < code.length) {
    const c = code[j];
    if (c === '"' || c === "'") {
      j = scanString(code, j);
      continue;
    }
    if (c === '`') {
      j = scanTemplate(code, j);
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      j = scanBalanced(code, j);
      continue;
    }
    if (c === ';') return j;
    j++;
  }
  return code.length;
}

/** Split `src` on a single-character separator at top level (ignores strings/groups). */
export function splitTopLevel(src: string, sep: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let j = 0;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'") {
      j = scanString(src, j);
      continue;
    }
    if (c === '`') {
      j = scanTemplate(src, j);
      continue;
    }
    if (c === '{' || c === '(' || c === '[') {
      j = scanBalanced(src, j);
      continue;
    }
    if (c === sep) {
      parts.push(src.slice(start, j));
      start = j + 1;
      j++;
      continue;
    }
    j++;
  }
  parts.push(src.slice(start));
  return parts.map((s) => s.trim());
}
