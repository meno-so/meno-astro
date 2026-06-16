import { describe, test, expect } from 'bun:test';
import { rewriteViewportUnits } from './viewportUnits';

describe('rewriteViewportUnits', () => {
  test('rewrites plain vh/vw through the pinnable custom property', () => {
    expect(rewriteViewportUnits('height: 100vh;')).toBe('height: calc(var(--design-vh, 1vh) * 100);');
    expect(rewriteViewportUnits('width: 50vw;')).toBe('width: calc(var(--design-vw, 1vw) * 50);');
  });

  test('handles the s/l/d variants and signed decimals', () => {
    expect(rewriteViewportUnits('min-height: 100dvh;')).toBe('min-height: calc(var(--design-dvh, 1dvh) * 100);');
    expect(rewriteViewportUnits('top: -50.5svh;')).toBe('top: calc(var(--design-svh, 1svh) * -50.5);');
  });

  test('rewrites inside calc() (the vh + offset runaway case)', () => {
    expect(rewriteViewportUnits('min-height: calc(100vh - 1rem);')).toBe(
      'min-height: calc(calc(var(--design-vh, 1vh) * 100) - 1rem);',
    );
  });

  test('leaves utility-class-name selectors literal (lookbehind on [\\w-])', () => {
    // `.mh-100vh` is a class name, not a value — the `-` before 100vh blocks it.
    expect(rewriteViewportUnits('.mh-100vh { color: red; }')).toBe('.mh-100vh { color: red; }');
  });

  test('is a no-op on empty / vh-free input', () => {
    expect(rewriteViewportUnits('')).toBe('');
    expect(rewriteViewportUnits('color: red;')).toBe('color: red;');
  });

  test('a single pass over a value matches each viewport length exactly once', () => {
    // The injected `1vh` fallback is part of the replacement, so the global
    // regex does not re-scan it within the same pass — `90vh` rewrites cleanly.
    // (The function must therefore be applied ONCE, to the extracted CSS — re-
    // feeding its own output would re-match the fallback unit. That is why the
    // play rewrite lives in the style-module transform, not a re-entrant hook.)
    expect(rewriteViewportUnits('max-height: 90vh; min-height: 100dvh;')).toBe(
      'max-height: calc(var(--design-vh, 1vh) * 90); min-height: calc(var(--design-dvh, 1dvh) * 100);',
    );
  });
});
