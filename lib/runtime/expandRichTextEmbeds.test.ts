/**
 * expandRichTextEmbeds Tests — expands rich-text `menoComponent` embed markers
 * (`<div data-meno-component="…" data-meno-props="…">`) emitted by tiptapToHtml into
 * the responsive iframe markup Meno's embed components render. Guards the bug where a
 * Youtube embed inside CMS rich text rendered in Meno's preview but vanished in astro.
 */
import { test, expect, describe } from 'bun:test';
import { expandRichTextEmbeds } from './expandRichTextEmbeds';

const URL = 'https://www.youtube.com/embed/VZEa13_DNHw?si=ZMDPLZbEYTtiFWYC';
// Marker exactly as tiptapToHtml's renderMenoComponent emits it (escapeAttr on the JSON).
const marker = (props: Record<string, unknown>) =>
  `<div data-meno-component="Youtube" data-meno-props="${JSON.stringify(props)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')}"></div>`;

describe('expandRichTextEmbeds', () => {
  test('expands a Youtube embed marker to the responsive iframe wrapper', () => {
    const html = expandRichTextEmbeds(marker({ url: URL }));
    expect(html).toContain('<iframe');
    expect(html).toContain(`src="${URL}"`);
    expect(html).toContain('padding-bottom: 56.66%');
    expect(html).toContain('allowfullscreen');
    expect(html).not.toContain('data-meno-component');
  });

  test('keeps surrounding rich-text HTML around the embed', () => {
    const html = expandRichTextEmbeds(`<p>before</p>${marker({ url: URL })}<h2>after</h2>`);
    expect(html.startsWith('<p>before</p>')).toBe(true);
    expect(html.endsWith('<h2>after</h2>')).toBe(true);
    expect(html).toContain('<iframe');
  });

  test('accepts a `src` prop as well as `url`', () => {
    const html = expandRichTextEmbeds(marker({ src: URL }));
    expect(html).toContain(`src="${URL}"`);
  });

  test('escapes the URL inside the iframe src attribute', () => {
    const html = expandRichTextEmbeds(marker({ url: 'https://x.com/"onerror="alert(1)' }));
    expect(html).not.toContain('"onerror="');
    expect(html).toContain('&quot;onerror=&quot;');
  });

  test('leaves a marker without a url/src prop untouched', () => {
    const m = marker({ label: 'no-url' });
    expect(expandRichTextEmbeds(m)).toBe(m);
  });

  test('leaves a marker with malformed props JSON untouched', () => {
    const m = '<div data-meno-component="Youtube" data-meno-props="not json"></div>';
    expect(expandRichTextEmbeds(m)).toBe(m);
  });

  test('passes through HTML with no markers unchanged', () => {
    expect(expandRichTextEmbeds('<p>plain</p>')).toBe('<p>plain</p>');
    expect(expandRichTextEmbeds('')).toBe('');
  });
});
