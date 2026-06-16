import { test, expect, describe } from 'bun:test';
import { i18n, runWithLocale, getLocaleContext } from './i18n';
import type { I18nConfig, I18nValue } from 'meno-core/shared';

// A minimal multi-locale config (mirrors the shape of DEFAULT_I18N_CONFIG, with a
// second locale so resolution can actually diverge from the default).
const cfg: I18nConfig = {
  defaultLocale: 'en',
  locales: [
    { code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' },
    { code: 'pl', name: 'Polish', nativeName: 'Polski', langTag: 'pl-PL' },
  ],
};

const about: I18nValue = { _i18n: true, en: 'About', pl: 'O nas' };

describe('i18n() resolver', () => {
  test('with no active locale context resolves to the default locale (no throw)', () => {
    // No runWithLocale wrapper -> getLocaleContext() is undefined -> DEFAULT_I18N_CONFIG
    // default locale ('en'). Must never throw.
    expect(getLocaleContext()).toBeUndefined();
    expect(i18n(about)).toBe('About');
  });

  test('runWithLocale("pl", …) makes i18n() inside resolve to the Polish string', () => {
    const out = runWithLocale('pl', cfg, () => i18n(about));
    expect(out).toBe('O nas');
  });

  test('non-i18n values pass through unchanged', () => {
    expect(runWithLocale('pl', cfg, () => i18n('plain'))).toBe('plain');
    expect(runWithLocale('pl', cfg, () => i18n(42))).toBe(42);
  });
});

describe('i18n() async isolation (the AsyncLocalStorage contract)', () => {
  // The bug the static-import fix prevents: two concurrent renders for different
  // locales, each crossing an `await` boundary, must each see their OWN locale.
  // A synchronous module-variable fallback would let the second runWithLocale clobber
  // the first before its awaited continuation resolved.
  test('two concurrent runWithLocale calls keep their own locale across an await', async () => {
    const polish = runWithLocale('pl', cfg, async () => {
      await Promise.resolve();
      return i18n(about);
    });
    const english = runWithLocale('en', cfg, async () => {
      // Yield twice so this continuation interleaves with the Polish one.
      await Promise.resolve();
      await Promise.resolve();
      return i18n(about);
    });

    const [pl, en] = await Promise.all([polish, english]);
    expect(pl).toBe('O nas');
    expect(en).toBe('About');
  });
});
