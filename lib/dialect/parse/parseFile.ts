/**
 * File orchestrator — split `---` frontmatter from body, parse both, and reassemble
 * the Meno model (a `{ component }` file or a `JSONPage`).
 */

import { parseFrontmatter } from './parseFrontmatter';
import { extractFrontmatterPassthrough, blankNonCode } from './frontmatterScan';
import { parseElement, parseNodes } from './parseBody';
import { unwrapDefineVarsJs } from '../scriptBind';
import { isCmsTemplatePage } from '../cmsRoute';
import { isSsrPage, ssrRouteParams } from '../ssrPage';
import type { ParseContext } from './parseContext';

import type { NodeSpan } from './parseContext';

export interface ParsedFile {
  model: Record<string, unknown>;
  /** Absolute source spans per object node, only present when `collectSpans` is set. */
  spans?: Map<object, NodeSpan>;
  /**
   * Absolute source spans of captured verbatim frontmatter passthrough (`_frontmatter`),
   * reported by `parse()` as `kind: 'verbatim'` regions. Only present when `collectSpans`.
   */
  frontmatterRegions?: NodeSpan[];
  /**
   * Set ONLY when the frontmatter cannot be scanned at all (e.g. an unterminated string), so
   * the model is untrustworthy and the file must be treated as read-only. Hand-authored
   * frontmatter the codec doesn't model is no longer flagged here — it is captured verbatim
   * as `_frontmatter` and round-trips. See `extractFrontmatterPassthrough`.
   */
  unsupported?: { reason: string };
}

export interface ParseFileOptions {
  /** Record each node's absolute source span (for `buildAstroLineMap`). Off by default. */
  collectSpans?: boolean;
}

/** Leading-whitespace count — how far `s.trim()` shifts `s`'s start. */
function leadingWs(s: string): number {
  return s.length - s.trimStart().length;
}

function splitFrontmatter(source: string): { code: string; body: string; bodyStart: number; codeStart: number } {
  const m = source.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  // The body is always the suffix of `source`, so its start offset is exact.
  const body = m ? (m[2] ?? '') : source;
  // The frontmatter body begins right after the opening `---\n` fence (4 chars).
  return { code: m ? (m[1] ?? '') : '', body, bodyStart: source.length - body.length, codeStart: m ? 4 : 0 };
}

/** Extract the shorthand names from a `define:vars={{ a, b }}` attribute, or undefined. */
function parseDefineVars(openTag: string): string[] | undefined {
  const m = openTag.match(/define:vars=\{\{([^}]*)\}\}/);
  if (!m) return undefined;
  return (m[1] ?? '')
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
  // The trailing matcher tolerates a stray `>` after the close tag (`</script>>`) — a
  // realistic hand/AI-authored typo that's a harmless text node to Astro but, anchored
  // strictly to `\s*$`, would make BOTH this regex AND the `<style>` one below miss (the
  // script no longer ends the body, so the style isn't last either) — silently dropping
  // `css`/`javascript` from the model. That loses the component's custom code in the editor
  // and, since the file isn't flagged `unsupported`, CLOBBERS it on the next re-emit.
  // `[\s>]*$` recovers the blocks and emit drops the stray `>` (it only re-adds a clean tag).
  const scriptM = rest.match(/\n*<script([^>]*)>\n([\s\S]*?)\n<\/script>[\s>]*$/);
  if (scriptM) {
    javascript = scriptM[2] ?? '';
    defineVars = parseDefineVars(scriptM[1] ?? '');
    // define:vars scripts are emitted wrapped in an `el`-binding IIFE (see scriptBind) —
    // strip it back off so the model's `javascript` is the clean authored source.
    if (defineVars) javascript = unwrapDefineVarsJs(javascript);
    rest = rest.slice(0, scriptM.index);
  }
  // Emitted as `<style is:global>` (meno-core parity — component CSS is global there;
  // see emitComponent). Plain `<style>` is still accepted for files emitted before the
  // directive was added (and hand-authored ones); emit canonicalizes to `is:global`.
  const styleM = rest.match(/\n*<style(?: is:global)?>\n([\s\S]*?)\n<\/style>[\s>]*$/);
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

/**
 * Reduce the page body (`<BaseLayout …>{root}</BaseLayout>`) to its single editable root
 * node. A Meno-EMITTED page always has exactly one modeled child here — emit writes one root
 * node, and the lone emit-injected `meno-cms-*` <script> sibling is already excluded during
 * child parsing. So >1 child (or a verbatim `_code` root) means hand-authored / SSR markup
 * the codec can't model: we still return the best-effort `children[0]` for preview, but also
 * report WHY it's read-only so the page provider serves an `_unsupported` placeholder and
 * never re-emits it (re-emitting would drop the extra nodes and CLOBBER the source file).
 */
function parsePageRoot(body: string, ctx: ParseContext, bodyStart: number): { root?: unknown; unsupported?: string } {
  const trimmed = body.trim();
  if (!trimmed.startsWith('<')) return {};
  const base = bodyStart + leadingWs(body);
  const wrapper = parseElement(trimmed, 0, ctx, base).node as Record<string, unknown>;
  const children = wrapper.children;
  if (!Array.isArray(children) || children.length === 0) return {};
  const root = children[0];
  if (children.length > 1) {
    return {
      root,
      unsupported: `page body has ${children.length} top-level nodes — hand-authored markup the editor can't model (the extra nodes would be lost on save)`,
    };
  }
  if (root && typeof root === 'object' && (root as Record<string, unknown>)._code === true) {
    return { root, unsupported: "page body is a hand-authored expression the editor can't model" };
  }
  return { root };
}

