/**
 * Promote an opaque custom component (`src/custom/<X>.astro`, a `type:"custom"` black box) into
 * an editable Meno component (`src/components/<X>.astro`).
 *
 * This is the codec half of the escalation-ladder de-escalation "custom → Meno component" (Tier
 * A): a custom file whose MARKUP is dialect-expressible doesn't need to be a black box — only its
 * hand-authored data-fetch frontmatter does. We keep that frontmatter verbatim as a
 * `_frontmatter` passthrough and make the body a normal, visually-editable component structure.
 * The body's references to the fetched values (`value={next}`) resolve to the passthrough consts;
 * the component emitter no longer re-declares them from `Astro.props` (see
 * collectFrontmatterDeclaredNames).
 *
 * Pure source→source transform. The caller (a Studio action / convertProject) is responsible for
 * the file move (`src/custom/` → `src/components/`, same depth to `src/` so relative passthrough
 * imports stay valid) and for rewriting each referencing page's import specifier — after which
 * the page's `<X/>` reclassifies from a `custom` node to a component instance on the next parse.
 */

import { parse, emit } from './index';
import { createParseContext } from './parse/parseContext';
import { parseNodes } from './parse/parseBody';
import { blankNonCode } from './parse/frontmatterScan';

export interface PromoteResult {
  /** The promoted Meno-component `.astro` source — set only when `ok`. */
  ok: boolean;
  source?: string;
  /** Why promotion was refused (the body can't be modeled) — set only when `!ok`. */
  reason?: string;
}

/** Top-level body nodes that aren't pure whitespace text. */
function countTopLevelNodes(body: string): number {
  // A bare context is enough to COUNT siblings — tag→component/custom resolution (which needs the
  // file's imports) doesn't change how many top-level nodes the markup has.
  const ctx = createParseContext();
  const nodes = parseNodes(body, 0, ctx).nodes;
  return nodes.filter((n) => !(typeof n === 'string' && n.trim() === '')).length;
}

/** The frontmatter body (between the `---` fences) of a `.astro` source. */
function frontmatterOf(source: string): string {
  return source.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
}

/**
 * Soundness gate — structural problems that make the emitted `.astro` fail a real `astro build`.
 * Returns a list of human-readable problems (empty = clean). These are the build-breaker classes
 * found shipping real promotions; emit already avoids producing them, so a non-empty result means
 * a regression upstream — promoteCustomComponent refuses rather than hand back broken source. (The
 * exhaustive check is the real `astro build` e2e; this is the fast, deterministic, in-process net.)
 */
export function validatePromotedSource(source: string): string[] {
  const problems: string[] = [];
  let whole: string;
  let fm: string;
  try {
    whole = blankNonCode(source.replace(/\r\n/g, '\n')); // neutralize string/template/comment interiors
    fm = blankNonCode(frontmatterOf(source));
  } catch {
    return ['unterminated string or template literal'];
  }

  // 1. Duplicate top-level declaration — `const next` twice is a hard SyntaxError. Count named +
  //    object-destructure binding names declared at the TOP LEVEL (column 0) of the frontmatter.
  //    Anchoring at column 0 (not `^[ \t]*`) is what excludes an indented inner-scope `const x`
  //    inside a block/arrow body — that's a legal shadow, not a redeclaration.
  const counts = new Map<string, number>();
  const bump = (n: string | undefined): void => {
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1);
  };
  for (const mm of fm.matchAll(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:]/gm)) bump(mm[1]);
  for (const mm of fm.matchAll(/^(?:export\s+)?(?:const|let|var)\s+\{([^}]*)\}\s*=/gm)) {
    for (const part of mm[1]!.split(',')) {
      const t = part.trim();
      if (!t) continue;
      const name = t.includes(':')
        ? t.split(':')[1]!.trim()
        : t
            .replace(/^\.\.\./, '')
            .split('=')[0]!
            .trim();
      bump(name.match(/^[A-Za-z_$][\w$]*/)?.[0]);
    }
  }
  const dups = [...counts].filter(([, n]) => n > 1).map(([k]) => k);
  if (dups.length) problems.push(`duplicate top-level declaration: ${dups.join(', ')}`);

  // 2. Unparenthesized `??` mixed with `||`/`&&` is a hard SyntaxError (`a ?? b || c`). Scan the
  //    whole source (it can occur in an attribute value, not just the frontmatter). The character
  //    class stops at the nearest bracket so a properly parenthesized `(a ?? b) || c` is allowed.
  if (
    /\?\?[^(){}|&;]*\|\|/.test(whole) ||
    /\?\?[^(){}|&;]*&&/.test(whole) ||
    /\|\|[^(){}|&;]*\?\?/.test(whole) ||
    /&&[^(){}|&;]*\?\?/.test(whole)
  ) {
    problems.push('unparenthesized `??` mixed with `||`/`&&` (SyntaxError)');
  }

  // 3. Temporal-dead-zone: a hoisted `const __codeN = …` (a multi-line body expression) that reads
  //    an identifier declared by a LATER top-level const throws "Cannot access X before
  //    initialization" at SSR. Using a single reference frame (char offset within the BLANKED
  //    frontmatter), flag any `__codeN` whose RHS references a name declared after it.
  const declPos = new Map<string, number>();
  const note = (id: string | undefined, at: number): void => {
    if (id && !declPos.has(id)) declPos.set(id, at);
  };
  for (const mm of fm.matchAll(/(?:^|\n)(?:export\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) {
    note(mm[1], mm.index!);
  }
  for (const mm of fm.matchAll(/(?:^|\n)(?:export\s+)?(?:const|let|var)\s+\{([^}]*)\}\s*=/g)) {
    for (const part of mm[1]!.split(',')) {
      const t = part.trim();
      if (!t) continue;
      const name = t.includes(':')
        ? t.split(':')[1]!.trim()
        : t
            .replace(/^\.\.\./, '')
            .split('=')[0]!
            .trim();
      note(name.match(/^[A-Za-z_$][\w$]*/)?.[0], mm.index!);
    }
  }
  for (const mm of fm.matchAll(/(?:^|\n)[ \t]*const\s+(__code\d+)\s*=([\s\S]*?);/g)) {
    for (const ref of mm[2]!.match(/[A-Za-z_$][\w$]*/g) ?? []) {
      const pos = declPos.get(ref);
      if (pos !== undefined && pos > mm.index!) {
        problems.push(`hoisted ${mm[1]} reads '${ref}' before it is declared (TDZ)`);
        break;
      }
    }
  }

  // 4. JSX hoisted into the frontmatter: a `const __codeN = …<tag>…` is invalid because the
  //    frontmatter is TypeScript (`<li>` parses as a type cast). Such code must stay inline in
  //    the body. Detect a `<tag` in EXPRESSION position (preceded by start or a non-identifier —
  //    so a TS generic `Array<Foo>`, where `<` follows an identifier, is NOT mistaken for JSX) or
  //    any `</` closing tag (generics never have one). (Use RAW frontmatter — blankNonCode hides markup.)
  for (const mm of frontmatterOf(source).matchAll(/(?:^|\n)[ \t]*const\s+__code\d+\s*=([\s\S]*?);/g)) {
    if (/(?:^|[^A-Za-z0-9_$)\]])<[A-Za-z][\w.]*[\s/>]/.test(mm[1]!) || mm[1]!.includes('</')) {
      problems.push('JSX hoisted into the frontmatter (invalid — must stay inline in the body)');
      break;
    }
  }

  return problems;
}

