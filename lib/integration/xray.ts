/**
 * Play-mode X-Ray support — element-path stamping + in-page selection overlay.
 *
 * In the editor's play mode the preview iframe points at the REAL Astro dev
 * server, which is cross-origin to the editor. The editor's same-origin X-Ray
 * overlay (studio XRayOverlay) can't measure that DOM, and the emitted `.astro`
 * markup deliberately carries none of the `data-element-path` markers Meno's
 * SSR engine stamps. Both halves are restored here, play mode only:
 *
 * 1. {@link xrayVitePlugin} — a `pre` vite transform that, for project source
 *    `.astro` files, parses the file with the dialect codec (span collection
 *    on) and splices identity attributes into each element's open tag,
 *    IN MEMORY at serve time (never on disk, never in deploy builds):
 *      - HTML elements / `<Link>` → `data-element-path="<path>"` where path is
 *        the node's logical tree path in the editor's selection space (root =
 *        `"0"`, child chains `"0,1,2"` — the same space meno-core's SSR
 *        `elementPath` uses, see ssrRenderer's `elementPath: [0]` seed).
 *        Paths are FILE-LOCAL: a component's elements carry paths into that
 *        component's own tree, not a page-expanded rendered path.
 *      - Component instance tags → `data-meno-instance="<path>"` (a prop —
 *        forwarded to real DOM by the component-root splice below).
 *      - A component file's root element additionally gets
 *        `data-meno-instance={Astro.props['data-meno-instance']}` so the
 *        instance identity passed at each usage site lands on the instance's
 *        rendered root element (Astro omits the attribute when the prop is
 *        absent, i.e. always in deploy builds).
 *
 * 2. {@link PLAY_XRAY_BRIDGE_SCRIPT} — an injected head script (same delivery
 *    as the navigation bridge) that listens for `meno:astro:xray` messages from
 *    the embedding editor and renders selection/hover borders INSIDE the page.
 *    Drawing in-page sidesteps every cross-origin problem: scroll, resize and
 *    soft navigations stay correct natively, with no rect streaming back to
 *    the parent. Cross-file targets resolve structurally: the editor sends the
 *    chain of instance paths from its component-editing navigation stack, and
 *    the bridge scopes each step to the previous instance's rendered subtree.
 *
 *    The same script also implements click-to-select: while the editor's xray
 *    message carries `selectMode: true`, clicks are captured (preventDefault —
 *    links must not navigate while selecting, mirroring the SSR canvas), the
 *    clicked element is resolved to its `{ chain, path }` identity by walking
 *    instance roots upward (HOP vs SKIP decided exactly via SLOT_ATTR — see
 *    its doc), and the identity is posted back as `meno:astro:select`
 *    (`meno:astro:hover` for mouseover, null path on leave; `meno:astro:open`
 *    for double-clicks — the editor's drill gesture: enter the clicked
 *    component's definition, or exit one level when the double-click lands on
 *    content owned by an outer file, mirroring the SSR canvas dblclick).
 *    Selects also carry `alt` (the click's Option/Alt state) — the editor's
 *    deep-drill gesture: drill through every component layer down to the
 *    exact clicked node, mirroring the SSR canvas Alt+click. While Alt is
 *    held the bridge additionally draws a deep-hover preview box on the
 *    exact stamped element under the cursor, entirely bridge-locally (the
 *    SSR canvas's alt-hover); normal hover posting is unchanged.
 *    Clicks with NO stamped ancestor post a null-path select, which exits
 *    component editing when the editor is drilled in (the SSR canvas's
 *    click-outside-component check). The EDITOR maps the identity into its
 *    current tree space and drives selection state; the border then comes
 *    back through the normal xray-targets flow.
 *
 * List copies (CMS or prop lists) are disambiguated WITHOUT extra stamping:
 * copies of an item template are siblings carrying identical identity
 * attributes, so their occurrence position IS the item index. The resolver
 * computes a dot-joined per-level item path on the ancestor walk (the play
 * twin of SSR's `data-cms-item-index`), identify() reports it on
 * click/hover, targets carry it back, and resolveTarget() picks the matching
 * copy (exact, then SSR-style prefix-lenient, else hidden).
 *
 * Known gaps (accepted for v1): `<Embed>` nodes are not stamped (stamping
 * would force Embed's optional wrapper `<div>` into existence and change the
 * play DOM vs deploy); drilling INTO a specific list copy isn't tracked —
 * while editing a component the borders anchor to the first rendered copy
 * (the editor's navigationHistory cmsItemContext has no bridge counterpart).
 */

import { readFileSync } from 'node:fs';
import { parseFile } from '../dialect/parse/parseFile';
import type { NodeSpan } from '../dialect/parse/parseContext';
import { rewriteViewportUnitsInStylesheet } from './viewportUnits';

/** `message` event `data.type` the editor posts X-Ray targets with. */
export const PLAY_XRAY_MESSAGE_TYPE = 'meno:astro:xray';

/**
 * Inbound `data.type` the editor posts to scroll a node into view (editor →
 * bridge). Carries `{ target: { chain, path, item, isComponent } }` — the same
 * identity shape the X-Ray targets use. The editor's own scrollElementIntoView
 * can't reach this frame (cross-origin: reading contentDocument throws), so the
 * editor sends the identity and the bridge resolves + scrolls in-page. Posted
 * only for structure-tree selections (canvas clicks already show the element),
 * mirroring the SSR canvas's `source === 'tree'` scroll gate.
 */
export const PLAY_SCROLL_MESSAGE_TYPE = 'meno:astro:scroll-to';

/**
 * Outbound `data.type` for canvas clicks while select mode is on (bridge →
 * editor). Carries the clicked element's `{ chain, path }` identity, or a
 * null `path` when the click had no stamped ancestor (page background/chrome)
 * — which the editor, while drilled into a component, treats as the SSR
 * canvas's click-outside-component: exit one editing level. Also carries
 * `alt` (boolean — the click's Option/Alt state): `true` switches the editor
 * to the SSR canvas's Alt+click deep drill — reset to the root page, enter
 * every component layer the chain names, select the exact clicked node.
 */
export const PLAY_SELECT_MESSAGE_TYPE = 'meno:astro:select';

/** Outbound `data.type` for canvas hovers while select mode is on (bridge → editor). */
export const PLAY_HOVER_MESSAGE_TYPE = 'meno:astro:hover';

/**
 * Outbound `data.type` for double-clicks while select mode is on (bridge →
 * editor). Same `{ chain, path }` identity as a select; the editor applies the
 * SSR canvas's dblclick semantics: enter the clicked component's definition
 * (component internals → first un-entered instance), or exit one editing level
 * when the identity belongs to an outer file (slot content / outside the
 * drilled component).
 */