/**
 * `getStaticPaths()`, `await loadPageData(…)` and `const params = Astro.params` are EMIT-ONLY
 * boilerplate the emitter regenerates ONLY for the matching page type — `getStaticPaths` for a
 * CMS template (`meta.source === 'cms'` + `meta.cms`), and the `loadPageData` destructure /
 * `params` scope for an SSR page (`meta.source === 'ssr'` + `meta.data`, the latter also
 * needing a non-empty `meta.routeParams`). The frontmatter scanner covers these spans
 * UNCONDITIONALLY (it has no page model), so a hand-authored page that carries one but whose
 * parsed `meta` is NOT that type would be treated as editable and SILENTLY LOSE the construct
 * on save (emit, keyed on the type, wouldn't regenerate it) — leaving body references dangling
 * and breaking the build. Detect that mismatch from the already-parsed `meta` and report it,
 * so the provider serves the page read-only instead of clobbering it.
 *
 * For a genuine dialect CMS/SSR page the construct DOES match the type, so this never fires —
 * emit-produced pages (the `example/` round-trip guard) are unaffected.
 */
function detectOrphanedBoilerplate(code: string, meta: unknown): string | null {
  let blanked: string;
  try {
    blanked = blankNonCode(code); // ignore matches inside strings/comments
  } catch {
    return null; // unterminated literal → reported as unparseable elsewhere
  }
  const page = { meta };
  if (/\bfunction\s+getStaticPaths\s*\(/.test(blanked) && !isCmsTemplatePage(page)) {
    return "frontmatter defines getStaticPaths() but meta is not a CMS template (meta.source !== 'cms') — the editor can't model this dynamic route and would drop the route on save";
  }
  const ssr = isSsrPage(page);
  if (/\bawait\s+loadPageData\s*\(/.test(blanked) && !ssr) {
    return "frontmatter calls loadPageData() but meta is not an SSR page (meta.source !== 'ssr') — the editor can't model it and would drop it on save";
  }
  if (
    /\bconst\s+params\s*=\s*Astro\s*\.\s*params\b/.test(blanked) &&
    !(ssr && ssrRouteParams((meta ?? undefined) as { routeParams?: unknown } | undefined).length)
  ) {
    return "frontmatter defines `const params = Astro.params` but meta is not a dynamic SSR route (meta.source !== 'ssr' with routeParams) — the editor can't model it and would drop it on save";
  }
  return null;
}

export function parseFile(source: string, opts: ParseFileOptions = {}): ParsedFile {
  // Normalize line endings once at the single parse entry. A CRLF-line-ended `.astro`
  // (possible on a Windows checkout — isomorphic-git is CRLF-blind) would otherwise fail
  // the `\n`-anchored frontmatter split and silently lose ALL frontmatter. emit() only ever
  // writes `\n` and the model never carries `\r`, so for normal `\n` sources this is a no-op
  // and all downstream `\n`-anchored matchers benefit.
  source = source.replace(/\r\n/g, '\n');
  const { code, body, bodyStart, codeStart } = splitFrontmatter(source);
  const front = parseFrontmatter(code);
  // Hand-authored frontmatter the codec doesn't model (foreign imports, helper consts,
  // `import.meta.env`, …) is CAPTURED verbatim as `_frontmatter` so the file round-trips.
  // Only a frontmatter that can't be scanned at all (unterminated literal) is `unsupported`.
  const passthrough = extractFrontmatterPassthrough(code);
  const unsupported =
    passthrough && 'unparseable' in passthrough
      ? { reason: 'unparseable frontmatter (unterminated string or template)' }
      : undefined;
  const frontmatter = passthrough && 'block' in passthrough ? passthrough.block : undefined;
  const frontmatterRegions =
    opts.collectSpans && passthrough && 'spans' in passthrough
      ? passthrough.spans.map((s) => ({ start: s.start + codeStart, end: s.end + codeStart }))
      : undefined;
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
    if (frontmatter !== undefined) def._frontmatter = frontmatter;
    return { model: { component: def }, spans, frontmatterRegions, unsupported };
  }

  const { root, unsupported: bodyReason } = parsePageRoot(body, front.ctx, bodyStart);
  const page: Record<string, unknown> = {};
  if (front.meta !== undefined) page.meta = front.meta;
  if (root !== undefined) page.root = root;
  if (frontmatter !== undefined) page._frontmatter = frontmatter;
  // Foreign frontmatter (unparseable) takes precedence; then emit-only boilerplate that
  // doesn't match the parsed page type (getStaticPaths/loadPageData/params — would be dropped
  // on save); then a body the codec can't reduce to one editable root (hand-authored SSR
  // markup). Any of these makes the page read-only so it is previewed but never re-emitted.
  const orphanReason = unsupported ? null : detectOrphanedBoilerplate(code, front.meta);
  const pageUnsupported =
    unsupported ?? (orphanReason ? { reason: orphanReason } : bodyReason ? { reason: bodyReason } : undefined);
  return { model: page, spans, frontmatterRegions, unsupported: pageUnsupported };
}
