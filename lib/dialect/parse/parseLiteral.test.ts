import { test, expect, describe } from 'bun:test';
import { parseLiteral, parseValueAt, reverseI18nWrap } from './parseLiteral';
import { serializeLiteral } from '../emit/serialize';

describe('parseLiteral — primitives', () => {
  test('strings, numbers, booleans, null', () => {
    expect(parseLiteral('"hi"')).toBe('hi');
    expect(parseLiteral('"a \\"q\\" \\\\ \\n"')).toBe('a "q" \\ \n');
    expect(parseLiteral('42')).toBe(42);
    expect(parseLiteral('0.8')).toBe(0.8);
    expect(parseLiteral('-5')).toBe(-5);
    expect(parseLiteral('true')).toBe(true);
    expect(parseLiteral('false')).toBe(false);
    expect(parseLiteral('null')).toBe(null);
  });
});

describe('parseLiteral — objects + arrays', () => {
  test('identifier and quoted keys', () => {
    expect(parseLiteral('{ marginTop: "4px" }')).toEqual({ marginTop: '4px' });
    expect(parseLiteral('{ "aria-label": "x", count: 3 }')).toEqual({ 'aria-label': 'x', count: 3 });
  });
  test('empty + nested + multi-line', () => {
    expect(parseLiteral('{}')).toEqual({});
    expect(parseLiteral('[]')).toEqual([]);
    expect(parseLiteral('[1, 2, 3]')).toEqual([1, 2, 3]);
    expect(parseLiteral('{\n  a: {\n    b: [1, { c: "d" }]\n  }\n}')).toEqual({ a: { b: [1, { c: 'd' }] } });
  });
  test('parseValueAt reports the end index (for embedded literals)', () => {
    const src = '{ x: 1 }, Astro)';
    const r = parseValueAt(src, 0);
    expect(r.value).toEqual({ x: 1 });
    expect(src.slice(r.end)).toBe(', Astro)');
  });
});

describe('reverseI18nWrap — the CMS-data i18n() wrap reversal', () => {
  test('bare member/identifier chains unwrap', () => {
    expect(reverseI18nWrap('i18n(cms.title)')).toBe('cms.title');
    expect(reverseI18nWrap('i18n(cms.title.pl)')).toBe('cms.title.pl'); // forced-locale suffix
    expect(reverseI18nWrap('i18n(item._id)')).toBe('item._id');
    expect(reverseI18nWrap('i18n( cms.title )')).toBe('cms.title'); // whitespace-tolerant
    expect(reverseI18nWrap('i18n(cms)')).toBe('cms');
  });
  test('the rich-text set:html wrap reverses too (richText(<chain>) → chain)', () => {
    expect(reverseI18nWrap('richText(cms.content)')).toBe('cms.content');
    expect(reverseI18nWrap('richText( cms.body )')).toBe('cms.body'); // whitespace-tolerant
    expect(reverseI18nWrap('richText(cms.content.pl)')).toBe('cms.content.pl');
    expect(reverseI18nWrap('richText({ _i18n: true })')).toBe(null); // not a bare chain
  });
  test('anything else is NOT a wrap (value literal, calls, operators, multi-arg, guards)', () => {
    expect(reverseI18nWrap('i18n({ _i18n: true, en: "x" })')).toBe(null); // i18n VALUE literal
    expect(reverseI18nWrap('i18n(getFoo())')).toBe(null);
    expect(reverseI18nWrap('i18n(cms.price * 2)')).toBe(null);
    expect(reverseI18nWrap('i18n(cms.tags[0])')).toBe(null);
    expect(reverseI18nWrap('i18n(cms.title, "pl")')).toBe(null); // explicit override → authored JS
    expect(reverseI18nWrap('i18n(cms.x) || undefined')).toBe(null); // guard handled by caller
    expect(reverseI18nWrap('cms.title')).toBe(null);
  });
  test('unwraps inside structured-value expression positions (bare expr + backtick)', () => {
    expect(parseLiteral('{ href: i18n(cms.url) }')).toEqual({ href: '{{cms.url}}' });
    expect(parseLiteral('`/p/${i18n(cms.slug)}`')).toBe('/p/{{cms.slug}}');
    // Non-wrap calls keep the existing bare-expression behavior.
    expect(parseLiteral('{ href: link.href }')).toEqual({ href: '{{link.href}}' });
  });
});

describe('parseLiteral ∘ serializeLiteral = identity (the inverse property)', () => {
  const samples: unknown[] = [
    { _i18n: true, en: 'Hello', pl: 'Cześć', de: 'Hallo' },
    { base: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px' }, tablet: {}, mobile: {} },
    { _mapping: true, prop: 'isMarginTop', values: { true: '40px', false: '0' } },
    { text: 'Get started', isMarginTop: true, link: { href: '/x', target: '_blank' } },
    [{ title: 'A' }, { title: 'B', tags: ['x', 'y'] }],
    { nested: { deep: { deeper: { x: [1, 2, { y: 'z' }] } } } },
    { 'data-id': '123', 'aria-label': 'Button "primary"', count: 3, flag: false, nothing: null },
    {},
    [],
    'plain string',
    -12.5,
  ];

  test('round-trips at multiple widths', () => {
    for (const s of samples) {
      for (const width of [80, 40, 1]) {
        const serialized = serializeLiteral(s, { width });
        expect(parseLiteral(serialized)).toEqual(s as any);
      }
    }
  });
});
