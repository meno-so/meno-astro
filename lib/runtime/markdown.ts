/**
 * meno-astro runtime — `renderMarkdown`.
 *
 * Renders a `markdown` node's verbatim source string to HTML at Astro build/SSR time. The
 * `Markdown.astro` runtime component (emitted by the dialect for a `type:"markdown"` node)
 * calls this and renders the result with `set:html`.
 *
 * Kept here (NOT imported from meno-core) so the published Astro play runtime never depends on
 * a NEW meno-core export it can't resolve (the runtime installs meno-core from npm and pins it
 * — see the runtime-uses-npm-meno-core constraint). The config mirrors meno-core's
 * `lib/shared/markdown.ts` so the editor-canvas preview and the real Astro build render the
 * same HTML. `markdown-it` is a real dependency (esbuild keeps deps external; the play runtime
 * installs meno-astro's deps transitively).
 */

import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: true, linkify: true, breaks: false });

/** Render a Markdown source string to an HTML string. Empty/non-string → "". */
export function renderMarkdown(source: unknown): string {
  if (typeof source !== 'string' || source.trim() === '') return '';
  return md.render(source);
}