export const PLAY_OPEN_MESSAGE_TYPE = 'meno:astro:open';

/**
 * Outbound `data.type` for keyboard events forwarded from the play page
 * (bridge → editor). The editor re-dispatches them as synthetic KeyboardEvents
 * on its own document, so EVERY editor shortcut (copy, command palette,
 * undo/redo, tree navigation, …) works while focus sits inside the
 * cross-origin play iframe — the same coverage the same-origin SSR preview
 * gets from installKeydownOnEditorDocuments, which can't reach this frame.
 */
export const PLAY_KEY_MESSAGE_TYPE = 'meno:astro:key';

/**
 * Pinned comments ride the same X-Ray bridge (one in-page script owns identity
 * resolution + the rAF loop). Editor → bridge: `comment-mode` carries the mode
 * plus each visible comment's identity target. Bridge → editor: `comment-rects`
 * streams the resolved element rects keyed by comment id (CommentsOverlay draws
 * the pins); `comment-place` posts a clicked element's identity in add mode so
 * the editor anchors a new pin to that node.
 */
export const PLAY_COMMENT_MODE_MESSAGE_TYPE = 'meno:astro:comment-mode';
export const PLAY_COMMENT_RECTS_MESSAGE_TYPE = 'meno:astro:comment-rects';
export const PLAY_COMMENT_PLACE_MESSAGE_TYPE = 'meno:astro:comment-place';

/** The prop/attribute carrying a component instance's path at its usage site. */
export const INSTANCE_ATTR = 'data-meno-instance';

/**
 * The prop/attribute marking slot content: present on every stamped element
 * whose markup sits inside a component instance's tag IN ITS OWN FILE, valued
 * with that enclosing instance's (file-local) path. Click identity resolution
 * needs it because DOM nesting lies about file ownership — a page's
 * `<section>` slotted into `<Layout>` is a DOM descendant of Layout's root,
 * but its data-element-path is page-space. The bridge's upward walk uses
 * `slot(carrier) === inst(root)` as the exact "this root is not a file hop"
 * test (a path-prefix heuristic would misattribute every component-internal
 * element whose local path shares the instance's prefix).
 */
export const SLOT_ATTR = 'data-meno-slot';

type Node = Record<string, unknown>;

/** Node types whose open tag renders (or forwards onto) a real DOM element. */
const STAMPABLE_TYPES = new Set(['node', 'link']);

/**
 * Node types that are opaque to Meno — an island (`<Counter client:* />`) or a
 * custom `.astro` black box (`<Fancy />`). Their open tag is a *component*
 * invocation, so a spliced `data-element-path` would land on `Astro.props`, not
 * on any DOM element (Astro never forwards unknown attributes to a component's
 * rendered root). They can't forward identity the way Meno components do either
 * (no Meno-controlled root). So instead of stamping their tag we WRAP them in a
 * `display:contents` element that carries the path — a real, click-resolvable
 * DOM ancestor with zero layout footprint. Play-only (serve-time); the on-disk
 * `.astro` and real builds never see it.
 */
const WRAPPABLE_TYPES = new Set(['island', 'custom']);

/** The serve-time wrapper element name for {@link WRAPPABLE_TYPES} nodes. */
const XRAY_WRAP_TAG = 'meno-x';

/** The tracked root node of a parsed model: a page's `root` or a component's `structure`. */
function rootNode(model: Record<string, unknown>): Node | undefined {
  const component = model.component as Record<string, unknown> | undefined;
  const candidate = component ? component.structure : model.root;
  return candidate && typeof candidate === 'object' ? (candidate as Node) : undefined;
}

/**
 * Stamp X-Ray identity attributes into a `.astro` source (see module doc).
 * Pure string-splicing against parser-recorded spans — the surrounding source
 * (frontmatter, verbatim code, formatting) is preserved byte-for-byte. Returns
 * the source unchanged when it can't be parsed or nothing is stampable
 * (best-effort, never throws).
 */
