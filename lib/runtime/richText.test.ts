/**
 * toHtmlString Tests — normalizes a stored rich-text value (string / TipTap doc /
 * { __richtext__, … } marker) to an HTML string for `set:html`. Guards against the
 * "[object Object]" bug where a TipTap object reaches Astro's set:html unconverted.
 */
import { test, expect, describe } from 'bun:test';
import { toHtmlString } from './richText';
import type { TiptapDocument } from 'meno-core/shared/richtext';

const doc: TiptapDocument = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'First' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Second' }] },
  ],
};

describe('toHtmlString', () => {
  test('passes a plain HTML string through unchanged', () => {
    expect(toHtmlString('<p>hello</p>')).toBe('<p>hello</p>');
  });

  test('passes an empty string through', () => {
    expect(toHtmlString('')).toBe('');
  });

  test('converts a raw TipTap doc to HTML', () => {
    expect(toHtmlString(doc)).toBe('<p>First</p><p>Second</p>');
  });

  test('extracts html from a { __richtext__, html } marker', () => {
    expect(toHtmlString({ __richtext__: true, html: '<p>x</p>' })).toBe('<p>x</p>');
  });

  test('converts a { __richtext__, format, json } marker via its TipTap json', () => {
    expect(toHtmlString({ __richtext__: true, format: 'tiptap', json: doc })).toBe('<p>First</p><p>Second</p>');
  });

  test('converts a { json: <tiptap> } wrapper', () => {
    expect(toHtmlString({ json: doc })).toBe('<p>First</p><p>Second</p>');
  });

  test('returns empty string for an unsupported object (never "[object Object]")', () => {
    expect(toHtmlString({ foo: 'bar' })).toBe('');
  });

  test('returns empty string for null / undefined', () => {
    expect(toHtmlString(null)).toBe('');
    expect(toHtmlString(undefined)).toBe('');
  });

  test('expands an embedded Youtube menoComponent node to its iframe markup', () => {
    const url = 'https://www.youtube.com/embed/VZEa13_DNHw';
    const withEmbed: TiptapDocument = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] },
        { type: 'menoComponent', attrs: { component: 'Youtube', props: { url } } },
      ],
    };
    const html = toHtmlString(withEmbed);
    expect(html).toContain('<p>intro</p>');
    expect(html).toContain('<iframe');
    expect(html).toContain(`src="${url}"`);
    expect(html).not.toContain('data-meno-component');
  });
});
