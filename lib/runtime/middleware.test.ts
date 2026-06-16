import { test, expect, describe } from 'bun:test';
import { createLocaleMiddleware, deriveLocale, type LocaleMiddlewareContext } from './middleware';
import { i18n, getLocaleContext } from './i18n';
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

describe('deriveLocale', () => {
  test('prefers context.currentLocale', () => {
    expect(deriveLocale({ currentLocale: 'pl', url: new URL('https://x/de/about') }, cfg)).toBe('pl');
  });

  test('falls back to the URL path-prefix when currentLocale is absent', () => {
    expect(deriveLocale({ url: new URL('https://x/pl/about') }, cfg)).toBe('pl');
    // Unknown / no prefix -> default locale.
    expect(deriveLocale({ url: new URL('https://x/about') }, cfg)).toBe('en');
  });

  test('falls back to config.defaultLocale when nothing matches', () => {
    expect(deriveLocale({}, cfg)).toBe('en');
    expect(deriveLocale({ currentLocale: null, url: null }, cfg)).toBe('en');
  });
});

describe('createLocaleMiddleware — end-to-end (locale derivation -> context -> i18n())', () => {
  // The STAR test: prove the whole chain. A mock `next` calls i18n() exactly like a page
  // body would; the middleware must have established the locale context so that resolves.
  function nextResolvingAbout() {
    return i18n(about) as unknown as Response;
  }

  test('currentLocale:"pl" -> page i18n() resolves to "O nas"', () => {
    const mw = createLocaleMiddleware(cfg);
    const out = mw({ currentLocale: 'pl' }, nextResolvingAbout);
    expect(out).toBe('O nas' as unknown as Response);
  });

  test('URL "/pl/about" (no currentLocale) -> "O nas"', () => {
    const mw = createLocaleMiddleware(cfg);
    const out = mw({ url: new URL('https://x/pl/about') }, nextResolvingAbout);
    expect(out).toBe('O nas' as unknown as Response);
  });

  test('default / unknown locale -> "About"', () => {
    const mw = createLocaleMiddleware(cfg);
    // No locale signal at all -> defaultLocale (en).
    expect(mw({}, nextResolvingAbout)).toBe('About' as unknown as Response);
    // currentLocale 'en' -> en.
    expect(mw({ currentLocale: 'en' }, nextResolvingAbout)).toBe('About' as unknown as Response);
    // currentLocale 'de' (not on the value) -> fallback chain -> default en -> 'About'.
    expect(mw({ currentLocale: 'de' }, nextResolvingAbout)).toBe('About' as unknown as Response);
  });

  test('the context is scoped to the render: it does not leak after next() returns', () => {
    const mw = createLocaleMiddleware(cfg);
    let seenInside: ReturnType<typeof getLocaleContext>;
    mw({ currentLocale: 'pl' }, () => {
      seenInside = getLocaleContext();
      return undefined as unknown as Response;
    });
    expect(seenInside).toEqual({ locale: 'pl', config: cfg });
    // No active context outside the middleware run.
    expect(getLocaleContext()).toBeUndefined();
  });

  test("the middleware returns next()'s value verbatim", () => {
    const mw = createLocaleMiddleware(cfg);
    const sentinel = { status: 200 } as unknown as Response;
    expect(mw({ currentLocale: 'pl' }, () => sentinel)).toBe(sentinel);
  });

  test('async next() resolves inside the locale context', async () => {
    const mw = createLocaleMiddleware(cfg);
    const out = await mw({ currentLocale: 'pl' }, async () => {
      // Simulate an async render boundary; AsyncLocalStorage must survive the await.
      await Promise.resolve();
      return i18n(about) as unknown as Response;
    });
    expect(out).toBe('O nas' as unknown as Response);
  });
});

describe('createLocaleMiddleware — context shape tolerance', () => {
  test('a null/undefined context degrades to defaultLocale (no throw)', () => {
    const mw = createLocaleMiddleware(cfg);
    expect(mw(undefined as unknown as LocaleMiddlewareContext, () => i18n(about) as unknown as Response)).toBe(
      'About' as unknown as Response,
    );
  });
});
