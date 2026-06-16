/**
 * Embed.astro rich-text pipeline (integration).
 *
 * Embed.astro computes `localizeRichTextLinks(toHtmlString(i18n(rawHtml)))`. This test
 * exercises that exact composition (the component SFC itself can't be imported in a unit
 * test) to lock the `[object Object]` fix: a CMS rich-text field — a TipTap object, possibly
 * i18n-wrapped — must render as HTML, never as the string "[object Object]" or empty.
 */
import { test, expect, describe } from 'bun:test';
import { i18n, runWithLocale } from '../runtime/i18n';
import { localizeRichTextLinks } from '../runtime/localizeHref';
import { toHtmlString } from '../runtime/richText';
import type { I18nConfig } from 'meno-core/shared';
import type { TiptapDocument } from 'meno-core/shared/richtext';

const cfg: I18nConfig = {
  defaultLocale: 'en',
  locales: [
    { code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' },
    { code: 'pl', name: 'Polish', nativeName: 'Polski', langTag: 'pl-PL' },
  ],
};

const docEn: TiptapDocument = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
};
const docPl: TiptapDocument = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cześć' }] }],
};

// The exact expression Embed.astro evaluates for its `html` prop.
const render = (rawHtml: unknown) => localizeRichTextLinks(toHtmlString(i18n(rawHtml)));

describe('Embed rich-text pipeline', () => {
  test('a raw TipTap object renders as HTML, not "[object Object]"', () => {
    const out = render(docEn);
    expect(out).toBe('<p>Hello</p>');
    expect(out).not.toContain('[object Object]');
  });

  test('a plain HTML string passes through unchanged', () => {
    expect(render('<p>already html</p>')).toBe('<p>already html</p>');
  });

  test('an i18n-wrapped TipTap value resolves the locale BEFORE conversion (no i18n() at call site needed)', () => {
    // This is the runtime-hardening case: the template bound `html={cms.body}` (no i18n()),
    // so the pipeline receives the raw { _i18n } wrapper. i18n(rawHtml) must unwrap it.
    const wrapped = { _i18n: true, en: docEn, pl: docPl };
    expect(render(wrapped)).toBe('<p>Hello</p>'); // default locale, no context
    expect(runWithLocale('pl', cfg, () => render(wrapped))).toBe('<p>Cześć</p>');
  });

  test('an unsupported value yields empty string, never "[object Object]"', () => {
    expect(render({ not: 'rich-text' })).toBe('');
  });
});
