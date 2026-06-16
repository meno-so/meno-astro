/**
 * Play-mode targeted patching — surgical style/text updates, reload for the rest.
 *
 * Replaces the retired whole-page morph (see git history of morph.ts). The morph
 * treated fresh SSR HTML as the total source of truth for a DOM that has TWO
 * writers — the server (SSR output) and page JS (scroll-reveal inline styles,
 * carousel transforms, toggled class tokens, inserted clones). It had to infer
 * which attributes JS owned, and every page library broke the inference a new
 * way (fade.js one-shot reveals, embla engine state, motion timelines). One
 * invariant replaces those heuristics:
 *
 *   THE SERVER CLASSIFIES EVERY EDIT (it has old + new source and the dialect
 *   parser); THE CLIENT PERFORMS ONLY THE MUTATIONS THE CLASSIFICATION PROVES
 *   SAFE; ANYTHING UNPROVEN FULL-RELOADS — the regular-dev contract (CSS edits
 *   hot-patch, structural edits reload and re-run page JS from scratch).
 *
 * The edit ladder ({@link playPatchVitePlugin}, play mode + `astro dev` only):
 *
 *   1. A `<script>` block changed             → stock full reload.
 *   2. Only style({...})/interactiveStyles/
 *      label fields changed (models otherwise
 *      deep-equal)                            → patch event, kind 'style'.
 *   3. Only plain-text children changed       → patch event, kind 'text'.
 *   4. A component instance's SCALAR props
 *      changed (literal string without
 *      markup/binding, number, boolean, or a
 *      plain-string i18n object)              → patch event, kind 'attrs'.
 *   5. A component instance's RICH-TEXT prop
 *      changed (markup-bearing string / i18n,
 *      rendered via <Fragment set:html>)      → patch event, kind 'html'.
 *   6. Anything else (structure, object/array
 *      or {_code}/binding props, conditions,
 *      unparseable, Embed styles)             → stock full reload.
 *   7. `src/styles/theme.css` changed (the
 *      studio regenerates it on variable/
 *      color saves)                           → patch event, kind 'style'
 *                                               (sheet-swap only — CSS vars
 *                                               never touch the DOM).
 *
 * The client bridge ({@link PLAY_PATCH_BRIDGE_SCRIPT}) re-fetches the page once
 * per debounced batch and applies ONLY ({@link PATCH_JS}):
 *
 *   - Sheet swap: replace the text of head `<style data-vite-dev-id>` tags
 *     whose content changed (the CSS-HMR equivalent — a style element's text
 *     mutation cannot touch JS state). Astro dev inlines every collected
 *     stylesheet this way, including the rebuilt `virtual:meno-utilities.css`
 *     and theme.css.
 *   - Class merge, token-granular: live and fetched elements are PAIRED by the
 *     X-Ray identity stamps play mode already adds to both documents
 *     (data-element-path + instance/slot attrs, occurrence-ordered). Per pair:
 *     final = fetched tokens + (live-only tokens - staleTokens). JS-added
 *     tokens survive by construction; stale utility tokens (computed
 *     server-side from the changed nodes' OLD styles) are retired.
 *   - Inline style, property-granular: each declaration of a fetched
 *     server-rendered style attr is setProperty'd; live-only properties
 *     (fade.js reveals, embla transforms) are never removed.
 *   - Text sync: paired elements' direct child text nodes, only when the
 *     counts match.
 *   - Attribute + text sync (kind 'attrs', scalar prop edits): each
 *     server-rendered attribute is set on its paired live element (skipping
 *     class/style/value/checked + the identity stamps; additive/update only),
 *     inline style is property-merged, and text nodes are synced. meno variant
 *     props (size/align/variant/…) drive utility CLASSES through the component's
 *     style() mapping, so a prop edit ALSO rides kind 'style' carrying the whole
 *     project class vocabulary as stale tokens — mergeClasses retires the old
 *     variant classes and re-adds the fresh ones, and syncSheets brings any new
 *     utility rule. Gated only by structureDiverged: if a scalar prop drove a
 *     component-internal conditional/list (stamped elements added), the patch
 *     throws and the bridge full-reloads. A tag-only change (size → h1↔h2 at the
 *     same path) is NOT structural — the updated class styles it correctly and
 *     the semantically-stale tag self-heals on the next reload.
 *   - innerHTML sync (kind 'html', rich-text prop edits): a rich-text prop
 *     renders via `<Fragment set:html={…}>` into a LEAF element's innerHTML
 *     (e.g. Heading's `<h1>Build a <span class=hl>great</span> site</h1>`). The
 *     bridge replaces that innerHTML, guarded so it only touches a content leaf —
 *     no stamped descendant (component internals carry stamped structure + JS
 *     state) and the content is markup (element children present, so a JS-managed
 *     pure-text leaf is never clobbered). Same structureDiverged gate as 'attrs'.
 *
 *   No insert, no remove, no move, no script handling. The worst possible
 *   failure is one element with a stale class/attribute until the next reload —
 *   never a broken page.
 *
 * Transport: the bridge can't use import.meta.hot (inline scripts never enter
 * the module graph) and can't open its own vite-hmr WebSocket (token-gated in
 * Vite 6+ whenever an Origin header is present — always, from browsers), so it
 * dynamically imports /@vite/client and registers through createHotContext —
 * the exact mechanism import.meta.hot compiles to, riding the established
 * authenticated socket (reconnects included).
 *
 * Accepted, documented gaps (all self-heal on the next reload):
 *   - JS-cloned stamped elements (embla loop clones) pair off-by-count; the
 *     clone may keep a stale class until reload.
 *   - Rich-text inside a plain-text CHILD (not a component prop) is still
 *     classified structural → reload (only component rich-text PROPS patch).
 *   - A rich-text prop rendered into a NON-leaf container (a set:html element
 *     that also wraps stamped meno nodes) is skipped by syncHtml → that one edit
 *     waits for the next reload, never a wrong patch.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from '../dialect';
import { collectNodeClassTokens, collectModelClassTokens, walkAstroFiles } from './utilityCss';
import { XRAY_RESOLVER_JS } from './xray';
// Type-only (erased at build): the play patcher receives this controller from the
// integration's utility-CSS plugin to (a) rebuild the sheet for its patch payload and
// (b) invalidate the virtual module in-band. No runtime import — no cycle with ./index.
import type { UtilityCssController } from './index';

/** Custom Vite WS event the plugin broadcasts; the bridge patches on it. */
export const PLAY_PATCH_EVENT = 'meno:astro:patch';

/**
 * postMessage type the editor sends for an optimistic inline-style preview
 * (NOT a Vite event — it arrives via window.postMessage from the studio frame,
 * mirroring the X-Ray bridge's inbound channel). The bridge resolves the target
 * via {@link XRAY_RESOLVER_JS}'s resolveTarget, applies the declaration inline
 * for instant feedback, and clears it when the next real patch lands. Must match
 * the studio's ASTRO_PLAY_STYLE_PREVIEW_MESSAGE_TYPE literal.
 */
export const PLAY_STYLE_PREVIEW_EVENT = 'meno:astro:style-preview';

/**
 * postMessage type for the optimistic CSS-variable (design-token) preview.
 * Payload `{ vars: { '--name': value, … }, media }`. The bridge applies the
 * vars as a single `:root` override `<style>` (one global update cascades to
 * every consumer), clearing it on the next real patch. Must match the studio's
 * ASTRO_PLAY_VARS_PREVIEW_MESSAGE_TYPE literal.
 */
export const PLAY_VARS_PREVIEW_EVENT = 'meno:astro:vars-preview';

