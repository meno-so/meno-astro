import { test, expect, describe } from 'bun:test';
import { decodeVariantClass } from './variantClass';

describe('decodeVariantClass', () => {
  test('decodes a plain arbitrary-value utility class like classToStyle', () => {
    expect(decodeVariantClass('p-[24px]')).toEqual({ prop: 'padding', value: '24px' });
  });

  test('re-wraps a color var-token SHORTHAND back to Meno var(--x) form', () => {
    // classToStyle canonicalizes `text-(--text)` → bare token `text`; decodeVariantClass restores
    // the model convention `var(--text)` so the emit gate recovers the original value exactly.
    expect(decodeVariantClass('text-(--text)')).toEqual({ prop: 'color', value: 'var(--text)' });
  });

  test('leaves an arbitrary var() form untouched (already var(...))', () => {
    expect(decodeVariantClass('[background:var(--primary)]')).toEqual({
      prop: 'background',
      value: 'var(--primary)',
    });
  });

  test('returns null for a token classToStyle cannot model', () => {
    expect(decodeVariantClass('swiper')).toBeNull();
  });
});
