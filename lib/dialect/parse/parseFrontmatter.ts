/**
 * Frontmatter parser — extracts the named consts/exports the emitter wrote:
 * `export const meta`, the `resolveProps(Astro, {…})` prop literal, `const __meno`,
 * hoisted `__embedN` template consts, and `getCollectionList` bindings.
 */

import { parseValueAt, parseLiteral } from './parseLiteral';
import { scanBalanced, scanString, scanTemplate, splitTopLevel } from './scan';
import { reverseTemplate } from './parseValue';
import { createParseContext, type ParseContext } from './parseContext';

/**
 * Scan a hoisted-const RHS (an arbitrary JS expression) from `i` to its terminating
 * top-level `;`, skipping over strings, template literals, and balanced bracket groups.
 * The hoisted value is always an expression (no statements), so the first `;` at depth 0
 * is the end. Returns the index of that `;` (or end-of-string if none).
 */
function scanExprToSemicolon(code: string, i: number): number {
  let j = i;
  while (j < code.length) {
    const c = code[j];
    if (c === '"' || c === "'") { j = scanString(code, j); continue; }
    if (c === '`') { j = scanTemplate(code, j); continue; }
    if (c === '(' || c === '[' || c === '{') { j = scanBalanced(code, j); continue; }
    if (c === ';') return j;
    j++;
  }
  return code.length;
}

export interface Frontmatter {
  kind: 'page' | 'component';
  ctx: ParseContext;
  meta?: unknown;
  propsInterface?: Record<string, unknown>;
  componentMeta: Record<string, unknown>;
}

/** Read the literal RHS that follows an anchor like `export const meta = `. */
function literalAfter(code: string, anchor: string): unknown | undefined {
  const idx = code.indexOf(anchor);
  if (idx < 0) return undefined;
  return parseValueAt(code, idx + anchor.length).value;
}

/**
 * The component-meta literal (`const __meno = {…}`) of an emitted component file, or
 * undefined when absent. Exposed for consumers that need this ONE component fact (e.g.
 * `loadLibraries`' render-time collection of component-tier libraries) without paying
 * for a full `parseFrontmatter` scan.
 */
export function readComponentMeta(code: string): Record<string, unknown> | undefined {
  return literalAfter(code, 'const __meno = ') as Record<string, unknown> | undefined;
}

/**
 * The page-meta literal (`const meta = {…}`) of an emitted page file, or undefined when
 * absent. The anchor is a substring of the legacy `export const meta = ` too, so both the
 * current (non-exported) form and older emitted pages are read. Exposed for consumers that
 * need this ONE page fact (e.g. `loadSlugMappings`' render-time collection of `meta.slugs`
 * for locale routing) without paying for a full `parseFrontmatter` scan.
 */
export function readPageMeta(code: string): Record<string, unknown> | undefined {
  return literalAfter(code, 'const meta = ') as Record<string, unknown> | undefined;
}

export function parseFrontmatter(code: string): Frontmatter {
  const ctx = createParseContext();

  // Local component imports: `import <Ident> from '<relative>.astro'` → tag identifier →
  // the component's true name (file basename). Tags are sanitized identifiers, not the
  // identity (see ParseContext.componentImports). Non-relative specifiers (runtime
  // components from 'meno-astro/components', npm packages) are skipped.
  for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\2/g)) {
    const path = m[3];
    if (!path.endsWith('.astro')) continue;
    if (!path.startsWith('./') && !path.startsWith('../')) continue;
    ctx.componentImports.set(m[1], path.slice(path.lastIndexOf('/') + 1, -'.astro'.length));
  }

  // Hoisted embed consts: `const __embed0 = ` + backtick template.
  for (const m of code.matchAll(/const\s+(__embed\d+)\s*=\s*/g)) {
    const tickStart = code.indexOf('`', m.index! + m[0].length);
    if (tickStart < 0) continue;
    const tickEnd = scanTemplate(code, tickStart);
    ctx.embedConsts.set(m[1], reverseTemplate(code.slice(tickStart + 1, tickEnd - 1)));
  }

  // Hoisted verbatim-code consts: `const __code0 = <raw expr>;` (multi-line foreign JS
  // lifted out of a `{…}` value/attribute so the placer never re-indents it).
  for (const m of code.matchAll(/const\s+(__code\d+)\s*=\s*/g)) {
    const start = m.index! + m[0].length;
    const end = scanExprToSemicolon(code, start);
    ctx.codeConsts.set(m[1], code.slice(start, end).trim());
  }

  // Dynamic-tag consts: `const Tag_0 = ` + backtick template → Meno tag string.
  for (const m of code.matchAll(/const\s+(Tag_\d+)\s*=\s*/g)) {
    const tickStart = code.indexOf('`', m.index! + m[0].length);
    if (tickStart < 0) continue;
    const tickEnd = scanTemplate(code, tickStart);
    ctx.tagConsts.set(m[1], reverseTemplate(code.slice(tickStart + 1, tickEnd - 1)));
  }

  // Collection-list bindings:
  //   const X = await getCollectionList("src"[, {query}], Astro, getCollection)
  // The optional `{query}` is the only object-literal arg; the trailing `Astro` and
  // `getCollection` identifiers are emit-only plumbing and ignored.
  for (const m of code.matchAll(/const\s+(\w+)\s*=\s*await\s+getCollectionList\(/g)) {
    const open = m.index! + m[0].length - 1; // the '(' of getCollectionList(
    const inner = code.slice(open + 1, scanBalanced(code, open) - 1);
    const args = splitTopLevel(inner, ',').filter(Boolean);
    const source = parseLiteral(args[0]) as string;
    const query = args[1]?.trim().startsWith('{')
      ? (parseLiteral(args[1]) as Record<string, unknown>)
      : undefined;
    ctx.collectionBindings.set(m[1], { source, query });
  }

  // The authoritative prop definition is the second argument of the single
  // `resolveProps(Astro, {…})` call. `literalAfter` scans the balanced `{…}`
  // literal that follows the anchor and stops at its matching brace, so the trailing
  // `)`/`;` are ignored. The (cosmetic) destructured names are never read.
  const propsInterface = literalAfter(code, 'resolveProps(Astro, ') as Record<string, unknown> | undefined;
  const componentMeta = readComponentMeta(code) ?? {};
  const meta = readPageMeta(code);
  const kind: Frontmatter['kind'] = code.includes('resolveProps(') ? 'component' : 'page';

  return { kind, ctx, meta, propsInterface, componentMeta };
}
