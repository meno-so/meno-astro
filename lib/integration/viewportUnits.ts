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
// a complete token. The negative lookbehind keeps matches out of utility-class
// identifiers so a class SELECTOR stays literal while only the VALUE is rewritten:
//   - `\w-` covers dash identifiers like `.mh-100vh`.
//   - `\[` covers arbitrary-value classes like `.min-h-[100svh]` (the `100svh`
//     sits right after the `[`). Without it the selector would become
//     `.min-h-[calc(...)]` and stop matching the element's `class`, silently
//     breaking the rule + design-mode viewport pin (`min-height:100svh` then
//     couples to the iframe viewport). Must match core's VIEWPORT_UNIT_RE.
const VIEWPORT_UNIT_RE = /(?<![\w\-[])(-?\d*\.?\d+)(s|l|d)?(vh|vw)\b/g;

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

/**
 * Apply {@link rewriteViewportUnits} to a whole stylesheet, rewriting ONLY the
 * declaration bodies — never the selectors or at-rule preludes.
 *
 * {@link rewriteViewportUnits} is regex-based and can't reliably tell a
 * declaration value's viewport unit from one buried in an *escaped*
 * arbitrary-value class SELECTOR. The `VIEWPORT_UNIT_RE` lookbehind guards the
 * common selector shapes (`.mh-100vh`, `.min-h-[100svh]`), but a class whose
 * arbitrary value carries a viewport unit after an escaped `.` or `,` slips
 * through — e.g. `text-[clamp(56px,9.5vw,150px)]` escapes to
 * `.text-\[clamp\(56px\,9\.5vw\,150px\)\]`, where the `.5vw` sits right after a
 * backslash and the rewriter injects `calc(...)` INTO the selector. The result
 * is invalid CSS the browser drops entirely, so the rule — and the design-mode
 * viewport pin it carries — silently vanishes and the element renders unstyled.
 *
 * Splitting selector text from declaration bodies at brace boundaries removes
 * the ambiguity: every selector / prelude ends at a `{`, every declaration body
 * ends at a `}`, so only body text is handed to the value rewriter. Correct
 * through `@media` nesting too (a nested rule's selector still ends at its own
 * `{`). Assumes braces only ever delimit blocks — true for the generated
 * utility/interactive sheets and Astro's compiled `<style>` output (neither
 * emits literal `{`/`}` inside a value or string).
 */
export function rewriteViewportUnitsInStylesheet(css: string): string {
  if (!css) return css;
  let out = '';
  let seg = '';
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === '{') {
      out += seg + ch; // `seg` is a selector / at-rule prelude — keep it literal
      seg = '';
    } else if (ch === '}') {
      out += rewriteViewportUnits(seg) + ch; // `seg` is a declaration body — rewrite its values
      seg = '';
    } else {
      seg += ch;
    }
  }
  return out + seg; // trailing text outside any block — never a declaration value
}
