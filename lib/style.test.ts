/**
 * `style()` runtime — returns meno-core utility classes (byte-identical to the JSON
 * runtime's `responsiveStylesToClasses`), resolving prop-`_mapping`s against the host
 * component's props. The utility CSS itself is generated at BUILD time by the meno()
 * integration (Astro renders <head> before <body>, so a runtime collector would be
 * empty), so these tests assert the CLASS output, not CSS.
 */

import { test, expect, describe } from 'bun:test';
import { style } from './index';
import { responsiveStylesToClasses } from 'meno-core/shared';

const cls = (s: any) => responsiveStylesToClasses(s).join(' ');

describe('style() — meno-core utility classes (parity)', () => {
  test('static responsive style → the same classes meno-core produces', () => {
    const obj = { base: { display: 'flex', gap: '12px' } };
    expect(style(obj)).toBe(cls(obj));
  });

  test('flat (non-responsive) style object is supported', () => {
    const obj = { display: 'grid' };
    expect(style(obj)).toBe(cls(obj));
  });

  test('responsive base/tablet/mobile → meno-core responsive classes', () => {
    const obj = { base: { padding: '40px' }, tablet: { padding: '24px' }, mobile: { padding: '12px' } };
    expect(style(obj)).toBe(cls(obj));
  });
});

describe('style() — prop _mapping resolution from props', () => {
  const obj = {
    base: { marginTop: { _mapping: true as const, prop: 'isMarginTop', values: { true: '40px', false: '0' } } },
  };

  test('isMarginTop=true resolves to the 40px class', () => {
    expect(style(obj, { isMarginTop: true })).toBe(cls({ base: { marginTop: '40px' } }));
  });
  test('isMarginTop=false resolves to the 0 class', () => {
    expect(style(obj, { isMarginTop: false })).toBe(cls({ base: { marginTop: '0' } }));
  });
  test('different prop values → different classes', () => {
    expect(style(obj, { isMarginTop: true })).not.toBe(style(obj, { isMarginTop: false }));
  });
  test('select-variant mapping resolves the matched value', () => {
    const v = {
      base: {
        backgroundColor: {
          _mapping: true as const,
          prop: 'variant',
          values: { primary: '#0070f3', secondary: '#666' },
        },
      },
    };
    expect(style(v, { variant: 'secondary' })).toBe(cls({ base: { backgroundColor: '#666' } }));
  });
});

describe('style() — interactive', () => {
  const hover = { interactive: [{ name: 'onHover', postfix: ':hover', style: { color: '#fff' } }] };

  test('interactive meta appends one deterministic class (for build-time :hover CSS)', () => {
    const base = style({ base: { color: '#000' } });
    const withHover = style({ base: { color: '#000' } }, undefined, hover);
    expect(withHover.startsWith(base + ' ')).toBe(true);
    expect(withHover.split(' ').length).toBe(base.split(' ').length + 1);
    // Deterministic: identical inputs ⇒ identical class.
    expect(style({ base: { color: '#000' } }, undefined, hover)).toBe(withHover);
  });
});

describe('style() — graceful degradation', () => {
  test('a _mapping with no props is dropped; non-mapped props still render', () => {
    const obj = {
      base: {
        display: 'flex',
        marginTop: { _mapping: true as const, prop: 'isMarginTop', values: { true: '40px', false: '0' } },
      },
    };
    expect(style(obj)).toBe(cls({ base: { display: 'flex' } }));
  });

  test('null/undefined styleObject is tolerated → empty class string', () => {
    expect(() => style(null)).not.toThrow();
    expect(() => style(undefined)).not.toThrow();
    expect(style(null)).toBe('');
  });
});
