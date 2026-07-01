import { test, expect, describe } from 'bun:test';
import { emit, parse, normalizeModel } from './index';

function assertRoundTrip(x: unknown) {
  const n = normalizeModel(x);
  expect(normalizeModel(n)).toEqual(n as any);
  const back = parse(emit(n as any)).model;
  expect(back).toEqual(n as any);
}

describe('page meta: Phase 1 + visual-batch fields round-trip via const meta', () => {
  test('viewTransitions / noindex / sitemap / customCode survive emit→parse exactly', () => {
    const page = {
      meta: {
        title: 'Docs',
        viewTransitions: true,
        noindex: true,
        sitemap: { priority: 0.8, changefreq: 'weekly', exclude: true },
        customCode: {
          head: '<meta property="og:type" content="article" />',
          bodyStart: '<noscript>enable JS</noscript>',
          bodyEnd: '<script>console.log(1)</script>',
        },
      },
      root: { type: 'node', tag: 'main', children: 'Hi' },
    };
    assertRoundTrip(page);

    // Emit shape: each field lands in the `const meta` literal (not dropped/whitelisted).
    const src = emit(normalizeModel(page) as any);
    expect(src).toContain('viewTransitions: true');
    expect(src).toContain('noindex: true');
    expect(src).toContain('changefreq: "weekly"');
    expect(src).toContain('og:type');
  });

  test('a partial sitemap (priority only) round-trips', () => {
    assertRoundTrip({
      meta: { title: 'A', sitemap: { priority: 1 } },
      root: { type: 'node', tag: 'div', children: 'x' },
    });
  });

  test('meta.prerender=false emits a top-level export (not a meta field) and round-trips', () => {
    const page = {
      meta: { title: 'Dynamic', prerender: false },
      root: { type: 'node', tag: 'main', children: 'Hi' },
    };
    assertRoundTrip(page);

    const src = emit(normalizeModel(page) as any);
    // Astro's own per-route mechanism — a top-level export, NOT inside `const meta`.
    expect(src).toContain('export const prerender = false;');
    expect(src).not.toContain('prerender: false');
  });

  test('meta.prerender=true round-trips', () => {
    assertRoundTrip({
      meta: { title: 'Forced static', prerender: true },
      root: { type: 'node', tag: 'div', children: 'x' },
    });
  });
});