/**
 * Opt-in play-patch diagnostics. Off by default; zero cost when off.
 *   - SERVER side (this flag): `MENO_PLAY_DEBUG=1` in the `astro dev` env logs
 *     every reload classification + the cross-env swallow decision to stdout.
 *   - BRIDGE side (in-iframe): set `localStorage['meno:play:debug']='1'` (or
 *     `window.__MENO_PLAY_DEBUG=true`) in the preview's devtools — no env/app
 *     change needed — to log WHO triggered a reload. `vite:beforeFullReload`
 *     (astro:hmr-reload), `vite:ws:disconnect` (dev-server restart, e.g. a
 *     `project.config.json` save) and `vite:error` mean ASTRO reloaded us; the
 *     `refresh()` `.catch` means the BRIDGE reloaded (fetch non-OK / patch throw).
 * That split is how we tell a swallow/restart reload apart from a fetch-race
 * reload without guessing. See {@link PLAY_PATCH_BRIDGE_SCRIPT}.
 */
const PLAY_DEBUG = process.env.MENO_PLAY_DEBUG === '1';
const playDbg = (...args: unknown[]): void => {
  if (PLAY_DEBUG) console.info('[meno-play]', ...args);
};

/**
 * What a patch event tells the bridge to update. `attrs` covers scalar
 * component-prop edits — the bridge re-syncs paired elements' attributes and
 * text, gated by a structural divergence check (a prop can drive a
 * component-internal conditional/list the model classifier can't see). `html`
 * covers RICH-TEXT component props (a markup-bearing string rendered via
 * `<Fragment set:html={…}>`): the bridge replaces the innerHTML of the paired
 * leaf element (one carrying no stamped descendants — i.e. server-owned markup,
 * not component internals), same structural gate.
 */
export type PatchKind = 'style' | 'text' | 'attrs' | 'html';

/**
 * An authoritative stylesheet the server ships INSIDE the patch payload, so the
 * bridge applies it directly instead of recovering it from the re-fetched page.
 * Astro 6 dev serves Vite-processed sheets (the utility sheet, theme.css) as EMPTY
 * `<style data-vite-dev-id>` placeholders — the real CSS is injected client-side by
 * Vite's JS, which the bridge's raw-HTML re-fetch never runs — so the re-fetched
 * sheet is empty and cannot be trusted. `match` is a substring of the target tag's
 * `data-vite-dev-id` (`meno-utilities`, `styles/theme.css`); `css` is the content.
 */
export type PatchSheet = { match: string; css: string };

/**
 * Every `<script>` block of a `.astro` source, concatenated — the script
 * change detector's unit of comparison (same regex shape Astro's own
 * style-only HMR check uses). Script blocks are client behavior: a patched-in
 * script edit could never re-bind already-attached listeners, so script
 * changes always take the full reload.
 */
const SCRIPT_BLOCK_RE = /<script(?:\s.*?)?>.*?<\/script>/gs;
export function extractScriptBlocks(source: string): string {
  const blocks = source.match(SCRIPT_BLOCK_RE);
  return blocks ? blocks.join('\n') : '';
}

// ---------------------------------------------------------------------------
// Edit classification — model-level diff of old vs new source.
// ---------------------------------------------------------------------------

/** Node types whose rendered element carries the X-Ray stamps the patch pairs by. */
const PATCHABLE_NODE_TYPES = new Set(['node', 'link', 'component']);

export interface EditClassification {
  /** Any difference the patch can't prove safe — the caller must full-reload. */
  structural: boolean;
  /** Per changed node: the OLD style fields (token retirement is computed from these). */
  styleDiffs: Array<{ style: unknown; interactiveStyles: unknown; label: string | undefined }>;
  /** A plain-text child changed somewhere. */
  textChanged: boolean;
  /** A component instance's scalar prop(s) changed (attr/text re-sync, guarded). */
  attrsChanged: boolean;
  /** A component instance's rich-text (markup-string) prop changed (innerHTML re-sync, guarded). */
  htmlChanged: boolean;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!deepEqual(a[k], (b as Record<string, unknown>)[k])) return false;
    return true;
  }
  return false;
}

/**
 * Walk two parsed models in parallel and classify every difference. Generic
 * deep-walk with two special cases, both scoped to objects that ARE dialect
 * nodes (`type` in {@link PATCHABLE_NODE_TYPES}) — a node PROP that happens to
 * be named `style` or `label` is ordinary data and diffs as structural:
 *
 *  - `style` / `interactiveStyles` / `label` on a node → a style diff (the
 *    rendered output differs only in class attr values, server-rendered inline
 *    style values, and the utility sheet — all patchable).
 *  - string `children` on a node → a text diff, unless either side contains
 *    markup (`<`) — rich-text edits change child STRUCTURE in the rendered
 *    page, which a text-node patch can't express → structural.
 *
 * Everything else that differs is structural. Conservative by construction:
 * unknown node types, prop changes, condition flips, list edits, frontmatter
 * code — all reload.
 */
export function classifyModelEdit(oldModel: unknown, newModel: unknown): EditClassification {
  const out: EditClassification = {
    structural: false,
    styleDiffs: [],
    textChanged: false,
    attrsChanged: false,
    htmlChanged: false,
  };
  walkPair(oldModel, newModel, out);
  return out;
}

/**
 * An i18n prop value (`{_i18n: true, en, pl, … }`) whose every locale entry is a
 * plain string carrying no markup (`<`) and no `{{binding}}`. At render time
 * `i18n()` resolves it to ONE locale's string, which projects as a text node
 * (`{text}`) or an attribute value — exactly what the bridge's syncText/syncAttrs
 * reconcile from the re-fetched page (the active locale's value moved; the bridge
 * fetches the current-locale page and syncs it; `structureDiverged` still guards
 * the rare case where the value drove a conditional/list). A markup-carrying
 * locale value could render via `set:html` as ELEMENTS, so those stay structural.
 */
function isPatchableI18nValue(v: unknown): boolean {
  if (!isPlainObject(v) || v._i18n !== true) return false;
  for (const k of Object.keys(v)) {
    if (k === '_i18n') continue;
    const val = v[k];
    if (typeof val !== 'string' || val.includes('<') || val.includes('{{')) return false;
  }
  return true;
}

/**
 * A component prop value the bridge can re-sync as an attribute/text in place:
 * a literal scalar whose rendered projection is itself, OR a plain-string
 * {@link isPatchableI18nValue i18n object} (resolves to one locale's string).
 * Other objects/arrays (verbatim `{_code}`, link-mapping objects, nested
 * literals, rich-text docs) and strings carrying markup (`<`) or a `{{binding}}`
 * (opaque render) are NOT — they drive innerHTML/list structure the bridge can't
 * express, so any such diff reloads.
 */
function isPatchablePropValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  const t = typeof v;
  if (t === 'number' || t === 'boolean') return true;
  if (t === 'string') return !(v as string).includes('<') && !(v as string).includes('{{');
  return isPatchableI18nValue(v);
}

/**
 * A RICH-TEXT prop value: a string (markup allowed) or a plain-string i18n
 * object, carrying no `{{binding}}` (opaque render). A rich-text prop renders
 * via `<Fragment set:html={…}>` into a leaf element's innerHTML, which the
 * bridge re-syncs by replacing that innerHTML (see {@link PatchKind} `html`).
 * Distinct from {@link isPatchablePropValue} only in allowing markup (`<`);
 * scalar values match BOTH (and are routed to the gentler attrs/text path first).
 */
