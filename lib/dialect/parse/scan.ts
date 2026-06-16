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
  if (!CLOSERS[src[i]]) throw new Error(`scanBalanced: no open delimiter at ${i} ("${src[i]}")`);
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

/**
 * Find the first top-level `openChar … close` group whose close is the very end of
 * `expr` (e.g. the `( … )` of `cond && ( … )` or `head.map(…)`). Returns the inner
 * content, or null. Skips strings/templates/nested groups.
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
    if (c === '{' || c === '(' || c === '[') {
      const end = scanBalanced(expr, j);
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