export function stampElementPaths(source: string): string {
  try {
    const { model, spans } = parseFile(source, { collectSpans: true });
    if (!spans || spans.size === 0) return source;
    const root = rootNode(model);
    if (!root) return source;
    const isComponentFile = !!model.component;

    const splices: Array<{ pos: number; text: string }> = [];

    // Locate the open tag inside `span` and queue `text` for insertion right
    // after the tag name. Spans of `{cond && (<div…>)}` wrappers start at `{`,
    // so scan for the first `<` that begins a tag (letter follows — a bare
    // `<` inside a JS comparison doesn't qualify). Mirrors the parser's
    // readTagName charset so the insertion point is exactly where the
    // attribute list starts.
    const stampAt = (span: NodeSpan, text: string): void => {
      let i = span.start;
      while (i < span.end && !(source[i] === '<' && /[A-Za-z]/.test(source[i + 1] ?? ''))) i++;
      if (i >= span.end) return;
      let j = i + 1;
      while (j < span.end && /[A-Za-z0-9.\-_]/.test(source[j] ?? '')) j++;
      splices.push({ pos: j, text });
    };

    // Wrap an opaque island/custom node (WRAPPABLE_TYPES) in a `display:contents`
    // element carrying its path. Wrapping the WHOLE span — not the inner tag —
    // is correct for both shapes the parser records: a plain element's span is
    // exactly `<Tag …/>`, so this becomes `<meno-x …><Tag/></meno-x>`; an
    // `if`-wrapped element's span is the whole `{cond && (<Tag/>)}`, so it
    // becomes `<meno-x …>{cond && (<Tag/>)}</meno-x>` (wrapper always present,
    // the node conditional inside — still valid markup). `display:contents`
    // keeps it out of layout; the bridge unions descendants for its rect.
    const wrapAt = (span: NodeSpan, key: string, slotStamp: string): void => {
      splices.push({
        pos: span.start,
        text: `<${XRAY_WRAP_TAG} data-element-path="${key}"${slotStamp} style="display:contents">`,
      });
      splices.push({ pos: span.end, text: `</${XRAY_WRAP_TAG}>` });
    };

    // `slotOwner`: the (file-local) path of the nearest enclosing component
    // instance node — i.e. this subtree is that instance's slot content. Set
    // when recursing into a component node's children, inherited until a
    // deeper component node overrides it. Stamped as SLOT_ATTR so the click
    // bridge can tell slot content (same file as the instance tag) apart from
    // component-internal markup (see SLOT_ATTR doc).
    const walk = (node: Node, key: string, slotOwner: string | null): void => {
      const span = spans.get(node);
      const slotStamp = slotOwner ? ` ${SLOT_ATTR}="${slotOwner}"` : '';
      if (span) {
        const type = node.type;
        if (type === 'component') {
          if (isComponentFile && node === root) {
            // Stacked root: this component's root IS another instance (e.g.
            // every section component wrapping itself in <Section>). The one
            // rendered root element must then represent BOTH file transitions
            // — the outer usage site's and this root instance's — so append
            // our hop to whatever identity arrives from outside, building a
            // `;`-separated outer→inner hop list (composes recursively: a
            // deeper stacked root appends again). The slot list stays
            // parallel; a root tag is never slot content, so its own entry
            // is always empty.
            stampAt(
              span,
              ` ${INSTANCE_ATTR}={[Astro.props['${INSTANCE_ATTR}'], '${key}'].filter((v) => v != null).join(';')}` +
                ` ${SLOT_ATTR}={Astro.props['${INSTANCE_ATTR}'] == null ? '' : (Astro.props['${SLOT_ATTR}'] ?? '') + ';'}`,
            );
          } else {
            // Instance tag: both paths become props, forwarded to the
            // component's root element by the root splices below.
            stampAt(span, ` ${INSTANCE_ATTR}="${key}"${slotStamp}`);
          }
        } else if (typeof type === 'string' && STAMPABLE_TYPES.has(type)) {
          stampAt(span, ` data-element-path="${key}"${slotStamp}`);
          if (isComponentFile && node === root) {
            // Forward the usage site's instance path + slot status onto the
            // rendered root (both omitted by Astro when the props are absent).
            stampAt(
              span,
              ` ${INSTANCE_ATTR}={Astro.props['${INSTANCE_ATTR}']} ${SLOT_ATTR}={Astro.props['${SLOT_ATTR}']}`,
            );
          }
        } else if (typeof type === 'string' && WRAPPABLE_TYPES.has(type)) {
          // Islands / custom `.astro`: can't stamp the component tag, so wrap it
          // in a path-carrying `display:contents` element (see WRAPPABLE_TYPES).
          wrapAt(span, key, slotStamp);
        }
      }
      const children = node.children;
      if (Array.isArray(children)) {
        const childOwner = node.type === 'component' ? key : slotOwner;
        children.forEach((child, i) => {
          if (child && typeof child === 'object') walk(child as Node, `${key},${i}`, childOwner);
        });
      }
    };

    // Root key "0": the editor's logical selection paths (and SSR's
    // data-element-path) seed the root at [0], unlike the line-map's "" key.
    walk(root, '0', null);

    if (splices.length === 0) return source;
    // Apply back-to-front so earlier positions stay valid. Equal positions
    // (root element's two attributes) both land after the tag name.
    splices.sort((a, b) => b.pos - a.pos);
    let out = source;
    for (const s of splices) out = out.slice(0, s.pos) + s.text + out.slice(s.pos);
    return out;
  } catch {
    return source;
  }
}

/**
 * Vite plugin (registered in play mode only) that applies
 * {@link stampElementPaths} to the project's own `.astro` sources before
 * Astro's compiler sees them, and pins viewport units in the design canvas by
 * rewriting the EXTRACTED style CSS (see the `transform` hook). The filter
 * keeps both off meno-astro's shipped components and anything outside the
 * project's `src/` (Link/Embed forward attributes via their existing `...rest`
 * spreads and need no stamping of their own).
 *
 * Stamping happens in a `load` hook, NOT `transform`: Astro's compiler plugin
 * (`astro:build`) is itself `enforce: 'pre'` and ordered ahead of
 * integration-supplied plugins, so by the time any later transform runs the
 * code is already compiled JS (stampElementPaths would fail its parse and
 * silently no-op). `load` runs strictly before every transform; Astro's own
 * `load` only claims `?astro` virtual sub-requests, so raw `.astro` paths
 * fall through here, we read + stamp the source, and the compiler receives
 * the stamped markup. HMR keeps working — Astro reloads changed files through
 * the plugin container, which re-enters this hook.
 *
 * Viewport-unit pinning, by contrast, runs in `transform` and ONLY touches the
 * CSS Vite actually serves (the `…?astro&type=style…lang.css` sub-modules
 * Astro extracts each `<style>` block into). It deliberately does NOT rewrite
 * the raw `.astro` `<style>` in the `load` hook above: mutating a component's
 * `<style>` from a `pre` load desyncs Astro's per-component style virtual
 * module and full-reloads the page in a tight loop (only bites projects with
 * hand-authored `vh`/`vw` in a `<style>`). Rewriting the extracted CSS keeps
 * the pin inside Vite's normal CSS pipeline — `calc(var(--design-vh, …))`
 * flows through PostCSS and HMRs as CSS, in sync — mirroring core's
 * render-time rewrite (htmlGenerator/StyleInjector apply it to the produced
 * CSS, never via a source hook). The `--design-vh` var fallback keeps
 * select-mode / page-mode / deploy byte-identical.
 */
export function xrayVitePlugin(projectRoot: string): Record<string, unknown> {
  const srcRoot = `${projectRoot.replace(/\\/g, '/').replace(/\/$/, '')}/src/`;
  // Hand-authored custom `.astro` components are OPAQUE black boxes — Meno
  // doesn't model their internals, so they must stay unstamped. Stamping them
  // would put `data-element-path` on their inner elements, which then shadow the
  // `<meno-x>` wrapper Meno splices around the usage site: a click inside the
  // component resolves to a Custom-file-local path that maps to nothing in the
  // editor tree (and never reaches the wrapper). The usage site IS selectable
  // via that wrapper (stamped at the page/component that places the custom tag);
  // the component body is not. (Islands dodge this for free — their source is
  // `.tsx/.jsx/.vue/.svelte`, which this `.astro`-only hook never touches.)
  const customRoot = `${srcRoot}custom/`;
  return {
    name: 'meno-astro:xray-paths',
    enforce: 'pre',
    load(id: string) {
      // Only the raw `.astro` module (style/script sub-requests carry queries).
      if (!id.endsWith('.astro') || id.includes('?')) return null;
      const normalized = id.replace(/\\/g, '/');
      if (normalized.includes('/node_modules/') || !normalized.startsWith(srcRoot)) return null;
      // Never stamp opaque custom components (see customRoot doc above).
      if (normalized.startsWith(customRoot)) return null;
      let source: string;
      try {
        source = readFileSync(id, 'utf-8');
      } catch {
        return null; // let Vite's default fs loader produce the real error
      }
      // Stamp element paths (template attributes) only — in-memory, serve-time,
      // the on-disk .astro is never touched. Viewport units are handled in
      // `transform` below (NOT here — see the function doc).
      const stamped = stampElementPaths(source);
      return stamped === source ? null : { code: stamped, map: null };
    },
    transform(code: string, id: string) {
      // Astro extracts every `.astro` <style> block into a virtual CSS module
      // (`…/X.astro?astro&type=style&index=N&lang.css`). Pin viewport units on
      // THAT served CSS so the design canvas's --design-vh pinning takes hold
      // on hand-authored <style> too, without the load-hook reload loop (see
      // the function doc). A pre transform here runs after Astro's load (which
      // produced the CSS) and before Vite's own CSS pipeline.
      if (!id.includes('astro&type=style')) return null;
      const normalized = (id.split('?', 1)[0] ?? '').replace(/\\/g, '/');
      if (normalized.includes('/node_modules/') || !normalized.startsWith(srcRoot)) return null;
      const rewritten = rewriteViewportUnitsInStylesheet(code);
      return rewritten === code ? null : { code: rewritten, map: null };
    },
  };
}

