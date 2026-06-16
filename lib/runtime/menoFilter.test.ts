import { test, expect, describe } from 'bun:test';
import { menoFilterScript } from './menoFilter';
import { menoFilterScript as fromBarrel } from '../index';

describe('menoFilterScript', () => {
  test('is exported from the package barrel (BaseLayout imports it from "meno-astro")', () => {
    expect(fromBarrel).toBe(menoFilterScript);
  });

  test('is a self-contained, syntactically valid IIFE bundle', () => {
    expect(typeof menoFilterScript).toBe('string');
    // The esbuild IIFE bundle opens with "use strict"; var MenoFilterBundle=(()=>{ … }
    expect(menoFilterScript).toContain('MenoFilterBundle');
    // Compiles as JS (new Function only parses the body — it never runs the IIFE, so the
    // `document`/`window` references inside are not touched).
    expect(() => new Function(menoFilterScript)).not.toThrow();
  });

  test('exposes the class globally and self-gates on [data-meno-filter]', () => {
    // BaseLayout injects it unconditionally; the auto-init queries this attribute and
    // no-ops when the page has no filter wrapper.
    expect(menoFilterScript).toContain('data-meno-filter');
    // The footer exposes the class for programmatic use (MenoFilter.get(...)).
    expect(menoFilterScript).toContain('window.MenoFilter');
  });

  test('supports both data modes: inline #meno-cms-<id> and static /data fetch', () => {
    // Inline JSON data block id (Tier 2) and the static endpoint path (Tier 3) — the two
    // sources init() reads in order before falling back to DOM-only filtering (Tier 1).
    expect(menoFilterScript).toContain('meno-cms-');
    expect(menoFilterScript).toContain('/data/');
  });
});
