import { test, expect, describe } from 'bun:test';
import { resolveProps } from './index';
import { runWithLocale } from './runtime/i18n';
import type { I18nConfig } from 'meno-core/shared';

const CONFIG: I18nConfig = {
  defaultLocale: 'en',
  locales: [
    { code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' },
    { code: 'pl', name: 'Polish', nativeName: 'Polski', langTag: 'pl-PL' },
  ],
};

describe('resolveProps — i18n resolution (SSR parity)', () => {
  test('resolves I18nValue leaves in forwarded raw objects (the <Card post={post} /> case)', () => {
    // A collection-list loop forwards the RAW item across the component boundary —
    // the emitter's i18n() wrap can't see inside the component, so resolveProps is
    // the boundary that must resolve, exactly like SSR's resolveI18nInProps.
    const astro = {
      props: {
        post: {
          title: { _i18n: true, en: 'Hello', pl: 'Czesc' },
          author: 'Admin',
        },
      },
    };
    const defs = { post: { type: 'object' } } as never;
    const en = runWithLocale('en', CONFIG, () => resolveProps(astro, defs)) as {
      post: { title: string; author: string };
    };
    expect(en.post.title).toBe('Hello');
    const pl = runWithLocale('pl', CONFIG, () => resolveProps(astro, defs)) as {
      post: { title: string; author: string };
    };
    expect(pl.post.title).toBe('Czesc');
    expect(pl.post.author).toBe('Admin');
  });

  test('resolves an i18n prop DEFAULT', () => {
    const defs = {
      text: { type: 'string', default: { _i18n: true, en: 'Hi', pl: 'Czesc' } },
    } as never;
    const out = runWithLocale('pl', CONFIG, () => resolveProps({ props: {} }, defs)) as {
      text: string;
    };
    expect(out.text).toBe('Czesc');
  });

  test('plain values and class pass through untouched; no context → no resolution', () => {
    const defs = { n: { type: 'number', default: 3 } } as never;
    const inCtx = runWithLocale('pl', CONFIG, () => resolveProps({ props: { class: 'x', n: 5 } }, defs)) as {
      n: number;
      class: string;
    };
    expect(inCtx.n).toBe(5);
    expect(inCtx.class).toBe('x');

    // Outside any locale context (unit renders, non-meno usage) the raw value flows
    // through unchanged — resolution is strictly context-gated.
    const raw = resolveProps({ props: { v: { _i18n: true, en: 'Hello' } } }, { v: { type: 'object' } } as never) as {
      v: unknown;
    };
    expect(raw.v).toEqual({ _i18n: true, en: 'Hello' });
  });
});

describe('resolveProps — rich-text prop normalization (set:html parity)', () => {
  // A `type: "rich-text"` prop is rendered with `<Fragment set:html={prop} />`. CMS rich-text
  // values are TipTap JSON objects, which `set:html` would string-coerce to "[object Object]".
  // resolveProps must convert the value to an HTML string — the single choke point all
  // component props flow through (e.g. a RichText.astro card fed `i18n(cms.content)`).
  const doc = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }],
  };
  const docPl = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Cześć' }] }],
  };
  const defs = { content: { type: 'rich-text', default: '' } } as never;

  test('a TipTap object becomes an HTML string (no "[object Object]"), even with no locale context', () => {
    const out = resolveProps({ props: { content: doc } }, defs) as { content: string };
    expect(out.content).toBe('<p>Hello</p>');
    expect(out.content).not.toContain('[object Object]');
  });

  test('a plain HTML string passes through unchanged', () => {
    const out = runWithLocale('en', CONFIG, () => resolveProps({ props: { content: '<p>hi</p>' } }, defs)) as {
      content: string;
    };
    expect(out.content).toBe('<p>hi</p>');
  });

  test('an i18n-wrapped rich-text value resolves the locale, then converts to HTML', () => {
    const props = { content: { _i18n: true, en: doc, pl: docPl } };
    const en = runWithLocale('en', CONFIG, () => resolveProps({ props }, defs)) as { content: string };
    expect(en.content).toBe('<p>Hello</p>');
    const pl = runWithLocale('pl', CONFIG, () => resolveProps({ props }, defs)) as { content: string };
    expect(pl.content).toBe('<p>Cześć</p>');
  });

  test('a NON-rich-text object prop is left untouched (only rich-text props convert)', () => {
    const objDefs = { data: { type: 'object' } } as never;
    const out = resolveProps({ props: { data: doc } }, objDefs) as { data: unknown };
    expect(out.data).toEqual(doc);
  });
});