/**
 * The identity resolver shared by both directions of the bridge — injected
 * into {@link PLAY_XRAY_BRIDGE_SCRIPT} verbatim and unit-testable by
 * evaluating this string against a (happy-)DOM.
 *
 * SSR lesson baked in: the same-origin engine never disagrees with itself
 * because ONE canonical address (the editor-computed rendered path) drives
 * both selection and drawing. Early bridge versions used two algorithms —
 * an upward slot-aware walk for clicks and a separate descend for borders —
 * and they disagreed exactly where the rules were subtle (stacked roots,
 * slot content, file-local path collisions: a border could land on an
 * unrelated element whose LOCAL path merely matched). Now `identify()` is
 * the only identity algorithm, and `resolveTarget()` is defined as its
 * inverse: the first element (document order) whose identity equals the
 * target. Draw and click can no longer diverge.
 *
 * Functions close over `document`, so tests can evaluate the string with
 * `new Function('document', …)` against a synthetic DOM.
 */
export const XRAY_RESOLVER_JS = `
    var KEY_RE = /^[0-9]+(,[0-9]+)*$/;

    // An instance-root element's hop list, outer→inner. Components whose root
    // is itself an instance render ONE element for several file transitions —
    // the stamper encodes the stack as ';'-separated paths ("0,0;0").
    function instList(el) {
      return (el.getAttribute('${INSTANCE_ATTR}') || '').split(';');
    }
    // Parallel slot-status list (slot of each hop's TAG in its own file).
    // Left-pad: missing outer entries mean "not slot content".
    function slotList(el, len) {
      var slots = (el.getAttribute('${SLOT_ATTR}') || '').split(';');
      while (slots.length < len) slots.unshift('');
      return slots;
    }

    // Accumulate the hop chain from instance root \`r\` upward to the page.
    // At each hop decide HOP vs SKIP via the slot attribute: the carrier's
    // markup is slot content of that hop's instance tag (same file — SKIP)
    // iff its slot status equals the hop's path. Stacked roots contribute
    // several hops from one element, processed inner→outer with the parallel
    // slot list providing each intermediate tag's status. Returns null on
    // malformed attributes.
    function walkChain(r, carrierSlot) {
      var chain = [];
      while (r) {
        var hops = instList(r);
        var slots = slotList(r, hops.length);
        for (var i = hops.length - 1; i >= 0; i--) {
          if (!KEY_RE.test(hops[i])) return null;
          if (carrierSlot !== hops[i]) chain.unshift(hops[i]);
          carrierSlot = slots[i];
        }
        r = r.parentElement ? r.parentElement.closest('[${INSTANCE_ATTR}]') : null;
      }
      return chain;
    }

    // List-copy disambiguation — the play twin of SSR's data-cms-item-index.
    // A list renders its item template N times: N siblings carrying IDENTICAL
    // identity attributes. The occurrence position among those copies is the
    // item index; nothing needs to be stamped because the DOM itself encodes
    // it. itemIndexOf: this element's position among its same-identity
    // siblings, or -1 when it has no copies (not a repeated list item).
    function itemIndexOf(el) {
      var p = el.parentElement;
      if (!p) return -1;
      var path = el.getAttribute('data-element-path');
      var inst = el.getAttribute('${INSTANCE_ATTR}');
      var slot = el.getAttribute('${SLOT_ATTR}');
      var total = 0, mine = -1;
      for (var c = p.firstElementChild; c; c = c.nextElementSibling) {
        if (
          c.getAttribute('data-element-path') === path &&
          c.getAttribute('${INSTANCE_ATTR}') === inst &&
          c.getAttribute('${SLOT_ATTR}') === slot
        ) {
          if (c === el) mine = total;
          total++;
        }
      }
      return total > 1 ? mine : -1;
    }

    // Dot-joined occurrence indices (outermost first) of every repeated list
    // copy on the element's ancestor walk — "2" for item #2, "1.0" for inner
    // item #0 of outer item #1. '' when no list is involved. Same dot-path
    // semantics as SSR's data-cms-item-index attribute.
    function itemPathOf(start) {
      var parts = [];
      var t = start && start.closest ? start.closest('[data-element-path]') : null;
      while (t) {
        var i = itemIndexOf(t);
        if (i >= 0) parts.unshift(String(i));
        t = t.parentElement ? t.parentElement.closest('[data-element-path]') : null;
      }
      return parts.join('.');
    }

    // SSR's matchesCMSItemIndexPath, ported: nothing wanted or nothing
    // carried matches anything; exact match; an element carrying FEWER
    // levels matches when they prefix the wanted path (the candidate is an
    // outer container — e.g. a component instance whose inner-list level the
    // editor captured from a descendant).
    function matchesItem(cand, want) {
      if (!want || !cand) return true;
      if (cand === want) return true;
      var cp = cand.split('.');
      var wp = want.split('.');
      if (cp.length >= wp.length) return false;
      for (var i = 0; i < cp.length; i++) {
        if (cp[i] !== wp[i]) return false;
      }
      return true;
    }

    // Pick the right copy among identity-equal candidates: exact item-path
    // match first, then SSR's lenient prefix pass; null otherwise (a hidden
    // border is strictly better than one on the wrong copy). No wanted item
    // → first candidate in document order (pre-list behavior).
    function pickByItem(cands, want) {
      if (!cands.length) return null;
      if (!want) return cands[0];
      var k;
      for (k = 0; k < cands.length; k++) {
        if (itemPathOf(cands[k]) === want) return cands[k];
      }
      for (k = 0; k < cands.length; k++) {
        if (matchesItem(itemPathOf(cands[k]), want)) return cands[k];
      }
      return null;
    }

    // Component targets: the wanted item path may describe a DESCENDANT inside
    // the instance — the editor collapses a deep hover/select up to an
    // un-entered component but carries the deepest element's item path (the
    // list child it started from, e.g. hovering "LEVEL 01" inside a section's
    // levels list). The instance border must land on the instance ROOT, never a
    // list child within it. So pick the SHALLOWEST (first in document order —
    // ancestors precede descendants) candidate whose OWN item path CONTAINS the
    // wanted one (equal, or an outer prefix via matchesItem). The play twin of
    // the SSR canvas dropping CMS context when the resolved node sits above the
    // list (elementClickHandler's isInsideCMSList gate). A genuine list-copy
    // instance still disambiguates: only the matching copy's own index prefixes
    // the wanted path, so its sibling copies are skipped. Unlike pickByItem
    // there is NO exact-match-first pass — that pass is exactly what pulled the
    // border onto the matching inner copy instead of the containing instance.
    function pickContainer(cands, want) {
      for (var k = 0; k < cands.length; k++) {
        if (matchesItem(itemPathOf(cands[k]), want)) return cands[k];
      }
      return null;
    }

    // Resolve a DOM element to its editor identity: the instance-path chain
    // from the page file down to the element's owning file, the element's
    // file-local path, and its list-copy item path.
    function identify(start) {
      var t = start && start.closest ? start.closest('[data-element-path]') : null;
      if (!t) return null;
      var path = t.getAttribute('data-element-path');
      if (!KEY_RE.test(path)) return null;
      // A component-file root element is never slot content, so when t itself
      // is an instance root its own status is '' and its hop list is
      // processed first (closest() below includes self).
      var carrierSlot = t.hasAttribute('${INSTANCE_ATTR}')
        ? ''
        : (t.getAttribute('${SLOT_ATTR}') || '');
      var chain = walkChain(t.closest('[${INSTANCE_ATTR}]'), carrierSlot);
      if (!chain) return null;
      return { chain: chain, path: path, item: itemPathOf(t) };
    }

    // identify()'s inverse: the first element (document order — ancestors
    // precede descendants, so the shallowest stacked root wins) whose
    // identity equals the target, copy-disambiguated by the target's item
    // path. No document-order fallback on mismatch: a hidden border is
    // strictly better than one on the wrong element.
    function resolveTarget(t, scope) {
      scope = scope || document;
      if (!KEY_RE.test(t.path)) return null;
      for (var v = 0; v < t.chain.length; v++) {
        if (!KEY_RE.test(t.chain[v])) return null;
      }
      var wantItem = typeof t.item === 'string' ? t.item : '';
      var cands = [];
      if (t.isComponent) {
        // The instance's rendered root: hop chain = target chain + the
        // instance itself; a stacked root may carry further inner hops
        // (its wrapper), hence prefix-at-hop-boundary matching.
        var want = t.chain.concat([t.path]).join(';');
        var roots = scope.querySelectorAll('[${INSTANCE_ATTR}]');
        for (var k = 0; k < roots.length; k++) {
          var chain = walkChain(roots[k], '');
          if (!chain) continue;
          var key = chain.join(';');
          if (key === want || key.indexOf(want + ';') === 0) cands.push(roots[k]);
        }
        return pickContainer(cands, wantItem);
      }
      var wantChain = t.chain.join(';');
      // Valueless query + getAttribute compare: comma-bearing paths inside a
      // quoted attribute selector are valid CSS, but not every selector
      // engine agrees — and this sidesteps escaping concerns entirely.
      var els = scope.querySelectorAll('[data-element-path]');
      for (var m = 0; m < els.length; m++) {
        if (els[m].getAttribute('data-element-path') !== t.path) continue;
        var id = identify(els[m]);
        if (id && id.chain.join(';') === wantChain) cands.push(els[m]);
      }
      return pickByItem(cands, wantItem);
    }
`;

