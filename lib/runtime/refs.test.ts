import { test, expect, describe } from 'bun:test';
import { href, embedHtml, when } from './refs';

describe('href() — prop-bound link resolution', () => {
  test('passthrough: link prop is an object → its .href', () => {
    const mapping = { _mapping: true as const, prop: 'link' };
    expect(href(mapping, { link: { href: '/about' } })).toBe('/about');
    // target is carried in the prop but the dialect Link takes only a string href.
    expect(href(mapping, { link: { href: '/x', target: '_blank' } })).toBe('/x');
  });

  test('passthrough: link prop is a bare string URL → used directly', () => {
    const mapping = { _mapping: true as const, prop: 'link' };
    expect(href(mapping, { link: 'https://example.com' })).toBe('https://example.com');
  });

  test('value mapping: prop value looked up in values table', () => {
    const mapping = {
      _mapping: true as const,
      prop: 'variant',
      values: { primary: { href: '/products' }, secondary: { href: '/contact' } },
    };
    expect(href(mapping, { variant: 'primary' })).toBe('/products');
    expect(href(mapping, { variant: 'secondary' })).toBe('/contact');
  });

  test('passthrough wins over a values table when the prop is already a link object', () => {
    const mapping = {
      _mapping: true as const,
      prop: 'link',
      values: { primary: { href: '/never' } },
    };
    expect(href(mapping, { link: { href: '/passthrough' } })).toBe('/passthrough');
  });

  test('unresolvable mappings degrade to "#" (never throw)', () => {
    const passthrough = { _mapping: true as const, prop: 'link' };
    expect(href(passthrough, undefined)).toBe('#'); // no props (page context)
    expect(href(passthrough, {})).toBe('#'); // prop unset
    const valueMap = { _mapping: true as const, prop: 'variant', values: { a: { href: '/a' } } };
    expect(href(valueMap, { variant: 'missing' })).toBe('#'); // key not in table
  });

  test('non-mapping values pass through', () => {
    expect(href('/literal')).toBe('/literal');
    expect(href({ href: '/obj' })).toBe('/obj');
    expect(href(undefined)).toBe('#');
  });
});

describe('embedHtml() — prop-bound html resolution', () => {
  test('value mapping: prop value looked up in values table', () => {
    const mapping = {
      _mapping: true as const,
      prop: 'icon',
      values: { arrow: '<svg>arrow</svg>', check: '<svg>check</svg>' },
    };
    expect(embedHtml(mapping, { icon: 'arrow' })).toBe('<svg>arrow</svg>');
    expect(embedHtml(mapping, { icon: 'check' })).toBe('<svg>check</svg>');
  });

  test('passthrough: empty/omitted values → string prop used directly', () => {
    const mapping = { _mapping: true as const, prop: 'svgContent' };
    expect(embedHtml(mapping, { svgContent: '<b>hi</b>' })).toBe('<b>hi</b>');
    const emptyValues = { _mapping: true as const, prop: 'svgContent', values: {} };
    expect(embedHtml(emptyValues, { svgContent: '<i>x</i>' })).toBe('<i>x</i>');
  });

  test('unresolvable mappings degrade to "" (never throw)', () => {
    const mapping = { _mapping: true as const, prop: 'icon', values: { a: '<a/>' } };
    expect(embedHtml(mapping, undefined)).toBe('');
    expect(embedHtml(mapping, {})).toBe('');
    expect(embedHtml(mapping, { icon: 'missing' })).toBe('');
  });

  test('non-mapping values pass through', () => {
    expect(embedHtml('<p>literal</p>')).toBe('<p>literal</p>');
    expect(embedHtml(undefined)).toBe('');
  });
});

describe('when() — prop-bound `if` condition resolution', () => {
  test('value mapping: prop value looked up in table, coerced to boolean', () => {
    const mapping = { _mapping: true as const, prop: 'variant', values: { primary: true, ghost: false } };
    expect(when(mapping, { variant: 'primary' })).toBe(true);
    expect(when(mapping, { variant: 'ghost' })).toBe(false);
  });

  test('defaults to true when unresolvable (matches meno-core — show, not hide)', () => {
    const mapping = { _mapping: true as const, prop: 'variant', values: { primary: false } };
    expect(when(mapping, undefined)).toBe(true); // no props (page)
    expect(when(mapping, {})).toBe(true); // prop unset
    expect(when(mapping, { variant: 'missing' })).toBe(true); // key not in table
  });

  test('non-mapping condition values are coerced directly', () => {
    expect(when(true)).toBe(true);
    expect(when(false)).toBe(false);
    expect(when('')).toBe(false);
    expect(when('yes')).toBe(true);
  });
});
