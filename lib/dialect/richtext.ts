/**
 * Rich-text HTML codec helpers shared by the emitter and the parser.
 *
 * A Meno "rich-text" value is an HTML string (Tiptap → meno-core's `tiptapToHtml`). It
 * must render as REAL HTML in the converted `.astro` (via `set:html` / a backtick literal),
 * otherwise Astro escapes the markup and inline marks (custom spans, `<strong>`, `<a>`, …)
 * ship as literal `&lt;span&gt;` text and their scoped CSS matches nothing. See the task
 * doc `docs/span-richtext-astro-task.md`.
 *
 * **Detection is content-based** (`isRichTextHtml`): a string carrying any tag `tiptapToHtml`
 * emits is rich text. This single heuristic covers both call-site prop values (emitAttr) and
 * direct content typed into a page/element (emitTextChild) — no parallel `name → propNames`
 * map is threaded from the converter. Bare rich-text *prop refs* (`{{text}}` where `text` is
 * declared `type:"rich-text"`) are recognized separately, by prop type, in `emitTextChild`.
 *
 * **`data-meno-span` round-trip.** A custom span carries an editor-only `data-meno-span`
 * marker — meno-core's `htmlToTiptap` (`parseSpan`) needs it to recognize a `textStyle`
 * mark. `tiptapToHtml` ALWAYS emits it equal to the class: `<span class="X" data-meno-span="X">`.
 * The codec strips it on emit (cleaner source) and deterministically re-adds it on parse,
 * keyed off the class. `strip`/`add` are mutual inverses on that canonical form, so
 * `parse(emit(model)) === normalizeModel(model)` stays exact; both are no-ops on strings
 * without meno spans, so applying them broadly is safe. meno-core's runtime is NOT touched.
 */

/**
 * Inline + block tags emitted by `tiptapToHtml` (kept in sync with its `applyMark` /
 * `RICH_TEXT_ALLOWED_TAGS`). Their presence marks a string as rich-text HTML. Anchored with
 * `\b` so prose like `5 < 10` or `<article` is not mistaken for a tag.
 */
const RICH_TEXT_TAG_RE =
  /<\/?(?:strong|em|u|s|code|a|span|sub|sup|mark|b|i|p|br|ul|ol|li|blockquote|h[1-6]|pre|hr|small|figure|figcaption|table|thead|tbody|tr|th|td)\b/i;

/** True when a string contains rich-text markup (a tag `tiptapToHtml` can produce). */
export function isRichTextHtml(s: string): boolean {
  return RICH_TEXT_TAG_RE.test(s);
}

/** Strip the editor-only `data-meno-span="…"` attribute from every `<span>` opening tag. */
export function stripMenoSpanMarker(html: string): string {
  return html.replace(/<span\b[^>]*>/gi, (tag) => tag.replace(/\s+data-meno-span="[^"]*"/gi, ''));
}

/**
 * Re-add `data-meno-span` (= the span's class) to any classed `<span>` that lacks it — the
 * exact inverse of {@link stripMenoSpanMarker} on canonical `tiptapToHtml` output, where the
 * marker always equals the class and follows it. Idempotent (skips spans that already carry
 * it); a no-op on spans without a class or strings without spans.
 */
export function addMenoSpanMarker(html: string): string {
  return html.replace(/<span\b[^>]*>/gi, (tag) => {
    if (/\bdata-meno-span=/i.test(tag)) return tag;
    const m = tag.match(/\bclass="([^"]*)"/i);
    if (!m) return tag;
    return tag.replace(/(\bclass="[^"]*")/i, `$1 data-meno-span="${m[1]}"`);
  });
}