/**
 * The in-page scroll helper — injected into {@link PLAY_XRAY_BRIDGE_SCRIPT}
 * verbatim and unit-testable the same way as {@link XRAY_RESOLVER_JS} (eval the
 * string against fake `window` + `document`).
 *
 * Unlike studio's same-origin scrollDocumentToElement (which uses block
 * 'nearest'), the play frame is the REAL astro dev server: it lays a node out at
 * a slightly different absolute Y than core's SSR canvas (real fonts/images/CSS,
 * async settling), so a 'nearest' bottom-align lands the node a touch lower than
 * core for the same tree click. We instead top-align with a small gap — a
 * deterministic landing immune to that drift: scroll ONLY the page window (never
 * intermediate overflow containers) so the node's top sits {@link SCROLL_TOP_GAP}
 * below the viewport top, or below a sticky/fixed header when one is stuck there.
 * Skips entirely when the node is already comfortably in view, so re-selecting a
 * visible sibling doesn't jolt the page. Closes over `window`/`document`, so
 * tests can inject stubs.
 */
export const XRAY_SCROLL_JS = `
    var SCROLL_TOP_GAP = 24;

    // Bottom edge (viewport px) of the topmost sticky/fixed header stuck at the
    // top of the page, 0 when there is none. Reuses the design bridge's
    // fixed/sticky test (designBridge.ts measureContentBottom); a cheap
    // top-row hit-test at a few x's catches a centered logo or an offset nav.
    function stuckHeaderBottom() {
      if (!document.elementsFromPoint) return 0;
      var w = window.innerWidth || 0;
      var xs = [w * 0.5, w * 0.1, w * 0.9];
      var bottom = 0;
      for (var i = 0; i < xs.length; i++) {
        var els = document.elementsFromPoint(xs[i], 1) || [];
        for (var j = 0; j < els.length; j++) {
          var pos = window.getComputedStyle(els[j]).position;
          if (pos !== 'fixed' && pos !== 'sticky') continue;
          var r = els[j].getBoundingClientRect();
          if (r.top <= 1 && r.bottom > bottom) bottom = r.bottom;
        }
      }
      return bottom;
    }

    function scrollWindowToElement(el) {
      var r = el.getBoundingClientRect();
      var viewH = window.innerHeight;
      var inset = stuckHeaderBottom() + SCROLL_TOP_GAP;
      // Already comfortably in view (top below the inset, bottom above the
      // fold) — leave it; a node taller than the viewport still scrolls so its
      // top shows below the inset.
      if (r.top >= inset && r.bottom <= viewH) return;
      var targetY = window.scrollY + r.top - inset;
      if (targetY < 0) targetY = 0;
      window.scrollTo({ left: window.scrollX, top: targetY, behavior: 'smooth' });
    }
`;

