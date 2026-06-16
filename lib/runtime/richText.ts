/**
 * Normalize a stored rich-text value to an HTML string for `set:html` (used by Embed.astro).
 *
 * CMS rich-text fields are stored as TipTap JSON docs, so a binding like
 * `<Embed html={cms.content}>` receives an OBJECT on real items — without normalizing it,
 * Astro's `set:html` string-coerces it to "[object Object]". This converts any supported
 * non-string shape to HTML (idempotent for plain strings; the stored/edited value stays raw
 * TipTap):
 *   - plain HTML string                        -> returned as-is
 *   - { __richtext__, html }            marker -> marker.html
 *   - { __richtext__, format:'tiptap', json }  -> tiptapToHtml(json)
 *   - raw TipTap doc { type:'doc', … }         -> tiptapToHtml(doc)
 *   - anything else                            -> '' (empty, never an object)
 *
 * Lives in meno-astro (not meno-core) on purpose: the play runtime installs meno-core from
 * the PUBLISHED npm package, so a new meno-core export wouldn't reach the runtime without an
 * npm publish. meno-astro is rebuilt from the workspace, so this helper ships with the
 * runtime. It depends only on `tiptapToHtml`/`isTiptapDocument`, which published meno-core
 * already exports.
 */
import { tiptapToHtml, isTiptapDocument } from 'meno-core/shared/richtext';
import { expandRichTextEmbeds } from './expandRichTextEmbeds';
import { i18n } from './i18n';
import { localizeRichTextLinks } from './localizeHref';

export function toHtmlString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (o.__richtext__ === true && typeof o.html === 'string') return o.html;
    const doc = isTiptapDocument(o) ? o : isTiptapDocument(o.json) ? o.json : null;
    // tiptapToHtml serializes embedded `menoComponent` nodes to placeholder markers
    // (meno-core's SSR would expand them by running the component); the astro string
    // pipeline can't, so expand the embed markers to their iframe markup here.
    if (doc) return expandRichTextEmbeds(tiptapToHtml(doc as Parameters<typeof tiptapToHtml>[0]));
  }
  return '';
}

/**
 * The full CMS rich-text render pipeline as a single render-time function:
 * resolve an i18n wrapper to the active locale → normalize TipTap/marker → HTML →
 * localize internal `<a href>`s. This is exactly what `Embed.astro` runs for its `html`.
 *
 * The dialect emitter wraps a CMS rich-text field bound as a text child in
 * `richTextWithComponents()` (richTextComponents.ts), which runs this pipeline and then
 * renders embedded `menoComponent` nodes for real — so the markup renders
 * instead of string-coercing the raw TipTap object to "[object Object]" — a CMS *page* has no
 * `resolveProps` to normalize the value, so the conversion must happen at the binding. Doing
 * `i18n()` here (not at load time) keeps per-locale resolution at render time, under the
 * route's active locale context. Idempotent on plain HTML strings.
 */
export function richText(value: unknown): string {
  return localizeRichTextLinks(toHtmlString(i18n(value)));
}
