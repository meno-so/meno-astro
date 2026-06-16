/**
 * Play-mode design bridge — content-height reporting + design-canvas gestures.
 *
 * In the editor's design mode every breakpoint frame is an iframe sized to its
 * page's content height, and wheel/pan gestures over a frame drive the canvas
 * (zoom / pan), not the page. For the same-origin SSR preview both halves are
 * native: meno-core's in-page runtime posts CONTENT_HEIGHT reports, and the
 * editor's DesignCanvas attaches wheel/mousedown listeners straight onto the
 * iframe's contentDocument. The Astro play iframe is the REAL dev server —
 * cross-origin — so neither works: heights never arrive (the frame sticks at
 * its minimum and the page scrolls INSIDE it) and wheel events die in the
 * iframe (zoom/pan stop working whenever the cursor is over the frame).
 *
 * This injected head script (play mode only, same delivery as the navigation
 * and X-Ray bridges) restores both:
 *
 * - Height reporting (always on): posts `{ type: 'meno:astro:height', height }`
 *   to the parent whenever the measured content height changes. Measures the
 *   rendered content bottom by walking body children (the same approach as
 *   meno-core's MessageHandlers — document.scrollHeight is clamped to the
 *   viewport, so once the parent sizes the iframe to the report the value
 *   could never shrink again).
 *
 * - Viewport-unit pinning (design mode only): the editor's toggle carries the
 *   stable design viewport (`{ active, vh, vw }`), and while active the bridge
 *   pins `--design-vh`/`--design-vw` (and the s/l/d variants) on the root to
 *   those px values — the cross-origin twin of the same-origin preview's
 *   ENTER_DESIGN_MODE pinning (studio MessageHandlers). The play dev server
 *   rewrites every `Nvh`/`Nvw` to `calc(var(--design-vh, 1vh) * N)` (see the
 *   xray plugin's serve-time rewrite), so pinning the vars switches resolution
 *   to a fixed pixel value; clearing them on deactivate returns to true
 *   viewport units (page mode / production).
 *
 * - Gesture capture (design mode only): the editor toggles it with
 *   `{ type: 'meno:astro:design-mode', active }`. While active, wheel events
 *   are preventDefault-ed (the page must not scroll inside a design frame) and
 *   re-posted as `{ type: 'meno:astro:wheel', deltaX, deltaY, ctrlKey,
 *   metaKey, clientX, clientY }`; middle-mouse / Space+drag pan starts post
 *   `{ type: 'meno:astro:pan', clientX, clientY }`; Space tracking posts
 *   `{ type: 'meno:astro:space', held }` so the editor can mirror its grab
 *   cursor. The editor translates iframe-local coordinates to canvas space
 *   (it knows the frame's bounding rect + canvas zoom).
 *
 * Inbound messages are accepted from any origin and outbound posts use
 * `targetOrigin: '*'` — same rationale as the navigation bridge: the editor's
 * origin varies (web/Electron), nothing sensitive crosses the boundary
 * (gesture deltas and a pixel height), and the worst a hostile embedder could
 * do is disable scrolling of its own embedded frame.
 *
 * The viewport-unit feedback loop (content using `min-height: 100vh` plus a
 * top offset, which couples its height to the auto-sized frame and runs away)
 * is closed by the pinning above paired with the dev server's `Nvh` → `var(
 * --design-vh)` rewrite — the same mechanism the same-origin preview already
 * had. Without both halves (an unpinned var falls back to `1vh`; raw `100vh`
 * never references the var) a page of stacked full-viewport sections balloons
 * the design frame without bound.
 */

/** `message` event `data.type` the editor posts to toggle design-mode gesture capture. */
export const PLAY_DESIGN_MODE_MESSAGE_TYPE = 'meno:astro:design-mode';

/** Outbound `data.type` for content-height reports (cross-origin twin of CONTENT_HEIGHT). */
export const PLAY_HEIGHT_MESSAGE_TYPE = 'meno:astro:height';

/** Outbound `data.type` for forwarded wheel gestures (design mode only). */
export const PLAY_WHEEL_MESSAGE_TYPE = 'meno:astro:wheel';

/** Outbound `data.type` for pan-drag starts (middle mouse / Space+left, design mode only). */
export const PLAY_PAN_MESSAGE_TYPE = 'meno:astro:pan';

/** Outbound `data.type` for Space-key tracking (design mode only). */
export const PLAY_SPACE_MESSAGE_TYPE = 'meno:astro:space';