/**
 * The injected head script rendering X-Ray borders in-page. Visual parity with
 * the studio's XRayOverlay: 1px border (components green #01a256, nodes blue
 * #007cee), selected at full opacity / hovered at 0.5 (label always full),
 * label chip above the top-left corner, 10% fill on hovered components. While
 * Alt is held in select mode a deep-hover preview box (blue 1px at FULL
 * opacity, no label/fill — XRayOverlay's alt-hover style) tracks the exact
 * stamped element under the cursor, drawn bridge-locally with no editor round
 * trip; Alt keydown/keyup re-evaluates it in place for a stationary cursor.
 *
 * Inbound messages are accepted from any origin — same rationale as the
 * navigation bridge's `targetOrigin: '*'`: the editor's origin varies
 * (web/Electron) and the payload only ever draws a non-interactive overlay.
 * Paths are validated against a digits-and-commas shape before being placed
 * into selectors, so untrusted data never expands the query surface.
 *
 * Element references re-resolve lazily: a rAF loop runs while targets exist,
 * re-querying whenever the cached element left the document (HMR, soft
 * navigation) and repositioning from getBoundingClientRect each frame.
 */
export const PLAY_XRAY_BRIDGE_SCRIPT = `
if (window.self !== window.top) {
  (function () {
    var GREEN = '#01a256', BLUE = '#007cee';
    var targets = [];
    var container = null;
    var raf = 0;
    var selectMode = false;
    var lastHoverKey = null;
    // Alt deep-hover preview: the exact stamped element under the cursor while
    // Alt is held (XRayOverlay's alt-hover twin), its dedicated box, and the
    // last mouseover target so Alt keydown/keyup with a stationary cursor can
    // re-evaluate the preview in place.
    var altBox = null;
    var altHoverEl = null;
    var lastMouseTarget = null;

    function post(msg) {
      try { window.parent.postMessage(msg, '*'); } catch (e) {}
    }

    function ensureContainer() {
      if (container && container.isConnected) return container;
      if (!document.body) return null;
      container = document.createElement('div');
      container.setAttribute('data-meno-xray', '');
      container.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
      // Alt deep-hover preview box, always child 0 — the recycled target
      // boxes start at index 1. Blue 1px at full opacity, no label/fill
      // (XRayOverlay draws its alt-hover with exactly this style).
      altBox = document.createElement('div');
      altBox.style.cssText = 'position:absolute;pointer-events:none;display:none;box-sizing:border-box;border:1px solid ' + BLUE + ';';
      container.appendChild(altBox);
      document.body.appendChild(container);
      return container;
    }

${XRAY_RESOLVER_JS}
${XRAY_SCROLL_JS}

    function makeBox() {
      var box = document.createElement('div');
      box.style.cssText = 'position:absolute;pointer-events:none;display:none;';
      var border = document.createElement('div');
      border.style.cssText = 'position:absolute;inset:0;box-sizing:border-box;';
      box.appendChild(border);
      var fill = document.createElement('div');
      fill.style.cssText = 'position:absolute;inset:0;opacity:0.1;display:none;';
      box.appendChild(fill);
      var label = document.createElement('div');
      label.style.cssText = 'position:absolute;top:-16px;left:0;font-size:11px;line-height:16px;padding:0 6px;white-space:nowrap;font-weight:400;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:none;';
      box.appendChild(label);
      return box;
    }

    // Bounding rect of a resolved target. Islands / custom nodes are anchored to
    // a 'display:contents' wrapper (see WRAPPABLE_TYPES) which generates no box of
    // its own — getBoundingClientRect returns an empty rect. Fall back to the
    // union of the wrapper's rendered descendants so the highlight still draws,
    // mirroring studio's XRayOverlay.
    function rectOf(el) {
      var r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) return r;
      var kids = el.querySelectorAll('*');
      var left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity, found = false;
      for (var i = 0; i < kids.length; i++) {
        var kr = kids[i].getBoundingClientRect();
        if (kr.width === 0 && kr.height === 0) continue;
        found = true;
        if (kr.left < left) left = kr.left;
        if (kr.top < top) top = kr.top;
        if (kr.right > right) right = kr.right;
        if (kr.bottom > bottom) bottom = kr.bottom;
      }
      return found ? { left: left, top: top, width: right - left, height: bottom - top } : r;
    }

    function frame() {
      raf = 0;
      var c = ensureContainer();
      if (c) {
        while (c.children.length < targets.length + 1) c.appendChild(makeBox());
        while (c.children.length > targets.length + 1) c.removeChild(c.lastChild);
        for (var i = 0; i < targets.length; i++) {
          var t = targets[i];
          if (!t.el || !t.el.isConnected) t.el = resolveTarget(t);
          var box = c.children[i + 1];
          if (!t.el) { box.style.display = 'none'; continue; }
          var r = rectOf(t.el);
          var color = t.isComponent ? GREEN : BLUE;
          var selected = t.kind === 'selected';
          box.style.display = 'block';
          box.style.left = r.left + 'px';
          box.style.top = r.top + 'px';
          box.style.width = r.width + 'px';
          box.style.height = r.height + 'px';
          var border = box.children[0];
          border.style.border = '1px solid ' + color;
          border.style.opacity = selected ? '1' : '0.5';
          var fill = box.children[1];
          fill.style.display = t.isComponent && !selected ? 'block' : 'none';
          fill.style.backgroundColor = color;
          var label = box.children[2];
          if (t.label) {
            label.style.display = 'block';
            label.textContent = t.label;
            label.style.backgroundColor = selected ? color : 'transparent';
            label.style.color = selected ? '#fff' : color;
          } else {
            label.style.display = 'none';
          }
        }
        // Deep-hover preview: anchored to the LIVE element under the cursor —
        // no re-resolution; if HMR/navigation replaced it, hide until the
        // next mouseover refreshes the anchor.
        if (altHoverEl && !altHoverEl.isConnected) altHoverEl = null;
        if (altHoverEl) {
          var ar = rectOf(altHoverEl);
          altBox.style.display = 'block';
          altBox.style.left = ar.left + 'px';
          altBox.style.top = ar.top + 'px';
          altBox.style.width = ar.width + 'px';
          altBox.style.height = ar.height + 'px';
        } else {
          altBox.style.display = 'none';
        }
      }
      if (targets.length || altHoverEl) raf = requestAnimationFrame(frame);
    }

    // Recompute the Alt deep-hover preview anchor. Dedup by element identity
    // — copies of a list item are distinct DOM elements, so this is the
    // bridge-local equivalent of the SSR canvas's path+item dedup. A change
    // (including to null) kicks one frame so the box updates/hides even when
    // no targets keep the rAF loop alive.
    function updateAltHover(target, altDown) {
      var el = altDown && selectMode && target && target.closest
        ? target.closest('[data-element-path]')
        : null;
      if (el === altHoverEl) return;
      altHoverEl = el;
      if (!raf) raf = requestAnimationFrame(frame);
    }

    window.addEventListener('message', function (ev) {
      var d = ev && ev.data;
      if (!d || d.type !== '${PLAY_XRAY_MESSAGE_TYPE}' || !Array.isArray(d.targets)) return;
      selectMode = !!d.selectMode;
      if (!selectMode) {
        lastHoverKey = null;
        lastMouseTarget = null;
        updateAltHover(null, false);
      }
      targets = d.targets.map(function (t) {
        return {
          chain: Array.isArray(t.chain) ? t.chain.map(String) : [],
          path: String(t.path || ''),
          kind: t.kind === 'selected' ? 'selected' : 'hovered',
          isComponent: !!t.isComponent,
          label: typeof t.label === 'string' ? t.label : '',
          item: typeof t.item === 'string' ? t.item : '',
          el: null
        };
      });
      if (!raf) raf = requestAnimationFrame(frame);
    });

    // ---- scroll-to-selected (editor → bridge) ----
    // The editor's same-origin scrollElementIntoView can't reach this
    // cross-origin frame, so a structure-tree selection posts the node's
    // identity here; resolve it the same way the border does and scroll the
    // page window to it in-page. Sanitize like the xray targets above —
    // resolveTarget() re-validates path/chain shape anyway.
    window.addEventListener('message', function (ev) {
      var d = ev && ev.data;
      if (!d || d.type !== '${PLAY_SCROLL_MESSAGE_TYPE}' || !d.target) return;
      var t = d.target;
      var el = resolveTarget({
        chain: Array.isArray(t.chain) ? t.chain.map(String) : [],
        path: String(t.path || ''),
        item: typeof t.item === 'string' ? t.item : '',
        isComponent: !!t.isComponent
      });
      if (el) scrollWindowToElement(el);
    });

    // ---- click-to-select + hover reporting (select mode only) ----
    // identify() comes from the shared resolver above — the same identity
    // algorithm that resolveTarget() inverts for drawing.

    document.addEventListener('click', function (e) {
      if (!selectMode) return;
      // Comment add-mode owns clicks (its own capture handler below posts the
      // identity); don't also fire a selection for the same click.
      if (commentMode === 'add') return;
      // The click belongs to the editor: never navigate links or fire the
      // page's own handlers while selecting (same as the SSR canvas).
      e.preventDefault();
      e.stopPropagation();
      var id = identify(e.target);
      // A null identity (no stamped ancestor — page background/chrome) still
      // posts, with a null path: while the editor is drilled into a component
      // it means the click landed outside ALL meno content, which must exit
      // component editing exactly like the SSR canvas's raw-target
      // click-outside check. \`alt\` carries the Option/Alt state — the
      // editor's deep-drill gesture (see PLAY_SELECT_MESSAGE_TYPE doc).
      post({
        type: '${PLAY_SELECT_MESSAGE_TYPE}',
        chain: id ? id.chain : [],
        path: id ? id.path : null,
        item: id ? id.item : '',
        alt: e.altKey
      });
    }, true);

    // Double-click = the editor's drill gesture (enter component / exit via
    // outer-owned content). The two single clicks above fire first and select,
    // then this drills — the same event sequence the SSR canvas produces.
    document.addEventListener('dblclick', function (e) {
      if (!selectMode) return;
      e.preventDefault();
      e.stopPropagation();
      var id = identify(e.target);
      if (id) post({ type: '${PLAY_OPEN_MESSAGE_TYPE}', chain: id.chain, path: id.path, item: id.item });
    }, true);

    document.addEventListener('mouseover', function (e) {
      if (!selectMode) return;
      // Remember the target so Alt keydown/keyup can re-evaluate the deep
      // preview without the cursor moving; refresh the preview from the
      // event's own Alt state (also clears a stale preview when an Alt
      // release was swallowed by a focus change).
      lastMouseTarget = e.target;
      updateAltHover(e.target, e.altKey);
      var id = identify(e.target);
      // Dedup on identity AND item path — moving between copies of the same
      // list item shares the identity but must refire so the highlight
      // follows the cursor (same rule as the SSR canvas hover).
      var key = id ? id.chain.join('|') + '#' + id.path + '@' + id.item : null;
      if (key === lastHoverKey) return;
      lastHoverKey = key;
      post({
        type: '${PLAY_HOVER_MESSAGE_TYPE}',
        chain: id ? id.chain : [],
        path: id ? id.path : null,
        item: id ? id.item : ''
      });
    }, true);
    document.documentElement.addEventListener('mouseleave', function () {
      lastMouseTarget = null;
      updateAltHover(null, false);
      if (!selectMode || lastHoverKey === null) return;
      lastHoverKey = null;
      post({ type: '${PLAY_HOVER_MESSAGE_TYPE}', chain: [], path: null });
    });

    // Alt pressed/released with a stationary cursor: re-evaluate the deep
    // preview in place from the last known target (the same rule the SSR
    // canvas's Alt keydown/keyup handlers apply).
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Alt') updateAltHover(lastMouseTarget, true);
    }, true);
    window.addEventListener('keyup', function (e) {
      if (e.key === 'Alt') updateAltHover(null, false);
    }, true);

    // ---- keyboard forwarding ----
    //
    // Focus lives in this (cross-origin) document whenever the user clicks the
    // preview, which would silently swallow every editor shortcut. Forward key
    // events to the editor, which re-dispatches them into its own shortcut
    // pipeline. Ownership rules:
    //  - editable targets (typing into the page's own inputs) are never touched
    //  - select mode: the editor owns the whole keyboard (arrows navigate the
    //    tree, Delete removes the node, plain-letter shortcuts work)
    //  - browse mode: only modifier chords (Cmd/Ctrl+…) and Escape are the
    //    editor's — plain keys keep driving the page (forms, sliders, scroll)
    //  - Cmd/Ctrl+C/X with a real text selection in the page stays native, so
    //    copying text out of the preview keeps working in either mode
    function isEditable(t) {
      if (!t || !t.tagName) return false;
      var tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
    }

    function shouldForwardKey(e) {
      if (isEditable(e.target)) return false;
      var mod = e.metaKey || e.ctrlKey;
      if (!selectMode && !mod && e.key !== 'Escape') return false;
      if (mod && (e.key === 'c' || e.key === 'x')) {
        var sel = window.getSelection();
        if (sel && !sel.isCollapsed) return false; // native text copy wins
      }
      return true;
    }

    function keyPayload(kind, e) {
      return {
        type: '${PLAY_KEY_MESSAGE_TYPE}',
        kind: kind,
        key: e.key,
        code: e.code,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        repeat: e.repeat
      };
    }

    window.addEventListener('keydown', function (e) {
      if (!shouldForwardKey(e)) return;
      // The keystroke belongs to the editor: stop page handlers and browser
      // defaults (Cmd+S save dialog, Cmd+P print, arrow/space scroll in
      // select mode, …).
      e.preventDefault();
      e.stopPropagation();
      post(keyPayload('keydown', e));
    }, true);

    window.addEventListener('keyup', function (e) {
      if (!shouldForwardKey(e)) return;
      post(keyPayload('keyup', e));
    }, true);

    // Soft navigations replace the DOM: drop cached elements so the next
    // frame re-resolves against the new document.
    document.addEventListener('astro:page-load', function () {
      for (var i = 0; i < targets.length; i++) targets[i].el = null;
      if (!raf && targets.length) raf = requestAnimationFrame(frame);
    });

    // ---- pinned comments (editor → bridge → editor) ----
    // Element-anchored: the editor posts each visible comment's identity
    // (id + chain/path/item/isComponent); the bridge resolves it the SAME way it
    // resolves an x-ray border (resolveTarget) and streams the element's viewport
    // rect back keyed by comment id, so CommentsOverlay draws the pin on the live
    // element. In add mode the bridge captures the next click and posts the
    // clicked element's identity so the editor anchors a new pin to that node.
    var commentMode = 'off';
    var commentTargets = [];
    var commentRaf = 0;
    var commentSnapshot = '';
    var commentCursorApplied = false;
    var commentPrevCursor = '';

    function applyCommentCursor() {
      if (!document.body) return;
      if (commentMode === 'add' && !commentCursorApplied) {
        commentPrevCursor = document.body.style.cursor;
        document.body.style.cursor = 'crosshair';
        commentCursorApplied = true;
      } else if (commentMode !== 'add' && commentCursorApplied) {
        document.body.style.cursor = commentPrevCursor;
        commentCursorApplied = false;
      }
    }

    function commentFrame() {
      commentRaf = 0;
      if (commentMode === 'off') return;
      var rects = [];
      for (var i = 0; i < commentTargets.length; i++) {
        var t = commentTargets[i];
        if (!t.el || !t.el.isConnected) t.el = resolveTarget(t);
        if (!t.el) continue;
        var r = rectOf(t.el);
        rects.push({ id: t.id, left: r.left, top: r.top, width: r.width, height: r.height });
      }
      var snap = JSON.stringify(rects);
      if (snap !== commentSnapshot) {
        commentSnapshot = snap;
        post({ type: '${PLAY_COMMENT_RECTS_MESSAGE_TYPE}', rects: rects });
      }
      // Keep re-measuring while comments are shown so pins track scroll / reflow.
      commentRaf = requestAnimationFrame(commentFrame);
    }

    function scheduleComments() {
      if (!commentRaf && commentMode !== 'off') commentRaf = requestAnimationFrame(commentFrame);
    }

    window.addEventListener('message', function (ev) {
      var d = ev && ev.data;
      if (!d || d.type !== '${PLAY_COMMENT_MODE_MESSAGE_TYPE}') return;
      commentMode = d.mode === 'add' ? 'add' : (d.mode === 'review' ? 'review' : 'off');
      commentTargets = Array.isArray(d.targets)
        ? d.targets.map(function (t) {
            return {
              id: String(t.id || ''),
              chain: Array.isArray(t.chain) ? t.chain.map(String) : [],
              path: String(t.path || ''),
              item: typeof t.item === 'string' ? t.item : '',
              isComponent: !!t.isComponent,
              el: null
            };
          })
        : [];
      applyCommentCursor();
      commentSnapshot = '';
      if (commentMode === 'off') {
        post({ type: '${PLAY_COMMENT_RECTS_MESSAGE_TYPE}', rects: [] });
      } else {
        scheduleComments();
      }
    });

    // Add-mode placement: capture the click, resolve the clicked element's
    // identity (the same identify() the select handler uses), and post it so the
    // editor anchors the new pin to that node. Capture phase + add-mode gate so
    // review-mode clicks pass through to the pins.
    document.addEventListener(
      'click',
      function (e) {
        if (commentMode !== 'add') return;
        e.preventDefault();
        e.stopPropagation();
        var id = identify(e.target);
        if (!id) return;
        // Place the pin WHERE the user clicked, not at the element's center. The
        // editor collapses a page-level play click to instance granularity (the
        // outermost component instance when the click is inside one, else the
        // clicked element itself), so resolve THAT same element — the one the pin
        // streams its rect for — and express the click as a 0..1 fraction of its
        // rect. The twin of the same-origin resolveCommentAnchorFromClick; falls
        // back to center if the anchor element can't be resolved.
        var anchorEl = id.chain.length > 0
          ? resolveTarget({ chain: [], path: id.chain[0], item: id.item, isComponent: true })
          : resolveTarget({ chain: [], path: id.path, item: id.item, isComponent: false });
        var offsetX = 0.5, offsetY = 0.5;
        if (anchorEl) {
          var ar = rectOf(anchorEl);
          if (ar.width > 0) offsetX = Math.min(1, Math.max(0, (e.clientX - ar.left) / ar.width));
          if (ar.height > 0) offsetY = Math.min(1, Math.max(0, (e.clientY - ar.top) / ar.height));
        }
        post({ type: '${PLAY_COMMENT_PLACE_MESSAGE_TYPE}', chain: id.chain, path: id.path, item: id.item, offsetX: offsetX, offsetY: offsetY });
      },
      true
    );

    document.addEventListener('astro:page-load', function () {
      for (var i = 0; i < commentTargets.length; i++) commentTargets[i].el = null;
      commentSnapshot = '';
      commentCursorApplied = false;
      applyCommentCursor();
      scheduleComments();
    });
  })();
}
`;