function isHtmlPatchablePropValue(v: unknown): boolean {
  if (typeof v === 'string') return !v.includes('{{');
  if (isPlainObject(v) && v._i18n === true) {
    for (const k of Object.keys(v)) {
      if (k === '_i18n') continue;
      const val = v[k];
      if (typeof val !== 'string' || val.includes('{{')) return false;
    }
    return true;
  }
  return false;
}

/**
 * Categorize a component instance's `props` diff. Every changed prop must be
 * either a scalar/plain-i18n value (→ `attrs`: gentle attr/text re-sync) or a
 * markup-bearing rich-text value (→ `html`: innerHTML re-sync); a single
 * object/array/`{_code}`/`{{binding}}` change taints the whole diff → `null`
 * (the caller reloads). Returns which patch flavors the diff needs (a save can
 * touch both: a scalar AND a rich-text prop).
 */
function classifyPropsDiff(oldProps: unknown, newProps: unknown): { attrs: boolean; html: boolean } | null {
  const a = isPlainObject(oldProps) ? oldProps : {};
  const b = isPlainObject(newProps) ? newProps : {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let attrs = false;
  let html = false;
  for (const k of keys) {
    const av = a[k];
    const bv = b[k];
    if (deepEqual(av, bv)) continue;
    // Scalar / plain-i18n is preferred (more surgical); only markup falls to html.
    if (isPatchablePropValue(av) && isPatchablePropValue(bv)) attrs = true;
    else if (isHtmlPatchablePropValue(av) && isHtmlPatchablePropValue(bv)) html = true;
    else return null;
  }
  return { attrs, html };
}

function walkPair(a: unknown, b: unknown, out: EditClassification): void {
  if (out.structural || a === b) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.structural = true;
      return;
    }
    for (let i = 0; i < a.length && !out.structural; i++) walkPair(a[i], b[i], out);
    return;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const isNode = typeof a.type === 'string' && a.type === b.type && PATCHABLE_NODE_TYPES.has(a.type);
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    let styleDiff = false;
    for (const k of keys) {
      if (out.structural) return;
      const av = a[k];
      const bv = (b as Record<string, unknown>)[k];
      if (isNode && (k === 'style' || k === 'interactiveStyles' || k === 'label')) {
        if (!deepEqual(av, bv)) styleDiff = true;
        continue;
      }
      // A component instance's props: scalar (and plain-string i18n) changes
      // re-sync as attrs/text; rich-text (markup string / set:html) changes
      // re-sync as innerHTML; anything else object/array/`{_code}`/binding-shaped
      // drives structure the bridge can't express → reload. (The component
      // identity field and slot `children` fall through to the generic walk, so a
      // swap or slot-structure change still reloads.)
      if (isNode && a.type === 'component' && k === 'props') {
        if (!deepEqual(av, bv)) {
          const cat = classifyPropsDiff(av, bv);
          if (!cat) out.structural = true;
          else {
            if (cat.attrs) out.attrsChanged = true;
            if (cat.html) out.htmlChanged = true;
          }
        }
        continue;
      }
      if (isNode && k === 'children' && typeof av === 'string' && typeof bv === 'string') {
        if (av !== bv) {
          // Markup inside a text child renders as ELEMENTS — not expressible
          // as a text-node patch.
          if (av.includes('<') || bv.includes('<')) out.structural = true;
          else out.textChanged = true;
        }
        continue;
      }
      walkPair(av, bv, out);
    }
    if (styleDiff) {
      out.styleDiffs.push({
        style: a.style,
        interactiveStyles: a.interactiveStyles,
        label: typeof a.label === 'string' ? a.label : undefined,
      });
    }
    return;
  }
  out.structural = true;
}

/**
 * Classify an `.astro` edit from its old and new sources. A parse failure on
 * either side (mid-typing states, parser/converter skew) is structural — the
 * full reload is always correct, never the patch.
 */
export function classifyAstroEdit(oldSrc: string, newSrc: string): EditClassification {
  let oldModel: unknown;
  let newModel: unknown;
  try {
    oldModel = parse(oldSrc).model;
    newModel = parse(newSrc).model;
  } catch {
    return { structural: true, styleDiffs: [], textChanged: false, attrsChanged: false, htmlChanged: false };
  }
  return classifyModelEdit(oldModel, newModel);
}

// ---------------------------------------------------------------------------
// The vite plugin — edit ladder + patch broadcast.
// ---------------------------------------------------------------------------

/** Send channel slice (Vite's `server.ws` / `environment.hot`) — custom-event broadcast. */
interface PatchSend {
  send: (payload: { type: string; event?: string; data?: unknown }) => void;
}

/**
 * The dev-server slice {@link UtilityCssController.invalidate} reads (the Vite module
 * graph(s): mixed on ≤5, per-environment on 6+). Both hook contexts carry it at runtime
 * (`opts.server`/`ctx.server` ARE the ViteDevServer); we surface it on their structural
 * types so the in-band invalidate typechecks.
 */
type InvalidatableServer = Parameters<UtilityCssController['invalidate']>[0];

/** Structural slice of Vite ≤5's HmrContext (legacy `handleHotUpdate`). */
interface LegacyHmrContext {
  file: string;
  read: () => Promise<string> | string;
  server: { ws: PatchSend } & InvalidatableServer;
}

/** Structural slice of Vite 6+'s HotUpdateOptions (the new `hotUpdate` hook). */
interface HotUpdateOptionsLite {
  type: 'create' | 'update' | 'delete';
  file: string;
  read: () => Promise<string> | string;
  server: { ws: PatchSend } & InvalidatableServer;
}

/** `this` for the Vite 6+ `hotUpdate` hook — carries the per-environment context. */
interface HotUpdateThis {
  environment?: { name?: string };
}

/** Structural slice of the dev server passed to `configureServer` (Vite ≤5 + 6+). */
interface PlayPatchServer {
  watcher: { on: (evt: string, cb: (file: string) => void) => void };
}

/**
 * Every utility class token any `.astro` under `<root>/src` can render — the
 * full project style() vocabulary, every `_mapping` value expanded (via the
 * shared {@link walkAstroFiles} + {@link collectModelClassTokens}). A prop edit
 * sends this as the patch's stale tokens so the client's mergeClasses retires
 * the edited component's OLD variant classes (it can't compute the exact ones
 * the prop drives without rendering the component, but the vocabulary is a safe
 * superset: mergeClasses re-adds whatever the fresh render still uses, and JS
 * classes — never style()-shaped — are untouched). Unparseable files are
 * skipped (their classes simply won't retire — same gap as the utility sheet).
 */
function collectProjectClassVocabulary(projectRoot: string): Set<string> {
  const out = new Set<string>();
  const srcDir = join(projectRoot, 'src');
  if (!existsSync(srcDir)) return out;
  walkAstroFiles(srcDir, (p) => {
    let model: unknown;
    try {
      model = parse(readFileSync(p, 'utf8')).model;
    } catch {
      return; // unreadable/unparseable → skip
    }
    for (const t of collectModelClassTokens(model)) out.add(t);
  });
  return out;
}