/**
 * Try to rewrite `source` (a custom `.astro` file) as an editable Meno component. Returns the new
 * source on success, or a human-readable `reason` when the body can't be reduced to a single
 * editable root.
 */
export function promoteCustomComponent(source: string): PromoteResult {
  source = source.replace(/\r\n/g, '\n');
  const m = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const frontmatter = (m ? m[1]! : '').trim();
  const body = (m ? m[2]! : source).trim();

  if (!body.startsWith('<')) {
    return { ok: false, reason: 'component body must start with a single root element' };
  }
  // Already a Meno component (declares its own props) — nothing to promote.
  let blanked: string;
  try {
    blanked = blankNonCode(frontmatter);
  } catch {
    return { ok: false, reason: 'unparseable frontmatter (unterminated string or template)' };
  }
  if (/\bresolveProps\s*\(/.test(blanked)) {
    return { ok: false, reason: 'file already declares resolveProps — it is already a Meno component' };
  }
  // A component keeps only its FIRST top-level body node (splitComponentBody → nodes[0]). Refuse a
  // multi-root body so promotion never silently drops siblings — the author must wrap them.
  let topLevel: number;
  try {
    topLevel = countTopLevelNodes(body);
  } catch (e) {
    return { ok: false, reason: `unparseable body: ${(e as Error).message}` };
  }
  if (topLevel !== 1) {
    return { ok: false, reason: `body has ${topLevel} top-level nodes — wrap them in a single root element` };
  }

  // Synthesize the component form: a `resolveProps` block makes parse() classify the file as a
  // component, and its existing foreign frontmatter is captured verbatim as `_frontmatter`.
  const componentForm =
    "---\nimport { resolveProps } from 'meno-astro';\n\n" +
    'const { class: className } = resolveProps(Astro, {});\n' +
    (frontmatter ? `\n${frontmatter}\n` : '') +
    `---\n${body}\n`;

  const parsed = parse(componentForm);
  if (parsed.unsupported) return { ok: false, reason: parsed.unsupported.reason };
  const model = parsed.model as { component?: { structure?: unknown } };
  if (!model.component || model.component.structure === undefined) {
    return { ok: false, reason: 'body did not reduce to an editable component structure' };
  }

  const out = emit(parsed.model as Parameters<typeof emit>[0]);
  // Safety net: the emitted component must be round-trip stable, or the editor would drift on save.
  if (emit(parse(out).model as Parameters<typeof emit>[0]) !== out) {
    return { ok: false, reason: 'promoted component is not round-trip stable' };
  }
  // Soundness gate: refuse rather than hand back source that would fail a real `astro build`.
  const problems = validatePromotedSource(out);
  if (problems.length) return { ok: false, reason: `promoted component would not build: ${problems.join('; ')}` };
  return { ok: true, source: out };
}
