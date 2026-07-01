/**
 * Frontmatter parser — extracts the named consts/exports the emitter wrote:
 * `export const meta`, the `resolveProps(Astro, {…})` prop literal, `const __meno`,
 * hoisted `__embedN` template consts, and `getCollectionList` bindings.
 */

import { parseValueAt, parseLiteral } from './parseLiteral';
import { scanBalanced, scanTemplate, scanExprToSemicolon, splitTopLevel } from './scan';
import { reverseTemplate } from './parseValue';
import { createParseContext, type ParseContext } from './parseContext';
import { restoreStyleValuesFromCode } from '../styleValues';

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

  // Re-register any hash-fallback utility values carried by the `const __styleValues` side-channel
  // into meno-core's style-value registry, so `classToStyle` (editor reverse reads) and the
  // build-time CSS scan recover values that can't live in a class name — without a warm forward
  // pass (a fresh process loading the `.astro` from disk). Emit-only; not kept on the model.
  restoreStyleValuesFromCode(code, literalAfter);

  // Local component imports: `import <Ident> from '<relative>.astro'` → tag identifier →
  // the component's true name (file basename). Tags are sanitized identifiers, not the
  // identity (see ParseContext.componentImports). Non-relative specifiers (runtime
  // components from 'meno-astro/components', npm packages) are skipped.
  for (const m of code.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\2/g)) {
    const path = m[3] ?? '';
    const tag = m[1] ?? '';
    if (!path.startsWith('./') && !path.startsWith('../')) continue;
    if (path.endsWith('.astro')) {
      // Custom-`.astro` import: an opaque hand-authored component under `src/custom/`, i.e. a
      // `.astro` specifier whose traversal lands directly in `custom/` (`(../)+custom/<src>`).
      // A Meno component always lives under `components/`, so its path carries `components/`
      // before any subfolder — never matching this — which keeps the two unambiguous even if a
      // component category is literally named "custom". Checked BEFORE the component rule below.
      const customMatch = /^(?:\.\.\/)+custom\/(.+\.astro)$/i.exec(path);
      if (customMatch) {
        ctx.customAstroImports.set(tag, customMatch[1] ?? '');
        continue;
      }
      ctx.componentImports.set(tag, path.slice(path.lastIndexOf('/') + 1, -'.astro'.length));
      continue;
    }
    // Island import: a relative framework-component file (.tsx/.jsx/.vue/.svelte) under an
    // `islands/` directory. The tag maps to `src` = the path relative to `src/islands/`, so a
    // nested `../islands/widgets/Chart.vue` keeps `widgets/Chart.vue`. The framework is
    // derived from the extension. See ParseContext.islandImports.
    const islandMatch = /(?:^|\/)islands\/(.+\.(?:tsx|jsx|vue|svelte))$/i.exec(path);
    if (islandMatch) ctx.islandImports.set(tag, islandMatch[1] ?? '');
  }

  // The `list` runtime helper may be imported aliased to dodge a prop-name collision
  // (`import { list as list$ } from 'meno-astro'`). Recover its local name so the body parser
  // recognizes `<local>(<src>).map(…)` as a prop list. Plain `list` → default (handled below).
  const menoImport = /import\s*\{([^}]*)\}\s*from\s+(['"])meno-astro\2/.exec(code);
  if (menoImport) {
    for (const spec of (menoImport[1] ?? '').split(',')) {
      const aliasMatch = /^\s*list\s+as\s+([A-Za-z_$][\w$]*)\s*$/.exec(spec);
      if (aliasMatch) ctx.listHelperLocal = aliasMatch[1];
    }
  }

  // Frontmatter backtick-template consts: `const <ident> = ` + backtick template.
  // The canonical emitted embed hoist is `__embedN`, but a HAND-AUTHORED file may name the
  // const anything (`const __iconChat = \`<svg>…\``). Capture EVERY such const into
  // `templateConsts` so the embed parser can resolve `html={ident}` for a custom name and
  // never lose the verbatim HTML (emit re-normalizes the name to `__embedN`). The `__embedN`
  // subset is also kept in `embedConsts` for the generic value path (interpretExprValue),
  // unchanged. Reserved `__codeN` (verbatim JS, handled below) and `Tag_N` (dynamic-tag
  // templates) consts are skipped — they are not embed HTML.
  for (const m of code.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*`/g)) {
    const name = m[1] ?? '';
    if (/^__code\d+$/.test(name) || /^Tag_\d+$/.test(name)) continue;
    const tickStart = m.index! + m[0].length - 1; // the backtick the pattern consumed
    const tickEnd = scanTemplate(code, tickStart);
    const value = reverseTemplate(code.slice(tickStart + 1, tickEnd - 1));
    ctx.templateConsts.set(name, value);
    if (/^__embed\d+$/.test(name)) ctx.embedConsts.set(name, value);
  }

  // Hoisted verbatim-code consts: `const __code0 = <raw expr>;` (multi-line foreign JS
  // lifted out of a `{…}` value/attribute so the placer never re-indents it).
  for (const m of code.matchAll(/const\s+(__code\d+)\s*=\s*/g)) {
    const start = m.index! + m[0].length;
    const end = scanExprToSemicolon(code, start);
    ctx.codeConsts.set(m[1] ?? '', code.slice(start, end).trim());
  }

  // Dynamic-tag consts: `const Tag_0 = ` + backtick template → Meno tag string.
  for (const m of code.matchAll(/const\s+(Tag_\d+)\s*=\s*/g)) {
    const tickStart = code.indexOf('`', m.index! + m[0].length);
    if (tickStart < 0) continue;
    const tickEnd = scanTemplate(code, tickStart);
    ctx.tagConsts.set(m[1] ?? '', reverseTemplate(code.slice(tickStart + 1, tickEnd - 1)));
  }

  // Collection-list bindings:
  //   const X = await getCollectionList("src"[, {query}], Astro, getCollection)
  // The optional `{query}` is the only object-literal arg; the trailing `Astro` and
  // `getCollection` identifiers are emit-only plumbing and ignored.
  for (const m of code.matchAll(/const\s+(\w+)\s*=\s*await\s+getCollectionList\(/g)) {
    const open = m.index! + m[0].length - 1; // the '(' of getCollectionList(
    const inner = code.slice(open + 1, scanBalanced(code, open) - 1);
    const args = splitTopLevel(inner, ',').filter(Boolean);
    const source = parseLiteral(args[0] ?? '') as string;
    const query = args[1]?.trim().startsWith('{') ? (parseLiteral(args[1]) as Record<string, unknown>) : undefined;
    ctx.collectionBindings.set(m[1] ?? '', { source, query });
  }

  // Remote-data bindings (sourceType: 'remote'):
  //   const X = await getRemoteData("https://…"[, {query}], Astro)
  // Same shape as getCollectionList — the URL is the first literal arg, the optional `{query}`
  // (path/filter/sort/limit/offset) the second; trailing `Astro` is emit-only plumbing.
  for (const m of code.matchAll(/const\s+(\w+)\s*=\s*await\s+getRemoteData\(/g)) {
    const open = m.index! + m[0].length - 1; // the '(' of getRemoteData(
    const inner = code.slice(open + 1, scanBalanced(code, open) - 1);
    const args = splitTopLevel(inner, ',').filter(Boolean);
    const url = parseLiteral(args[0] ?? '') as string;
    const query = args[1]?.trim().startsWith('{') ? (parseLiteral(args[1]) as Record<string, unknown>) : undefined;
    ctx.remoteBindings.set(m[1] ?? '', { url, query });
  }

  // Sanity-data bindings (sourceType: 'sanity'):
  //   const X = await getSanityData("post"[, {query}], Astro)
  // Same shape as getRemoteData — the document type is the first literal arg, the optional
  // `{query}` (filter/sort/limit/offset) the second; trailing `Astro` is emit-only plumbing.
  for (const m of code.matchAll(/const\s+(\w+)\s*=\s*await\s+getSanityData\(/g)) {
    const open = m.index! + m[0].length - 1; // the '(' of getSanityData(
    const inner = code.slice(open + 1, scanBalanced(code, open) - 1);
    const args = splitTopLevel(inner, ',').filter(Boolean);
    const documentType = parseLiteral(args[0] ?? '') as string;
    const query = args[1]?.trim().startsWith('{') ? (parseLiteral(args[1]) as Record<string, unknown>) : undefined;
    ctx.sanityBindings.set(m[1] ?? '', { documentType, query });
  }

  // The authoritative prop definition is the second argument of the single
  // `resolveProps(Astro, {…})` call. `literalAfter` scans the balanced `{…}`
  // literal that follows the anchor and stops at its matching brace, so the trailing
  // `)`/`;` are ignored. The (cosmetic) destructured names are never read.
  const propsInterface = literalAfter(code, 'resolveProps(Astro, ') as Record<string, unknown> | undefined;
  const componentMeta = readComponentMeta(code) ?? {};
  let meta = readPageMeta(code);
  const kind: Frontmatter['kind'] = code.includes('resolveProps(') ? 'component' : 'page';

  // Per-page static/SSR override: `export const prerender = true|false`. A CMS template route
  // emits `prerender = true` as boilerplate alongside `getStaticPaths` (emit-only — leave it
  // out of the model); an SSR page (`meta.source === 'ssr'`) emits `prerender = false` derived
  // from its type (also emit-only — see emitPage). A regular page's prerender reflects
  // `meta.prerender`, so fold it back in only for those.
  const metaSource = (meta as { source?: unknown } | undefined)?.source;
  if (kind === 'page' && !/\bfunction\s+getStaticPaths\b/.test(code) && metaSource !== 'ssr') {
    const pm = /(?:export\s+)?const\s+prerender\s*=\s*(true|false)\b/.exec(code);
    if (pm) meta = { ...((meta as Record<string, unknown> | undefined) ?? {}), prerender: pm[1] === 'true' };
  }

  return { kind, ctx, meta, propsInterface, componentMeta };
}