export const PLAY_DESIGN_BRIDGE_SCRIPT = `
if (window.self !== window.top) {
  (function () {
    var designMode = false;

    // ---- content height reporting (always on) ----
    var lastHeight = -1;
    var raf = 0;

    // Walk direct body children and take the lowest rendered bottom edge.
    // document.scrollHeight is useless here: it's clamped to the viewport, and
    // the parent sizes this iframe to whatever we report — heights would only
    // ever grow. Fixed/sticky children are viewport-anchored, not layout.
    function measureContentBottom() {
      var body = document.body;
      if (!body) return 0;
      var max = 0;
      var scrollY = window.scrollY || 0;
      for (var i = 0; i < body.children.length; i++) {
        var child = body.children[i];
        var rect = child.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        var style = window.getComputedStyle(child);
        if (style.position === 'fixed' || style.position === 'sticky') continue;
        var bottom = rect.bottom + scrollY + (parseFloat(style.marginBottom) || 0);
        if (bottom > max) max = bottom;
      }
      return Math.max(0, Math.ceil(max));
    }

    function post(msg) {
      try { window.parent.postMessage(msg, '*'); } catch (e) {}
    }

    function report() {
      if (!document.body) return;
      var h = measureContentBottom();
      if (h <= 0) h = Math.max(document.body.offsetHeight, document.documentElement.offsetHeight);
      if (h <= 0 || h === lastHeight) return;
      lastHeight = h;
      post({ type: '${PLAY_HEIGHT_MESSAGE_TYPE}', height: h });
    }

    function schedule() {
      if (raf) return;
      raf = requestAnimationFrame(function () { raf = 0; report(); });
    }

    function startObservers() {
      if (typeof ResizeObserver !== 'undefined') {
        try {
          var ro = new ResizeObserver(schedule);
          ro.observe(document.documentElement);
          if (document.body) ro.observe(document.body);
        } catch (e) {}
      }
      // Catch font/image loads that change height without resizing the
      // observed elements.
      try {
        new MutationObserver(schedule).observe(document.documentElement, {
          childList: true, subtree: true, attributes: true, characterData: true
        });
      } catch (e) {}
      schedule();
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', startObservers, { once: true });
    } else {
      startObservers();
    }
    window.addEventListener('load', schedule);
    // Soft navigations replace the body: force a fresh report for the new page.
    document.addEventListener('astro:page-load', function () { lastHeight = -1; schedule(); });

    // ---- viewport-unit pinning ----
    // Pin Nvh/Nvw (rewritten to calc(var(--design-*, 1*) * N) by the dev
    // server) to the stable editor viewport while the iframe is auto-sized
    // inside the design canvas. Twin of studio MessageHandlers ENTER_DESIGN_MODE.
    var VH_VARS = ['--design-vh', '--design-svh', '--design-lvh', '--design-dvh'];
    var VW_VARS = ['--design-vw', '--design-svw', '--design-lvw', '--design-dvw'];
    function pinViewport(vh, vw) {
      var root = document.documentElement;
      if (typeof vh === 'number' && isFinite(vh) && vh > 0) {
        var hu = (vh / 100) + 'px';
        for (var i = 0; i < VH_VARS.length; i++) root.style.setProperty(VH_VARS[i], hu);
      }
      if (typeof vw === 'number' && isFinite(vw) && vw > 0) {
        var wu = (vw / 100) + 'px';
        for (var j = 0; j < VW_VARS.length; j++) root.style.setProperty(VW_VARS[j], wu);
      }
    }
    function clearViewport() {
      var root = document.documentElement;
      for (var i = 0; i < VH_VARS.length; i++) root.style.removeProperty(VH_VARS[i]);
      for (var j = 0; j < VW_VARS.length; j++) root.style.removeProperty(VW_VARS[j]);
    }

    // ---- design-mode toggle ----
    window.addEventListener('message', function (ev) {
      var d = ev && ev.data;
      if (!d || d.type !== '${PLAY_DESIGN_MODE_MESSAGE_TYPE}') return;
      designMode = !!d.active;
      if (designMode) {
        pinViewport(d.vh, d.vw);
        // The editor's height listener may have missed earlier reports (it only
        // consumes them in design mode) — re-report on activation now that the
        // pinned vh has collapsed any 100vh content to its stable extent.
        lastHeight = -1; schedule();
      } else {
        clearViewport();
      }
    });

    // ---- gesture forwarding (design mode only) ----
    // Capture phase + passive:false so preventDefault sticks: in a design
    // frame the wheel belongs to the canvas (zoom/pan), never to page scroll.
    window.addEventListener('wheel', function (e) {
      if (!designMode) return;
      e.preventDefault();
      post({
        type: '${PLAY_WHEEL_MESSAGE_TYPE}',
        deltaX: e.deltaX, deltaY: e.deltaY,
        ctrlKey: e.ctrlKey, metaKey: e.metaKey,
        clientX: e.clientX, clientY: e.clientY
      });
    }, { passive: false, capture: true });

    var spaceHeld = false;
    function isEditable(t) {
      if (!t || !t.tagName) return false;
      var tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable === true;
    }
    function setSpace(held) {
      if (spaceHeld === held) return;
      spaceHeld = held;
      post({ type: '${PLAY_SPACE_MESSAGE_TYPE}', held: held });
    }
    window.addEventListener('keydown', function (e) {
      if (!designMode) return;
      if (e.code === 'Space' && !isEditable(e.target)) {
        e.preventDefault();
        setSpace(true);
      }
    }, true);
    window.addEventListener('keyup', function (e) {
      if (e.code === 'Space') setSpace(false);
    }, true);
    window.addEventListener('blur', function () { setSpace(false); });

    window.addEventListener('mousedown', function (e) {
      if (!designMode) return;
      var middle = e.button === 1;
      var spacePan = e.button === 0 && spaceHeld;
      if (!middle && !spacePan) return;
      e.preventDefault();
      e.stopPropagation();
      post({ type: '${PLAY_PAN_MESSAGE_TYPE}', clientX: e.clientX, clientY: e.clientY });
    }, true);
  })();
}
`;
