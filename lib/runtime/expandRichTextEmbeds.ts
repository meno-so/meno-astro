/**
 * Expand rich-text `menoComponent` embed markers to HTML (the dialect twin of
 * meno-core SSR's `expandRichTextComponents`, ssrRenderer.ts).
 *
 * A CMS rich-text body can embed a project component (a Youtube/Vimeo/… embed) via a
 * TipTap `menoComponent` node. `tiptapToHtml` serializes that node to a placeholder
 * marker — `<div data-meno-component="Youtube" data-meno-props="{&quot;url&quot;:…}"></div>`
 * — that meno-core's SSR later expands by RUNNING the referenced component renderer.
 * The astro runtime renders rich text as a string through `set:html`, so it can't
 * instantiate a project `.astro` component mid-string; without this pass the marker
 * reaches the page as an empty `<div>` and the embed silently vanishes.
 *
 * Embed components are uniform: a static iframe wrapped responsively, the only instance
 * prop being the embed URL. So we reconstruct that wrapper here from the marker's `url`
 * (or `src`) prop — byte-for-byte the markup Meno's embed components emit, so astro
 * matches the editor preview. Markers without a usable URL prop are left untouched
 * here — `richTextComponents.ts` (richTextWithComponents) expands those by rendering
 * the real project component from the generated registry.
 *
 * Lives in meno-astro (not meno-core's `tiptapToHtml`) on purpose: the play runtime
 * installs meno-core from PUBLISHED npm, so expanding the marker there wouldn't reach
 * the runtime without an npm publish — meno-astro is rebuilt from the workspace.
 */

/** The marker `tiptapToHtml` emits for a `menoComponent` node (renderMenoComponent).
 *  Shared with `richTextComponents.ts`, which expands the non-embed markers this
 *  pass leaves behind by rendering the real project component. */
export const MARKER_RE = /<div\s+data-meno-component="([^"]*)"\s+data-meno-props="([^"]*)"\s*><\/div>/g;

/** Reverse the entity escaping `tiptapToHtml`'s `escapeAttr` applied to the props JSON. */
export function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Escape a value for use inside a double-quoted HTML attribute (escapeAttr parity). */
function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/**
 * The responsive iframe markup Meno's embed components render (e.g. the project-level
 * `Youtube` component): a padding-box wrapper holding an absolutely-positioned iframe.
 * Mirrors the embed component structure so the astro output matches the editor preview.
 */
function renderEmbed(url: string): string {
  const src = escapeAttr(url);
  return (
    '<div style="position: relative; padding-bottom: 56.66%; height: 0;">' +
    `<iframe src="${src}" frameborder="0" webkitallowfullscreen mozallowfullscreen ` +
    'allowfullscreen style="position: absolute; top: 0; left: 0; width: 100%; ' +
    'height: 100%; border: none;"></iframe></div>'
  );
}

/**
 * Replace `menoComponent` embed markers in a rich-text HTML string with the embed's
 * iframe markup. Idempotent on strings without markers; non-embed markers pass through.
 */
export function expandRichTextEmbeds(html: string): string {
  if (typeof html !== 'string' || !html.includes('data-meno-component')) return html;
  return html.replace(MARKER_RE, (marker, _component, rawProps) => {
    let props: Record<string, unknown>;
    try {
      props = JSON.parse(unescapeAttr(rawProps)) as Record<string, unknown>;
    } catch {
      return marker;
    }
    const url = props.url ?? props.src;
    if (typeof url !== 'string' || !url) return marker;
    return renderEmbed(url);
  });
}
