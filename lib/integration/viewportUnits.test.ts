import { describe, test, expect } from 'bun:test';
import { rewriteViewportUnits, rewriteViewportUnitsInStylesheet } from './viewportUnits';

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

  test('preserves arbitrary-value class selectors, rewriting only the value', () => {
    // `.min-h-[100svh]` is the literal class on the element; only the declaration
    // value may be rewritten, or the selector stops matching and the design-mode
    // pin silently breaks (`100svh` then couples to the iframe viewport).
    expect(rewriteViewportUnits('.min-h-\\[100svh\\] { min-height: 100svh; }')).toBe(
      '.min-h-\\[100svh\\] { min-height: calc(var(--design-svh, 1svh) * 100); }',
    );
    // Arbitrary value carrying a calc(): selector still preserved.
    expect(rewriteViewportUnits('.h-\\[50dvh\\] { height: calc(50dvh - 1rem); }')).toBe(
      '.h-\\[50dvh\\] { height: calc(calc(var(--design-dvh, 1dvh) * 50) - 1rem); }',
    );
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

describe('rewriteViewportUnitsInStylesheet', () => {
  test('preserves an escaped selector carrying a DECIMAL viewport unit (the clamp-in-text bug)', () => {
    // `text-[clamp(56px,9.5vw,150px)]` escapes to `…9\.5vw…`; the value-level
    // rewriter matches the `.5vw` after the backslash and corrupts the selector,
    // so the rule is dropped and the heading falls back to the UA default size.
    // The stylesheet-scoped rewrite touches only the declaration body.
    const rule = '.text-\\[clamp\\(56px\\,9\\.5vw\\,150px\\)\\] { font-size: clamp(56px,9.5vw,150px); }';
    expect(rewriteViewportUnitsInStylesheet(rule)).toBe(
      '.text-\\[clamp\\(56px\\,9\\.5vw\\,150px\\)\\] { font-size: clamp(56px,calc(var(--design-vw, 1vw) * 9.5),150px); }',
    );
    // Guard the rationale: the raw value rewriter alone corrupts this selector.
    expect(rewriteViewportUnits(rule).split('{')[0]).toContain('calc(');
  });

  test('preserves an escaped selector when a viewport unit follows a no-space comma', () => {
    // `p-[80px_clamp(20px,5vw,64px)]` — the `5vw` sits right after an escaped
    // comma (`\,5vw`), the other lookbehind gap. Body-only rewrite keeps it safe.
    const rule = '.p-\\[80px_clamp\\(20px\\,5vw\\,64px\\)\\] { padding: 80px clamp(20px,5vw,64px); }';
    expect(rewriteViewportUnitsInStylesheet(rule)).toBe(
      '.p-\\[80px_clamp\\(20px\\,5vw\\,64px\\)\\] { padding: 80px clamp(20px,calc(var(--design-vw, 1vw) * 5),64px); }',
    );
  });

  test('rewrites declaration values inside @media blocks while keeping nested selectors literal', () => {
    const sheet = '@media (max-width: 767px) { .h-\\[50dvh\\] { height: 50dvh; } }';
    expect(rewriteViewportUnitsInStylesheet(sheet)).toBe(
      '@media (max-width: 767px) { .h-\\[50dvh\\] { height: calc(var(--design-dvh, 1dvh) * 50); } }',
    );
  });

  test('handles multiple rules and leaves plain-CSS selectors untouched', () => {
    const sheet = '.a { top: 10vh; } .b { left: 20vw; }';
    expect(rewriteViewportUnitsInStylesheet(sheet)).toBe(
      '.a { top: calc(var(--design-vh, 1vh) * 10); } .b { left: calc(var(--design-vw, 1vw) * 20); }',
    );
  });

  test('is a no-op on empty / brace-free / vh-free input', () => {
    expect(rewriteViewportUnitsInStylesheet('')).toBe('');
    expect(rewriteViewportUnitsInStylesheet('.a { color: red; }')).toBe('.a { color: red; }');
  });
});
