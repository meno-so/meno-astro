/**
 * File orchestrator — split `---` frontmatter from body, parse both, and reassemble
 * the Meno model (a `{ component }` file or a `JSONPage`).
 */

import { parseFrontmatter } from './parseFrontmatter';
import { parseElement, parseNodes } from './parseBody';
import { unwrapDefineVarsJs } from '../scriptBind';
import type { ParseContext } from './parseContext';

import type { NodeSpan } from './parseContext';

export interface ParsedFile {
  model: Record<string, unknown>;
  /** Absolute source spans per object node, only present when `collectSpans` is set. */
  spans?: Map<object, NodeSpan>;
}

export interface ParseFileOptions {
  /** Record each node's absolute source span (for `buildAstroLineMap`). Off by default. */
  collectSpans?: boolean;
}

/** Leading-whitespace count — how far `s.trim()` shifts `s`'s start. */
function leadingWs(s: string): number {
  return s.length - s.trimStart().length;
}

function splitFrontmatter(source: string): { code: string; body: string; bodyStart: number } {
  const m = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  // The body is always the suffix of `source`, so its start offset is exact.
  const body = m ? m[2] : source;
  return { code: m ? m[1] : '', body, bodyStart: source.length - body.length };
}

/** Extract the shorthand names from a `define:vars={{ a, b }}` attribute, or undefined. */
function parseDefineVars(openTag: string): string[] | undefined {
  const m = openTag.match(/define:vars=\{\{([^}]*)\}\}/);
  if (!m) return undefined;
  return m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function splitComponentBody(
  body: string,
  ctx: ParseContext,
  bodyStart: number,
): { structure?: unknown; css?: string; javascript?: string; defineVars?: string[] } {
  let rest = body;
  let javascript: string | undefined;
  let defineVars: string[] | undefined;
  let css: string | undefined;

  // The client script is either `<script is:inline>` or `<script define:vars={{…}}>`
  // (native Astro — the latter injects the listed props into the inline script).
  const scriptM = rest.match(/\n*<script([^>]*)>\n([\s\S]*?)\n<\/script>\s*$/);
  if (scriptM) {
    javascript = scriptM[2];
    defineVars = parseDefineVars(scriptM[1]);
    // define:vars scripts are emitted wrapped in an `el`-binding IIFE (see scriptBind) —
    // strip it back off so the model's `javascript` is the clean authored source.
    if (defineVars) javascript = unwrapDefineVarsJs(javascript);
    rest = rest.slice(0, scriptM.index);
  }
  // Emitted as `<style is:global>` (meno-core parity — component CSS is global there;
  // see emitComponent). Plain `<style>` is still accepted for files emitted before the
  // directive was added (and hand-authored ones); emit canonicalizes to `is:global`.
  const styleM = rest.match(/\n*<style(?: is:global)?>\n([\s\S]*?)\n<\/style>\s*$/);
  if (styleM) {
    css = styleM[1];
    rest = rest.slice(0, styleM.index);
  }

  const markup = rest.trim();
  // `rest` keeps `body`'s start, so the markup's absolute base is bodyStart + its leading ws.
  const base = bodyStart + leadingWs(rest);
  const structure = markup ? parseNodes(markup, 0, ctx, undefined, base).nodes[0] : undefined;
  return { structure, css, javascript, defineVars };
}

function parsePageRoot(body: string, ctx: ParseContext, bodyStart: number): unknown {
  const trimmed = body.trim();
  if (!trimmed.startsWith('<')) return undefined;
  const base = bodyStart + leadingWs(body);
  const wrapper = parseElement(trimmed, 0, ctx, base).node as Record<string, unknown>;
  const children = wrapper.children;
  return Array.isArray(children) ? children[0] : undefined;
}

export function parseFile(source: string, opts: ParseFileOptions = {}): ParsedFile {
  // Normalize line endings once at the single parse entry. A CRLF-line-ended `.astro`
  // (possible on a Windows checkout — isomorphic-git is CRLF-blind) would otherwise fail
  // the `\n`-anchored frontmatter split and silently lose ALL frontmatter. emit() only ever
  // writes `\n` and the model never carries `\r`, so for normal `\n` sources this is a no-op
  // and all downstream `\n`-anchored matchers benefit.
  source = source.replace(/\r\n/g, '\n');
  const { code, body, bodyStart } = splitFrontmatter(source);
  const front = parseFrontmatter(code);
  const spans = opts.collectSpans ? new Map<object, NodeSpan>() : undefined;
  if (spans) front.ctx.spans = spans;

  if (front.kind === 'component') {
    const { structure, css, javascript, defineVars } = splitComponentBody(body, front.ctx, bodyStart);
    const def: Record<string, unknown> = {};
    if (front.propsInterface && Object.keys(front.propsInterface).length) {
      def.interface = front.propsInterface;
    }
    if (structure !== undefined) def.structure = structure;
    Object.assign(def, front.componentMeta);
    if (css !== undefined) def.css = css;
    if (javascript !== undefined) def.javascript = javascript;
    // `defineVars` is reconstructed from the script's `define:vars={{…}}` attribute
    // (it's no longer carried in `__meno`). normalizeModel canonicalizes it.
    if (defineVars !== undefined) def.defineVars = defineVars;
    return { model: { component: def }, spans };
  }

  const root = parsePageRoot(body, front.ctx, bodyStart);
  const page: Record<string, unknown> = {};
  if (front.meta !== undefined) page.meta = front.meta;
  if (root !== undefined) page.root = root;
  return { model: page, spans };
}