/**
 * Vite plugin (play mode + `astro dev` only) implementing the edit ladder.
 * Patchable edits broadcast {@link PLAY_PATCH_EVENT} and return `[]`, which
 * empties the HMR module list FOR EVERY ENVIRONMENT — Vite's propagation does
 * nothing and Astro's `astro:hmr-reload` (which keys off that list) never fires
 * its full reload. Module-graph invalidation happens BEFORE plugin hooks, so the
 * suppression only stops the browser reload, never staleness. Everything else
 * returns undefined and the stock full reload proceeds.
 *
 * Why "every environment" is load-bearing under Astro 6 (Vite 6+):
 * `handleHMRUpdate` runs the `hotUpdate` hooks per environment, and
 * `astro:hmr-reload` reloads imperatively — it reads its env's module list and,
 * if any SSR-only module is present, calls `server.ws.send({ full-reload })`
 * DIRECTLY (returning `[]` from a different env can't stop that). It registers
 * its hook with `order: 'post'`, so within each env's hook loop it runs AFTER
 * ours (ours has no `order` → the "normal" bucket, which Vite sorts before
 * "post"). So when OUR hook empties THIS env's module list first, `astro:hmr-reload`
 * sees zero SSR-only modules and sends nothing — for the ssr AND astro
 * environments alike. (Vite ≤5 had one mixed module graph, so the original `[]`
 * return already covered every environment; the per-env split is why we must now
 * return `[]` in the server envs too, not just the client env.)
 *
 * The edit is classified ONCE, in the client env (it runs before the server
 * envs in `handleHMRUpdate`), which records whether the file is patchable in
 * {@link patchableFiles}; the server-env hooks only consult that record to
 * decide between `[]` (starve the reload) and undefined (let it through). They
 * must NOT re-classify: classification advances the source baseline, so a second
 * pass would see a no-op and wrongly starve a genuine structural reload.
 *
 * Source baselines are seeded at server start (so the FIRST edit of a file can
 * already patch) and kept fresh on every update/add/unlink; a file with no
 * baseline conservatively reloads.
 */
