import { test, expect, describe } from 'bun:test';
import { dialectVersion, isI18nValue, parseSortExpression, list } from './index';
import { emit, parse, type DialectModel } from './dialect/index';

describe('meno-astro scaffold', () => {
  test('exposes a dialect version string', () => {
    expect(typeof dialectVersion).toBe('string');
    expect(dialectVersion.length).toBeGreaterThan(0);
  });

  test('re-exports meno-core runtime helpers across the package boundary', () => {
    // Proves meno-astro -> meno-core composition resolves and runs.
    expect(isI18nValue({ _i18n: true, en: 'hello' })).toBe(true);
    expect(isI18nValue('plain string')).toBe(false);
    expect(parseSortExpression('publishedAt desc')).toEqual({
      field: 'publishedAt',
      order: 'desc',
    });
  });

  test('list() runtime helper: tolerant source + offset/limit', () => {
    expect(list([1, 2, 3, 4, 5], { limit: 2 })).toEqual([1, 2]);
    expect(list([1, 2, 3, 4, 5], { offset: 1, limit: 2 })).toEqual([2, 3]);
    expect(list(null)).toEqual([]);
    expect(list(undefined)).toEqual([]);
    expect(list([1, 2, 3])).toEqual([1, 2, 3]);
  });

  test('dialect codec: emit() produces .astro and parse() reads it back', () => {
    const out = emit({} as DialectModel);
    expect(typeof out).toBe('string');
    expect(out).toContain('<BaseLayout');
    expect(out).toContain('const meta =');
    // Not `export const meta` — Astro's compiler fails to hoist an empty `export const
    // meta = {}` out of the component body. A local const sidesteps that entirely.
    expect(out).not.toContain('export const meta');
    // No `satisfies` — it's a TS-only operator that breaks the astro/esbuild build.
    expect(out).not.toContain('satisfies');
    const back = parse(out);
    expect(back.model).toBeDefined();
    expect(back.regions).toEqual([]);
  });
});
