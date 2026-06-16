import { test, expect, describe } from 'bun:test';
import { i18n, runWithLocale, getLocaleContext, localeFromAstro } from './index';
import type { I18nConfig } from 'meno-core/shared';

const cfg: I18nConfig = {
  defaultLocale: 'en',
  locales: [
    { code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' },
    { code: 'pl', name: 'Polish', nativeName: 'Polski', langTag: 'pl-PL' },
    { code: 'de', name: 'German', nativeName: 'Deutsch', langTag: 'de-DE' },
  ],
};

const about = { _i18n: true as const, en: 'About', pl: 'O nas' };

describe('i18n() — passthrough', () => {
  test('non-i18n values pass through unchanged', () => {
    expect(i18n('plain string')).toBe('plain string');
    expect(i18n(42)).toBe(42);
    expect(i18n(true)).toBe(true);
    expect(i18n(['a', 'b'])).toEqual(['a', 'b']);
    expect(i18n(null)).toBe(null);
    expect(i18n(undefined)).toBe(undefined);
    const obj = { href: '/x', target: '_blank' };
    expect(i18n(obj)).toBe(obj);
  });
});

describe('i18n() — locale context via runWithLocale', () => {
  test('resolves to the active locale (pl / en)', () => {
    expect(runWithLocale('pl', cfg, () => i18n(about))).toBe('O nas');
    expect(runWithLocale('en', cfg, () => i18n(about))).toBe('About');
  });

  test('getLocaleContext reflects the active context and clears afterward', () => {
    expect(getLocaleContext()).toBeUndefined();
    const seen = runWithLocale('pl', cfg, () => getLocaleContext());
    expect(seen).toEqual({ locale: 'pl', config: cfg });
    // Context does not leak out of the run.
    expect(getLocaleContext()).toBeUndefined();
  });

  test('runWithLocale returns the inner function value', () => {
    expect(runWithLocale('pl', cfg, () => 123)).toBe(123);
  });
});

describe('i18n() — fallback chain', () => {
  test('missing locale falls back to defaultLocale', () => {
    // de not present on this value -> default (en)
    expect(runWithLocale('de', cfg, () => i18n(about))).toBe('About');
  });

  test('missing locale + missing default falls back to first available', () => {
    const onlyPl = { _i18n: true as const, pl: 'Tylko PL' };
    // active 'de', default 'en' both absent -> first available (pl)
    expect(runWithLocale('de', cfg, () => i18n(onlyPl))).toBe('Tylko PL');
  });

  test('no keys at all -> empty string', () => {
    const empty = { _i18n: true as const };
    expect(runWithLocale('de', cfg, () => i18n(empty))).toBe('');
  });

  test('array/list values: exact, fallback, and empty-array cases', () => {
    const listVal = {
      _i18n: true as const,
      en: ['one', 'two'],
      pl: ['jeden', 'dwa'],
    };
    expect(runWithLocale('pl', cfg, () => i18n(listVal))).toEqual(['jeden', 'dwa']);
    // missing locale 'de' -> default 'en'
    expect(runWithLocale('de', cfg, () => i18n(listVal))).toEqual(['one', 'two']);

    // No matching keys but an array value exists -> empty array (not empty string).
    const listOnlyDe = { _i18n: true as const, de: ['x'] };
    const frConfig: I18nConfig = {
      defaultLocale: 'fr',
      locales: [{ code: 'fr', name: 'FR', nativeName: 'FR', langTag: 'fr-FR' }],
    };
    // active 'fr', default 'fr' absent, first available is the de array.
    expect(runWithLocale('fr', frConfig, () => i18n(listOnlyDe))).toEqual(['x']);
  });
});

describe('i18n() — no context', () => {
  test('resolves to the default locale without throwing', () => {
    // No runWithLocale -> DEFAULT_I18N_CONFIG (defaultLocale 'en').
    expect(i18n(about)).toBe('About');
  });

  test('passthrough still works without context', () => {
    expect(i18n('x')).toBe('x');
  });
});

describe('i18n() — explicit override wins over context', () => {
  test('locale string override', () => {
    // Context says en, override forces pl.
    expect(runWithLocale('en', cfg, () => i18n(about, 'pl'))).toBe('O nas');
    // Works with no context too.
    expect(i18n(about, 'pl')).toBe('O nas');
  });

  test('{ locale, config } override', () => {
    expect(runWithLocale('en', cfg, () => i18n(about, { locale: 'pl', config: cfg }))).toBe('O nas');
    // config supplied, locale defaults to its defaultLocale when omitted (and no ctx locale match)
    expect(i18n(about, { config: cfg })).toBe('About');
  });

  test('Astro-like override ({ currentLocale })', () => {
    expect(runWithLocale('en', cfg, () => i18n(about, { currentLocale: 'pl' }))).toBe('O nas');
  });

  test('Astro-like override ({ url }) uses the path locale prefix', () => {
    expect(i18n(about, { url: { pathname: '/pl/about' }, config: undefined } as any)).toBe('About');
    // With a config that knows pl, the url prefix resolves.
    expect(runWithLocale('en', cfg, () => i18n(about, { url: { pathname: '/pl/about' } }))).toBe('O nas');
  });
});

describe('localeFromAstro', () => {
  test('prefers currentLocale', () => {
    expect(localeFromAstro({ currentLocale: 'pl', url: { pathname: '/de/x' } }, cfg)).toBe('pl');
  });

  test('falls back to URL prefix when currentLocale absent', () => {
    expect(localeFromAstro({ url: { pathname: '/pl/about' } }, cfg)).toBe('pl');
    // Unknown prefix is not a valid locale -> default.
    expect(localeFromAstro({ url: { pathname: '/about' } }, cfg)).toBe('en');
  });

  test('falls back to defaultLocale when nothing matches', () => {
    expect(localeFromAstro(undefined, cfg)).toBe('en');
    expect(localeFromAstro({}, cfg)).toBe('en');
    expect(localeFromAstro(null, cfg)).toBe('en');
  });
});
