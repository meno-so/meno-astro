import { test, expect, describe } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveScaleConfigFromObject, readScaleConfigSync } from './scaleConfig';
import { DEFAULT_BREAKPOINTS } from 'meno-core/shared';

describe('resolveScaleConfigFromObject', () => {
  test('null config → meno-core defaults (disabled scaling, default breakpoints)', () => {
    const { breakpoints, responsiveScales } = resolveScaleConfigFromObject(null);
    expect(responsiveScales.enabled).toBe(false);
    expect(responsiveScales.padding?.tablet).toBe(0.75); // DEFAULT_RESPONSIVE_SCALES
    expect(breakpoints.tablet.breakpoint).toBe(DEFAULT_BREAKPOINTS.tablet.breakpoint);
    expect(breakpoints.mobile.breakpoint).toBe(DEFAULT_BREAKPOINTS.mobile.breakpoint);
  });

  test('user responsiveScales win; unset breakpoints in a category fall back to defaults', () => {
    const { responsiveScales } = resolveScaleConfigFromObject({
      responsiveScales: { enabled: true, padding: { tablet: 0.6 } },
    });
    expect(responsiveScales.enabled).toBe(true);
    expect(responsiveScales.padding?.tablet).toBe(0.6); // user value
    expect(responsiveScales.padding?.mobile).toBe(0.5); // per-category default fallback
    expect(responsiveScales.fontSize?.tablet).toBe(0.88); // untouched category → default
  });

  test('legacy numeric breakpoints are normalized to object form', () => {
    const { breakpoints } = resolveScaleConfigFromObject({ breakpoints: { tablet: 800 } as any });
    expect(breakpoints.tablet.breakpoint).toBe(800);
  });
});

describe('readScaleConfigSync', () => {
  test('reads + resolves project.config.json from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meno-scale-'));
    try {
      writeFileSync(
        join(dir, 'project.config.json'),
        JSON.stringify({ responsiveScales: { enabled: true, mode: 'fluid' } }),
      );
      const { responsiveScales } = readScaleConfigSync(dir);
      expect(responsiveScales.enabled).toBe(true);
      expect(responsiveScales.mode).toBe('fluid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing/unreadable config → defaults, never throws', () => {
    const { responsiveScales, breakpoints } = readScaleConfigSync(join(tmpdir(), 'meno-does-not-exist-xyz'));
    expect(responsiveScales.enabled).toBe(false);
    expect(breakpoints.tablet.breakpoint).toBe(DEFAULT_BREAKPOINTS.tablet.breakpoint);
  });
});