export function playPatchVitePlugin(projectRoot: string, utilityCss?: UtilityCssController): Record<string, unknown> {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const srcRoot = `${norm(projectRoot).replace(/\/$/, '')}/src/`;
  const themeCssPath = `${srcRoot}styles/theme.css`;
  /** Normalized absolute path → full source baseline. */
  const sourceCache = new Map<string, string>();
  /**
   * Normalized paths the client-env `hotUpdate` last classified as patchable
   * (kept current per edit — added when patchable/noop, deleted when reload). The
   * server-env hooks read this to starve `astro:hmr-reload` (return `[]`) instead
   * of re-classifying. The client env runs before the server envs within one
   * `handleHMRUpdate`, and the hook is always invoked with the CHANGED file, so the
   * entry the server env reads was just written for that same edit (never stale).
   */
  const patchableFiles = new Set<string>();
  /**
   * Project class vocabulary (prop-edit stale tokens), built lazily on the first
   * prop edit by parsing every `src/**.astro` (tens of ms once per dev session for
   * a typical project), then cached and reused across prop edits — invalidated
   * only when a style/structural edit or add/unlink could change it. `null` = stale.
   */
  let classVocab: string[] | null = null;
  const getClassVocab = (): string[] => {
    if (classVocab === null) classVocab = [...collectProjectClassVocabulary(projectRoot)];
    return classVocab;
  };

  const cacheFile = (path: string): void => {
    try {
      sourceCache.set(norm(path), readFileSync(path, 'utf8'));
    } catch {
      /* unreadable → no baseline → that file's first change full-reloads */
    }
  };

  /**
   * Shared edit classification for both HMR hooks. Returns the patch kinds +
   * stale tokens for a patchable edit, `'noop'` for a byte-identical write
   * (already invalidated; nothing to do), or `'reload'` for anything the patch
   * can't prove safe (not our file, unreadable, no baseline, script/structural
   * change, or emit-only re-canonicalization) — the caller lets the stock full
   * reload proceed.
   */
  type EditPlan = { kinds: PatchKind[]; staleTokens: string[] } | 'noop' | 'reload';
  const classifyEdit = async (rawFile: string, read: () => Promise<string> | string): Promise<EditPlan> => {
    const file = norm(rawFile);
    // theme.css changes carry CSS variables (the studio regenerates the file on
    // variable/color saves) — pure sheet swap, never a DOM mutation. CSS vars
    // aren't utility classes, so the class vocabulary is unchanged.
    if (file === themeCssPath) return { kinds: ['style'], staleTokens: [] };

    if (!file.endsWith('.astro') || !file.startsWith(srcRoot)) return 'reload';
    let source: string;
    try {
      source = await read();
    } catch {
      playDbg('reload: unreadable file', file);
      return 'reload'; // unreadable → stock reload path
    }
    const prev = sourceCache.get(file);
    sourceCache.set(file, source);
    if (prev === undefined) {
      playDbg('reload: no baseline (first edit of file this session)', file);
      return 'reload'; // no baseline → first change reloads
    }
    if (prev === source) return 'noop'; // byte-identical write
    // Rung 1: script blocks.
    if (extractScriptBlocks(prev) !== extractScriptBlocks(source)) {
      playDbg('reload: <script> block changed', file);
      return 'reload';
    }
    // Rungs 2-4: model classification.
    const edit = classifyAstroEdit(prev, source);
    // A style() or structural change can alter the project class vocabulary the
    // prop-edit stale tokens are built from — drop the cache so it rebuilds.
    if (edit.structural || edit.styleDiffs.length > 0) classVocab = null;
    if (edit.structural) {
      playDbg('reload: structural edit (markup/children/non-scalar prop changed)', file);
      return 'reload';
    }
    const kinds: PatchKind[] = [];
    const staleTokens = new Set<string>();
    if (edit.styleDiffs.length > 0) {
      kinds.push('style');
      for (const d of edit.styleDiffs) {
        for (const t of collectNodeClassTokens(d.style, d.interactiveStyles, d.label)) {
          staleTokens.add(t);
        }
      }
    }
    if (edit.textChanged) kinds.push('text');
    // Rich-text (set:html) prop edits: the bridge replaces the target leaf's
    // innerHTML. No staleTokens / no 'style' ride — content change, not classes.
    if (edit.htmlChanged) kinds.push('html');
    if (edit.attrsChanged) {
      kinds.push('attrs');
      // Prop edits ride kind 'style' so the client's mergeClasses retires the
      // component's OLD variant classes (size/align/variant/…). We can't know
      // the exact ones the prop drives without rendering the component, so we
      // send the project's full style() vocabulary as stale tokens (a safe
      // superset — mergeClasses re-adds what the fresh render still uses).
      if (!kinds.includes('style')) kinds.push('style');
      for (const t of getClassVocab()) staleTokens.add(t);
    }
    // Parsed models are fully equal yet the bytes differ — so the only change is
    // emit-only metadata the parser drops (e.g. a structure root's `root: true`,
    // which flips whether the parent's instance class merges over the component
    // root — render-affecting). The parse discarded the marker, so we can't tell
    // a render-affecting diff from a cosmetic one here → reload. (Byte-identical
    // is short-circuited above, so this only fires on a real on-disk change.)
    if (kinds.length === 0) {
      playDbg('reload: emit-only re-canonicalization (model unchanged, bytes differ)', file);
      return 'reload';
    }
    return { kinds, staleTokens: [...staleTokens] };
  };

  /**
   * Compute the authoritative sheet(s) to ship with a patch, and keep the utility
   * virtual module fresh. In Astro 6 dev the SSR HTML carries the utility sheet +
   * theme.css as EMPTY `<style>` placeholders (Vite injects the real CSS client-side),
   * so the bridge can't recover them from its raw-HTML re-fetch — it gets them here.
   *
   * For any `.astro` edit we rebuild the utility sheet from disk AND invalidate the
   * virtual module in-band: this runs in the client-env `hotUpdate`, BEFORE Astro's
   * SSR-env `astro:hmr-reload` sends a full reload, so a reload fallback re-imports
   * fresh CSS too (Astro's hmr-reload skips style modules — nothing else invalidates
   * it). Only a patchable style edit returns the sheet to put in the payload. A
   * `theme.css` edit ships the regenerated file as the sheet. No-op without a
   * controller (unit tests / non-play callers) — keeps the payload `{ kinds, staleTokens }`.
   */
  const refreshUtilitySheet = async (
    file: string,
    plan: EditPlan,
    read: () => Promise<string> | string,
    server: InvalidatableServer,
  ): Promise<PatchSheet[] | undefined> => {
    if (!utilityCss || plan === 'noop') return undefined;
    const n = norm(file);
    if (n === themeCssPath) {
      let css = '';
      try {
        css = await read();
      } catch {
        /* unreadable → empty sheet (the next reload re-renders it) */
      }
      return [{ match: 'styles/theme.css', css }];
    }
    if (!n.endsWith('.astro') || !n.startsWith(srcRoot)) return undefined;
    const css = utilityCss.rebuild();
    utilityCss.invalidate(server);
    if (plan === 'reload' || !plan.kinds.includes('style')) return undefined;
    return [{ match: 'meno-utilities', css }];
  };

  return {
    name: 'meno-astro:play-patch',
    // Sort into the post bucket (alongside astro:hmr-reload); harmless on Vite 5.
    enforce: 'post',
    configureServer(server: PlayPatchServer) {
      const srcDir = join(projectRoot, 'src');
      try {
        if (existsSync(srcDir)) walkAstroFiles(srcDir, cacheFile);
      } catch {
        /* best-effort seed */
      }
      server.watcher.on('add', (file) => {
        const n = norm(file);
        if (n.endsWith('.astro') && n.startsWith(srcRoot)) {
          cacheFile(file);
          classVocab = null; // a new file may add style() classes
        }
      });
      server.watcher.on('unlink', (file) => {
        sourceCache.delete(norm(file));
        patchableFiles.delete(norm(file));
        if (norm(file).endsWith('.astro')) classVocab = null;
      });
    },
    // Vite 6+ (Astro 6). The hook runs once per environment. We classify + broadcast
    // ONLY in the client env (it runs first in handleHMRUpdate, before the server
    // envs), and in EVERY env we return [] for a patchable edit — emptying that env's
    // HMR module list so astro:hmr-reload (which runs after us, order:'post') sees no
    // SSR-only module and never sends its imperative full-reload (see the plugin
    // header). Server envs only consult the client env's classification
    // (patchableFiles); re-classifying there would advance the baseline and wrongly
    // starve a real structural reload. Vite calls THIS, not handleHotUpdate, when
    // both are defined, so the two never both fire.
    async hotUpdate(this: HotUpdateThis, opts: HotUpdateOptionsLite): Promise<unknown[] | undefined> {
      if (opts.type !== 'update' && opts.type !== 'create') return undefined;
      const file = norm(opts.file);
      // Non-client (ssr / astro / prerender) envs: starve astro:hmr-reload iff the
      // client env classified this edit patchable; otherwise let the reload through.
      if (this.environment?.name !== 'client') {
        const has = patchableFiles.has(file);
        if (PLAY_DEBUG && (file.endsWith('.astro') || file === themeCssPath)) {
          playDbg(`hotUpdate[${this.environment?.name}] ${has ? 'swallow []' : 'LET RELOAD THROUGH'}`, file);
        }
        return has ? [] : undefined;
      }
      const plan = await classifyEdit(opts.file, opts.read);
      if (PLAY_DEBUG && (file.endsWith('.astro') || file === themeCssPath)) {
        playDbg('hotUpdate[client]', file, typeof plan === 'string' ? plan : `patch(${plan.kinds.join(',')})`);
      }
      // Record the decision for the server envs (patchable + no-op → starve; reload
      // → let through), BEFORE the sheet work so a throw there can't desync it.
      if (plan === 'reload') patchableFiles.delete(file);
      else patchableFiles.add(file);
      // Rebuild + invalidate the utility sheet (and gather the payload sheet) BEFORE
      // the reload branch, so a full-reload fallback serves fresh CSS too.
      const sheets = await refreshUtilitySheet(opts.file, plan, opts.read, opts.server);
      if (plan === 'reload') return undefined;
      if (plan === 'noop') return [];
      opts.server.ws.send({
        type: 'custom',
        event: PLAY_PATCH_EVENT,
        data: { kinds: plan.kinds, staleTokens: plan.staleTokens, ...(sheets ? { sheets } : {}) },
      });
      return [];
    },
    // Legacy Vite ≤5 (Astro 4/5). Only invoked when `hotUpdate` is absent, so it
    // and `hotUpdate` never both fire. The `[]` swallow is sufficient on astro ≤5.
    async handleHotUpdate(ctx: LegacyHmrContext): Promise<unknown[] | undefined> {
      const plan = await classifyEdit(ctx.file, ctx.read);
      const sheets = await refreshUtilitySheet(ctx.file, plan, ctx.read, ctx.server);
      if (plan === 'reload') return undefined;
      if (plan === 'noop') return [];
      ctx.server.ws.send({
        type: 'custom',
        event: PLAY_PATCH_EVENT,
        data: { kinds: plan.kinds, staleTokens: plan.staleTokens, ...(sheets ? { sheets } : {}) },
      });
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// The client patch — injected into the bridge, unit-testable as a string.
// ---------------------------------------------------------------------------

/**
 * The patch implementation — injected into {@link PLAY_PATCH_BRIDGE_SCRIPT}
 * verbatim and unit-testable by evaluating this string against a (happy-)DOM
 * (same pattern as XRAY_RESOLVER_JS). Functions close over the global
 * document. NOTE: comments in this string must stay backtick-free (a backtick
 * would terminate the template literal).
 */
export const PATCH_JS = `
    // ---- sheet swap: the CSS-HMR equivalent --------------------------------
    // Astro dev keys every collected stylesheet by a head style tag's
    // data-vite-dev-id (utility sheet, theme.css, component styles). Text
    // mutation on a style element cannot touch JS state.
    //
    // CRITICAL (Astro 6): the Vite-PROCESSED sheets (utility, theme, component
    // CSS) are emitted as EMPTY data-vite-dev-id placeholders in the SSR HTML —
    // Vite injects their real content client-side, which the bridge's raw-HTML
    // re-fetch never runs. So a fetched sheet is routinely empty while its live
    // counterpart is populated. NEVER overwrite a populated live sheet with empty
    // fetched content (that wipes the live CSS and snaps every styled element back
    // to unstyled). Authoritative content for the utility sheet + theme.css now
    // arrives via the patch payload (applyPayloadSheets); empty fetched tags are
    // skipped here.
    function syncSheets(nextDoc) {
      var live = {};
      var tags = document.head.querySelectorAll('style[data-vite-dev-id]');
      for (var i = 0; i < tags.length; i++) {
        live[tags[i].getAttribute('data-vite-dev-id')] = tags[i];
      }
      var next = nextDoc.head ? nextDoc.head.querySelectorAll('style[data-vite-dev-id]') : [];
      for (var j = 0; j < next.length; j++) {
        var id = next[j].getAttribute('data-vite-dev-id');
        var want = next[j].textContent;
        if (!want) continue;
        if (live[id]) {
          if (live[id].textContent !== want) live[id].textContent = want;
        } else {
          var el = document.createElement('style');
          el.setAttribute('data-vite-dev-id', id);
          el.textContent = want;
          document.head.appendChild(el);
        }
      }
    }

    // ---- authoritative sheets from the patch payload -----------------------
    // The server ships the freshly rebuilt utility sheet (and regenerated
    // theme.css) inline with the patch, identified by a data-vite-dev-id
    // SUBSTRING (meno-utilities / styles/theme.css). Apply each to every matching
    // live style tag (Astro's empty SSR placeholder AND Vite's injected copy can
    // both be present — same id), creating one if none exists. This is the only
    // reliable source of the CSS (see syncSheets), so it wins: applied AFTER
    // syncSheets in the same synchronous pass.
    function applyPayloadSheets(sheets) {
      if (!sheets || !sheets.length) return;
      for (var i = 0; i < sheets.length; i++) {
        var match = sheets[i] && sheets[i].match;
        var css = sheets[i] && sheets[i].css;
        if (!match || typeof css !== 'string') continue;
        var tags = document.head.querySelectorAll('style[data-vite-dev-id]');
        var found = false;
        for (var j = 0; j < tags.length; j++) {
          if (tags[j].getAttribute('data-vite-dev-id').indexOf(match) !== -1) {
            if (tags[j].textContent !== css) tags[j].textContent = css;
            found = true;
          }
        }
        if (!found) {
          var el = document.createElement('style');
          el.setAttribute('data-vite-dev-id', match);
          el.textContent = css;
          document.head.appendChild(el);
        }
      }
    }

    // ---- identity pairing ---------------------------------------------------
    // Both documents carry the X-Ray stamps (play mode stamps every response).
    // Patchable edits leave structure identical, so pairing by FULL identity —
    // the instance-path CHAIN (page file down to the element's own file) plus the
    // file-local path — with occurrence order is exact; JS-inserted clones surface
    // as live-side extras and are simply skipped.
    //
    // The chain is load-bearing, NOT the element's own data-meno-instance: only an
    // instance ROOT forwards an instance attr, so a deep component-internal element
    // carries none. A bare path|instance|slot key therefore COLLIDES across every
    // component that renders an element at the same file-local path — e.g. each
    // section's first slot child is path "0,0". Occurrence-order pairing then holds
    // only while live and fetched stay in lockstep; the moment page JS clones or
    // inserts a stamped node into one such shared bucket, the bucket shifts and a
    // prop edit's whole-project stale-token set strips an UNRELATED instance's
    // layout classes (the collapsed / mis-styled tile after a variant-prop change).
    // identify() walks the chain up to the nearest ancestor instance root, making
    // the key per-instance unique, so a drift inside one component can never
    // mispair another's elements — the same identity identify()/resolveTarget()
    // resolve by, injected just above this script. Fall back to the raw attributes
    // if it is ever absent (a non-bridge caller) or returns null (malformed stamp).
    function pairKey(el) {
      if (typeof identify === 'function') {
        var id = identify(el);
        if (id) return id.chain.join(';') + '|' + id.path;
      }
      return (
        el.getAttribute('data-element-path') +
        '|' + (el.getAttribute('data-meno-instance') || '') +
        '|' + (el.getAttribute('data-meno-slot') || '')
      );
    }

    function collectPairs(nextDoc) {
      var pairs = [];
      var liveByKey = {};
      var liveEls = document.querySelectorAll('[data-element-path]');
      for (var i = 0; i < liveEls.length; i++) {
        var k = pairKey(liveEls[i]);
        (liveByKey[k] = liveByKey[k] || []).push(liveEls[i]);
      }
      var nextEls = nextDoc.querySelectorAll('[data-element-path]');
      var taken = {};
      for (var j = 0; j < nextEls.length; j++) {
        var k2 = pairKey(nextEls[j]);
        var idx = taken[k2] = (taken[k2] || 0);
        taken[k2]++;
        var bucket = liveByKey[k2];
        if (bucket && bucket[idx]) pairs.push([bucket[idx], nextEls[j]]);
      }
      return pairs;
    }

    // ---- per-pair mutations ---------------------------------------------------
    function tokens(el) {
      var cls = el.getAttribute('class');
      return cls ? cls.split(/\\s+/).filter(function (t) { return t.length > 0; }) : [];
    }

    // final = fetched tokens + (live-only tokens minus staleTokens). JS-added
    // tokens survive by construction; retired utility tokens disappear.
    function mergeClasses(liveEl, nextEl, stale) {
      var want = tokens(nextEl);
      var have = tokens(liveEl);
      var seen = {};
      var out = [];
      for (var i = 0; i < want.length; i++) {
        if (!seen[want[i]]) { seen[want[i]] = true; out.push(want[i]); }
      }
      for (var j = 0; j < have.length; j++) {
        var t = have[j];
        if (!seen[t] && !stale[t]) { seen[t] = true; out.push(t); }
      }
      var final = out.join(' ');
      if ((liveEl.getAttribute('class') || '') !== final) {
        if (final) liveEl.setAttribute('class', final);
        else liveEl.removeAttribute('class');
      }
    }

    // Property-granular inline style application: setProperty each declaration
    // of a CSS decl string; never clears live-only properties. Shared by the
    // server-inline merge below and the optimistic preview path.
    function applyDeclString(el, decl) {
      if (!decl) return;
      var parts = decl.split(';');
      for (var i = 0; i < parts.length; i++) {
        var idx = parts[i].indexOf(':');
        if (idx < 0) continue;
        var prop = parts[i].slice(0, idx).trim();
        var value = parts[i].slice(idx + 1).trim();
        if (prop) {
          try { el.style.setProperty(prop, value); } catch (e) {}
        }
      }
    }

    // Property-granular inline style: set each declaration the server rendered;
    // never remove live-only properties (fade.js reveals, embla transforms).
    function mergeInlineStyle(liveEl, nextEl) {
      applyDeclString(liveEl, nextEl.getAttribute('style'));
    }

    // ---- optimistic style preview --------------------------------------------
    // The editor posts the just-changed declaration (meno:astro:style-preview)
    // so a style edit shows instantly, before astro recompiles and the real
    // patch lands ~1s later. We resolve the target via the X-Ray resolveTarget
    // and setProperty the declaration inline. We snapshot the element's original
    // style attribute the FIRST time we touch it; the next real patch restores
    // that snapshot (see applyPatch) so the canonical utility-class styling —
    // including future hover/responsive rules — wins. resolveTarget is provided
    // by XRAY_RESOLVER_JS, embedded alongside this script in the bridge.
    var optimistic = [];
    function applyOptimistic(target, css, media) {
      if (!css) return;
      // Per-frame media gate — the inline equivalent of the variable preview's
      // @media. Each design frame iframe is sized to its breakpoint width, so
      // matchMedia here is true only in frames whose viewport matches the edited
      // breakpoint. Without it an inline style (no media) would apply at every
      // frame's width, so a base edit would bleed into the tablet/mobile frames.
      if (media) {
        var dv = document.defaultView;
        if (dv && dv.matchMedia && !dv.matchMedia(media).matches) return;
      }
      var el = resolveTarget(target);
      if (!el) return;
      var found = false;
      for (var i = 0; i < optimistic.length; i++) {
        if (optimistic[i].el === el) { found = true; break; }
      }
      if (!found) optimistic.push({ el: el, original: el.getAttribute('style') });
      applyDeclString(el, css);
    }

    // ---- optimistic CSS-variable (design-token) preview ----------------------
    // A variable maps to a :root custom property, so ONE global override
    // cascades to every var(--name) consumer instantly — no per-element work.
    // The editor posts { vars: { '--name': value }, media }; we accumulate them
    // (so several edits before a patch don't clobber each other) into a single
    // managed <style id="meno-vars-preview"> appended after theme.css, where a
    // plain :root rule wins by source order (:root and [theme=x] are equal
    // specificity). applyPatch removes it before syncSheets swaps in the real
    // regenerated theme.css. 'media' scopes non-base token edits via @media.
    var optimisticVars = {};
    var optimisticVarsTag = null;
    function clearVarsPreview() {
      optimisticVars = {};
      if (optimisticVarsTag && optimisticVarsTag.parentNode) {
        optimisticVarsTag.parentNode.removeChild(optimisticVarsTag);
      }
      optimisticVarsTag = null;
    }
    function renderVarsTag() {
      var byMedia = {};
      var any = false;
      for (var k in optimisticVars) {
        var e = optimisticVars[k];
        any = true;
        (byMedia[e.media] = byMedia[e.media] || []).push(e.name + ': ' + e.value + ';');
      }
      if (!any) { clearVarsPreview(); return; }
      var css = '';
      for (var m in byMedia) {
        var decls = ':root { ' + byMedia[m].join(' ') + ' }';
        css += m ? '@media ' + m + ' { ' + decls + ' } ' : decls + ' ';
      }
      if (!optimisticVarsTag) {
        optimisticVarsTag = document.createElement('style');
        optimisticVarsTag.id = 'meno-vars-preview';
        document.head.appendChild(optimisticVarsTag);
      }
      optimisticVarsTag.textContent = css;
    }
    function applyVarsPreview(vars, media) {
      if (!vars) return;
      var m = typeof media === 'string' ? media : '';
      for (var name in vars) {
        var v = vars[name];
        // Reject malformed names / CSS-breakout chars (textContent injection guard).
        if (!/^--[A-Za-z0-9_-]+$/.test(name)) continue;
        if (typeof v !== 'string' || v === '' || /[{}<>;]/.test(v)) continue;
        optimisticVars[m + '|' + name] = { media: m, name: name, value: v };
      }
      renderVarsTag();
    }

    // Direct child text nodes only, and only when the counts match — a
    // mismatch means the structures diverged (JS inserted something); skipping
    // is always safe, the next reload reconciles.
    function syncText(liveEl, nextEl) {
      var liveTexts = [];
      var nextTexts = [];
      var c;
      for (c = liveEl.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) liveTexts.push(c);
      for (c = nextEl.firstChild; c; c = c.nextSibling) if (c.nodeType === 3) nextTexts.push(c);
      if (liveTexts.length !== nextTexts.length) return;
      for (var i = 0; i < liveTexts.length; i++) {
        if (liveTexts[i].nodeValue !== nextTexts[i].nodeValue) {
          liveTexts[i].nodeValue = nextTexts[i].nodeValue;
        }
      }
    }

    // Attribute sync for prop edits, additive + update only (parity with
    // mergeInlineStyle): set each server-rendered attribute the live element
    // lacks or has stale; never remove a live-only attribute (a removed prop
    // self-heals on the next reload). Skip identity/control attrs, class/style
    // (their own mergers), and value/checked (IDL/user-input divergence).
    function attrSkip(name) {
      return (
        name === 'class' || name === 'style' || name === 'value' || name === 'checked' ||
        name === 'data-cms-item-index' ||
        name.indexOf('data-element-path') === 0 ||
        name.indexOf('data-meno-') === 0 ||
        name.indexOf('data-vite-dev-id') === 0
      );
    }
    function syncAttrs(liveEl, nextEl) {
      var attrs = nextEl.attributes;
      for (var i = 0; i < attrs.length; i++) {
        var name = attrs[i].name;
        if (attrSkip(name)) continue;
        var val = attrs[i].value;
        if (liveEl.getAttribute(name) !== val) {
          try { liveEl.setAttribute(name, val); } catch (e) {}
        }
      }
    }

    // ---- rich-text innerHTML sync (kind 'html') -------------------------------
    // A rich-text prop renders via <Fragment set:html={value}> into a LEAF
    // element's innerHTML (e.g. Heading's <h1>…<span class=custom-span>…</span>…).
    // Replacing that innerHTML is the only way to express a markup edit (a
    // text-node sync can't add/remove the span). Two guards keep it safe:
    //   1. NO stamped descendant (data-element-path) on either side — a component
    //      ROOT carries its internal stamped structure (+ JS state); only a
    //      content leaf holds purely server-owned set:html markup. (The set:html
    //      span itself is raw HTML, never a stamped meno node.)
    //   2. Element children present on at least one side — i.e. the content IS
    //      markup. A pure-text leaf (e.g. a JS-updated counter) has none and is
    //      left untouched here (syncText handles plain text), so an unrelated
    //      rich-text edit elsewhere can't clobber a JS-managed text node.
    // Replace only when the innerHTML actually differs.
    function syncHtml(liveEl, nextEl) {
      if (liveEl.querySelector('[data-element-path]')) return;
      if (nextEl.querySelector('[data-element-path]')) return;
      if (!liveEl.firstElementChild && !nextEl.firstElementChild) return;
      if (liveEl.innerHTML !== nextEl.innerHTML) liveEl.innerHTML = nextEl.innerHTML;
    }

    // Direction-aware structural gate for prop patches: a scalar prop can drive
    // a component-internal conditional/list the model classifier can't see. JS
    // only ever adds to the LIVE doc (embla loop clones), never to the fetched
    // SSR doc — so fetchedCount > liveCount (or an identity present only in the
    // fetched doc) means the server rendered MORE stamped elements than exist
    // live: a real structural change → reload. liveCount >= fetchedCount is
    // tolerated (clones / a shrunk list leave at worst a stale element).
    function identityCounts(scope) {
      var counts = {};
      var els = scope.querySelectorAll('[data-element-path]');
      for (var i = 0; i < els.length; i++) {
        var k = pairKey(els[i]);
        counts[k] = (counts[k] || 0) + 1;
      }
      return counts;
    }
    function structureDiverged(nextDoc) {
      var live = identityCounts(document);
      var next = identityCounts(nextDoc);
      for (var k in next) {
        if ((next[k] || 0) > (live[k] || 0)) return true;
      }
      return false;
    }

    // ---- entry point ----------------------------------------------------------
    function applyPatch(nextDoc, kinds, staleTokens, sheets) {
      // Clear optimistic inline previews FIRST: this patch carries the server's
      // authoritative styling (rebuilt utility sheet + define:vars inline), and
      // a lingering optimistic inline (specificity 1,0,0,0) would shadow it and
      // every future hover/responsive rule for that property. Restore each
      // touched element's pre-preview style attr; for paired elements
      // mergeInlineStyle re-applies the server's real inline later in this same
      // synchronous pass, so there is no flash and server inline is preserved.
      for (var oq = 0; oq < optimistic.length; oq++) {
        var o = optimistic[oq];
        if (o.original === null) o.el.removeAttribute('style');
        else o.el.setAttribute('style', o.original);
      }
      optimistic = [];
      // Drop the optimistic variable override too — applyPayloadSheets below swaps
      // in the regenerated theme.css with the real custom-property values.
      clearVarsPreview();
      var doStyle = kinds.indexOf('style') !== -1;
      var doText = kinds.indexOf('text') !== -1;
      var doAttrs = kinds.indexOf('attrs') !== -1;
      var doHtml = kinds.indexOf('html') !== -1;
      if (doStyle) {
        // syncSheets first (component sheets, etc.), then the authoritative utility
        // sheet + theme.css from the payload — payload wins over an empty/stale
        // fetched tag (the SSR HTML never carries the Vite-injected CSS; see above).
        syncSheets(nextDoc);
        applyPayloadSheets(sheets);
      }
      if (!doStyle && !doText && !doAttrs && !doHtml) return;
      var pairs = collectPairs(nextDoc);
      // Gate prop patches BEFORE any DOM mutation: a prop (scalar OR rich-text) can
      // drive a component-internal conditional/list — a STRUCTURAL change (stamped
      // element added/removed) the model diff can't see (e.g. a rich-text emptied
      // to the empty string removes a text-gated child component). A throw here
      // unwinds to the bridge's .catch(location.reload) with nothing half-applied.
      // A class or tag change is NOT structural: a prop edit rides kind 'style'
      // carrying the component's full class vocabulary as stale tokens, so
      // mergeClasses retires the old variant classes below (a 'size' change leaves
      // only a semantically-stale tag the updated class still styles correctly).
      if ((doAttrs || doHtml) && structureDiverged(nextDoc)) throw new Error('meno-play: structural prop change');
      var stale = {};
      for (var i = 0; i < staleTokens.length; i++) stale[staleTokens[i]] = true;
      for (var p = 0; p < pairs.length; p++) {
        // Class merge rides along for prop edits too (the plugin pushes 'style'
        // with the component vocabulary) so variant classes retire via stale.
        if (doStyle) mergeClasses(pairs[p][0], pairs[p][1], stale);
        // Inline style is property-granular and never drops live-only props, so
        // it is safe for both a style edit and a prop edit (a {{maxWidth}}-style
        // prop renders into the inline style attr).
        if (doStyle || doAttrs) mergeInlineStyle(pairs[p][0], pairs[p][1]);
        if (doText || doAttrs) syncText(pairs[p][0], pairs[p][1]);
        if (doAttrs) syncAttrs(pairs[p][0], pairs[p][1]);
        // Rich-text: replace the leaf's innerHTML (guarded inside syncHtml).
        if (doHtml) syncHtml(pairs[p][0], pairs[p][1]);
      }
    }
`;

/**
 * The injected head script: subscribe to {@link PLAY_PATCH_EVENT} through
 * Vite's own HMR client and apply targeted patches from a fresh fetch. Events
 * are debounced and coalesced (one editor save can sync several files, each
 * broadcasting — kinds union, staleTokens concatenate); fetches are
 * serialized. Any failure — non-OK response (the edit broke the page; the
 * reload surfaces Astro's error overlay), parse, or patch — falls back to a
 * stock full reload.
 */
export const PLAY_PATCH_BRIDGE_SCRIPT = `
if (window.self !== window.top) {
  (function () {
${XRAY_RESOLVER_JS}
${PATCH_JS}

    var timer = 0;
    var inflight = false;
    var queued = false;
    var pendingKinds = {};
    var pendingStale = {};
    var pendingSheets = {};

    // Opt-in diagnostics — flip WITHOUT any server/app change: in the preview
    // devtools run localStorage['meno:play:debug'] = '1' (or set
    // window.__MENO_PLAY_DEBUG = true), then reproduce. A 'astro/vite ...' line
    // means Astro/Vite sent the reload (hmr-reload swallow miss, dev-server
    // restart, or compile error); a 'bridge reload ...' line means this bridge
    // reloaded after a failed patch fetch/apply. See PLAY_DEBUG in playPatch.ts.
    var DBG = (function () {
      try { return !!(window.__MENO_PLAY_DEBUG || (window.localStorage && localStorage.getItem('meno:play:debug') === '1')); } catch (e) { return false; }
    })();
    function dbg() {
      if (!DBG || !window.console || !console.info) return;
      try { console.info.apply(console, ['[meno-play]'].concat([].slice.call(arguments))); } catch (e) {}
    }

    function takePending() {
      var kinds = [];
      var stale = [];
      var sheets = [];
      var k;
      for (k in pendingKinds) kinds.push(k);
      for (k in pendingStale) stale.push(k);
      for (k in pendingSheets) sheets.push({ match: k, css: pendingSheets[k] });
      pendingKinds = {};
      pendingStale = {};
      pendingSheets = {};
      return { kinds: kinds, stale: stale, sheets: sheets };
    }

    function refresh() {
      if (inflight) { queued = true; return; }
      var batch = takePending();
      if (!batch.kinds.length) return;
      inflight = true;
      fetch(window.location.href, { cache: 'no-store', headers: { accept: 'text/html' } })
        .then(function (res) {
          if (!res.ok) throw new Error('patch fetch failed: ' + res.status);
          return res.text();
        })
        .then(function (html) {
          applyPatch(new DOMParser().parseFromString(html, 'text/html'), batch.kinds, batch.stale, batch.sheets);
          inflight = false;
          if (queued) { queued = false; refresh(); }
        })
        .catch(function (e) {
          dbg('bridge reload (patch fetch/apply failed):', (e && e.message) || e);
          try { window.location.reload(); } catch (e2) {}
        });
    }

    function onPatch(data) {
      var i;
      var kinds = (data && data.kinds) || [];
      var stale = (data && data.staleTokens) || [];
      var sheets = (data && data.sheets) || [];
      for (i = 0; i < kinds.length; i++) pendingKinds[kinds[i]] = true;
      for (i = 0; i < stale.length; i++) pendingStale[stale[i]] = true;
      // Coalesce by match (last write wins) — one save can broadcast several sheets.
      for (i = 0; i < sheets.length; i++) {
        if (sheets[i] && sheets[i].match) pendingSheets[sheets[i].match] = sheets[i].css;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () { timer = 0; refresh(); }, 80);
    }

    // Optimistic style preview from the editor (window.postMessage, any origin —
    // same rationale as the X-Ray bridge: the editor origin varies web/Electron
    // and the payload only sets inline style on an already-resolved stamped
    // element, overwritten by the next real patch). resolveTarget rejects a
    // malformed path/chain (digits-and-commas only), so untrusted data can't
    // widen the query surface or touch an arbitrary element.
    window.addEventListener('message', function (ev) {
      var d = ev && ev.data;
      if (!d || d.type !== '${PLAY_STYLE_PREVIEW_EVENT}') return;
      var t = d.target;
      if (!t || typeof d.css !== 'string') return;
      var chain = [];
      if (Object.prototype.toString.call(t.chain) === '[object Array]') {
        for (var i = 0; i < t.chain.length; i++) chain.push(String(t.chain[i]));
      }
      applyOptimistic(
        {
          chain: chain,
          path: typeof t.path === 'string' ? t.path : '',
          item: typeof t.item === 'string' ? t.item : '',
          isComponent: !!t.isComponent,
        },
        d.css,
        typeof d.media === 'string' ? d.media : '',
      );
    });

    // Optimistic CSS-variable preview (window.postMessage, any origin — same
    // rationale as above; applyVarsPreview sanitizes names + values, so a global
    // :root override can't inject arbitrary CSS or break out of the declaration).
    window.addEventListener('message', function (ev) {
      var d = ev && ev.data;
      if (!d || d.type !== '${PLAY_VARS_PREVIEW_EVENT}') return;
      if (!d.vars || typeof d.vars !== 'object') return;
      applyVarsPreview(d.vars, typeof d.media === 'string' ? d.media : '');
    });

    // import.meta.hot is module-graph-only and a raw vite-hmr WebSocket is
    // token-gated in Vite 6+ — createHotContext on Vite's own client is the
    // supported way onto the established socket (reconnects included).
    import('/@vite/client')
      .then(function (m) {
        var hot = m.createHotContext('/__meno-play-patch');
        hot.on('${PLAY_PATCH_EVENT}', onPatch);
        // Diagnostics: these fire when ASTRO/VITE (not this bridge) reloads us.
        hot.on('vite:beforeFullReload', function (p) { dbg('astro/vite full-reload', (p && p.path) || '', p && p.triggeredBy ? '(triggeredBy ' + p.triggeredBy + ')' : ''); });
        hot.on('vite:ws:disconnect', function () { dbg('astro/vite ws disconnect — dev-server restart? (e.g. a project.config.json save)'); });
        hot.on('vite:error', function (p) { dbg('astro/vite compile error', (p && p.err && p.err.message) || ''); });
      })
      .catch(function () {});
  })();
}
`;
