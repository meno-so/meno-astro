/**
 * Viewport-unit rewriter for the editor's design canvas — the play-mode twin
 * of meno-core's `lib/shared/viewportUnits.ts`.
 *
 * In design mode each breakpoint frame's iframe is sized to its reported
 * content height, so `vh` resolves against that auto-sized height. Content
 * using `min-height: 100vh` (especially several stacked full-viewport
 * sections, or vh plus a fixed offset) then couples its own height to the
 * frame and runs away every measurement tick. The fix mirrors the same-origin
 * preview: rewrite every `Nvh`/`Nvw` so it resolves through a `--design-*`
 * custom property the design bridge pins to a stable pixel value; the var
 * fallback keeps page-mode / production byte-identical (vars unset → 1vh).
 *
 * This is intentionally a small standalone copy rather than an import from
 * meno-core: the play runtime resolves meno-core from published npm, so a new
 * core export wouldn't reach it without a publish. Keep this regex in sync
 * with core's `VIEWPORT_UNIT_RE` (they must agree, or design and select modes
 * pin different things). See packages/core/lib/shared/viewportUnits.ts.
 */

// A number (optional sign/decimal), optional size keyword (s/l/d), and vh|vw as
// a complete token. The negative lookbehind on `[\w-]` keeps matches out of
// identifiers — utility-class selectors like `.mh-100vh` stay literal even
// though the same string appears as a value elsewhere in the stylesheet.
const VIEWPORT_UNIT_RE = /(?<![\w-])(-?\d*\.?\d+)(s|l|d)?(vh|vw)\b/g;

/**
 * Rewrite viewport-relative lengths in any CSS-shaped string. Applied (in play
 * mode) to the CSS Astro extracts from each `.astro` `<style>` block — see the
 * `transform` hook in {@link xrayVitePlugin}. NOT applied to the raw `.astro`
 * source: rewriting `<style>` in a load hook desyncs Astro's style HMR and
 * full-reloads the page in a loop.
 */
export function rewriteViewportUnits(input: string): string {
  if (!input) return input;
  return input.replace(VIEWPORT_UNIT_RE, (_match, num: string, sizeKw: string | undefined, axis: string) => {
    const unit = `${sizeKw ?? ''}${axis}`;
    return `calc(var(--design-${unit}, 1${unit}) * ${num})`;
  });
}
