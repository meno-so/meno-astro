import { test, expect, describe } from 'bun:test';
import {
  enumerateLocaleStaticPaths,
  enumerateCmsLocaleStaticPaths,
  enumerate404LocaleStaticPaths,
  dedupeLocaleStaticPaths,
  pageModuleKey,
  buildHreflangLinks,
  localeListItems,
  normalizePathname,
} from './localeRoutes';
import type { CmsSlugEntry } from './localeRoutes';
import type { I18nConfig } from 'meno-core/shared';
import type { SlugMap } from 'meno-core/shared';

const CONFIG: I18nConfig = {
  defaultLocale: 'en',
  locales: [
    { code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' },
    { code: 'pl', name: 'Polish', nativeName: 'Polski', langTag: 'pl-PL', icon: '/icons/pl.svg' },
    { code: 'de', name: 'German', nativeName: 'Deutsch', langTag: 'de-DE' },
  ],
};

const SINGLE: I18nConfig = {
  defaultLocale: 'en',
  locales: [{ code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' }],
};

const MAPPINGS: SlugMap[] = [
  { pageId: 'about', slugs: { en: 'about', pl: 'o-nas' } }, // de falls back to en slug
  { pageId: 'contact', slugs: { _default: 'contact' } }, // slugless page
  { pageId: 'index', slugs: { _default: '' } },
];

// A CMS item as loadCmsSlugMappings produces it: full path-after-locale slugs, every
// published locale explicit (de fallback pre-resolved), exactLocales marker, raw item.
const CMS_ENTRY: CmsSlugEntry = {
  map: {
    pageId: 'blog/my-post',
    slugs: { en: 'blog/my-post', pl: 'blog/moj-post', de: 'blog/my-post' },
    exactLocales: true,
  },
  templateId: 'blog/[slug]',
  item: {
    _id: 'post-1',
    slug: { _i18n: true, en: 'my-post', pl: 'moj-post' },
    title: { _i18n: true, en: 'Hello', pl: 'Czesc' },
    author: 'Admin',
  },
};

// The same map merged into the page mappings (what loadSlugMappings returns).
const MERGED: SlugMap[] = [...MAPPINGS, CMS_ENTRY.map];

describe('enumerateLocaleStaticPaths', () => {
  test('one path per (non-default locale × page); localized slug wins', () => {
    const paths = enumerateLocaleStaticPaths(MAPPINGS, CONFIG);
    expect(paths).toEqual([
      { params: { locale: 'pl', path: 'o-nas' }, props: { pageId: 'about' } },
      { params: { locale: 'pl', path: 'contact' }, props: { pageId: 'contact' } },
      { params: { locale: 'pl', path: undefined }, props: { pageId: 'index' } },
      { params: { locale: 'de', path: 'about' }, props: { pageId: 'about' } }, // en fallback
      { params: { locale: 'de', path: 'contact' }, props: { pageId: 'contact' } },
      { params: { locale: 'de', path: undefined }, props: { pageId: 'index' } },
    ]);
  });

  test('index / empty slug encodes as path: undefined (→ /pl/)', () => {
    const paths = enumerateLocaleStaticPaths([{ pageId: 'index', slugs: { _default: '' } }], CONFIG);
    expect(paths.every((p) => p.params.path === undefined)).toBe(true);
  });

  test('single-locale config → [] (route is not injected either)', () => {
    expect(enumerateLocaleStaticPaths(MAPPINGS, SINGLE)).toEqual([]);
  });

  test('pages missing every slug source fall back to pageId', () => {
    const paths = enumerateLocaleStaticPaths([{ pageId: 'pricing', slugs: {} }], CONFIG);
    expect(paths.map((p) => p.params.path)).toEqual(['pricing', 'pricing']);
  });
});

describe('enumerateCmsLocaleStaticPaths', () => {
  test('one path per (non-default locale × item); props carry the template id + locale-resolved cms', () => {
    const paths = enumerateCmsLocaleStaticPaths([CMS_ENTRY], CONFIG);
    expect(paths.map((p) => p.params)).toEqual([
      { locale: 'pl', path: 'blog/moj-post' },
      { locale: 'de', path: 'blog/my-post' }, // pre-resolved en fallback
    ]);
    const pl = paths[0]!;
    expect(pl.props.pageId).toBe('blog/[slug]'); // the TEMPLATE module, not the item URL
    expect(pl.props.cms).toEqual({
      _id: 'post-1',
      slug: 'moj-post', // i18n values resolved for the target locale (SSR parity)
      title: 'Czesc',
      author: 'Admin',
      _url: '/blog/moj-post', // JSON static-build _url convention (unprefixed item path)
    });
    const de = paths[1]!;
    expect(de.props.cms!.title).toBe('Hello'); // de missing → default-locale value
    expect(de.props.cms!._url).toBe('/blog/my-post');
  });

  test('canonical-only: the default slug is never enumerated under a locale prefix', () => {
    const paths = enumerateCmsLocaleStaticPaths([CMS_ENTRY], CONFIG);
    expect(paths.some((p) => p.params.locale === 'pl' && p.params.path === 'blog/my-post')).toBe(false);
    expect(paths.filter((p) => p.params.locale === 'pl')).toHaveLength(1);
  });

  test('a locale omitted from the slug map (per-locale draft) is not enumerated — no fallback chain', () => {
    const draftHidden: CmsSlugEntry = {
      ...CMS_ENTRY,
      map: { ...CMS_ENTRY.map, slugs: { en: 'blog/my-post', de: 'blog/my-post' } }, // pl hidden
    };
    const paths = enumerateCmsLocaleStaticPaths([draftHidden], CONFIG);
    expect(paths.map((p) => p.params.locale)).toEqual(['de']);
  });

  test('the default locale is never enumerated (the template route serves it)', () => {
    const paths = enumerateCmsLocaleStaticPaths([CMS_ENTRY], CONFIG);
    expect(paths.some((p) => p.params.locale === 'en')).toBe(false);
  });

  test('single-locale config → [] (route not injected either)', () => {
    expect(enumerateCmsLocaleStaticPaths([CMS_ENTRY], SINGLE)).toEqual([]);
  });
});

describe('enumerate404LocaleStaticPaths', () => {
  test('one /<locale>/404 path per non-default locale when the project has a 404 page', () => {
    expect(enumerate404LocaleStaticPaths(true, CONFIG)).toEqual([
      { params: { locale: 'pl', path: '404' }, props: { pageId: '404' } },
      { params: { locale: 'de', path: '404' }, props: { pageId: '404' } },
    ]);
  });

  test('no 404 page → [] (zero-cost no-op)', () => {
    expect(enumerate404LocaleStaticPaths(false, CONFIG)).toEqual([]);
  });

  test('single-locale config → [] even with a 404 page (route not injected either)', () => {
    expect(enumerate404LocaleStaticPaths(true, SINGLE)).toEqual([]);
  });

  test('the default locale is never enumerated (Astro builds dist/404.html itself)', () => {
    expect(enumerate404LocaleStaticPaths(true, CONFIG).some((p) => p.params.locale === 'en')).toBe(false);
  });

  test('pageId resolves to the 404 page module (LocaleRoute glob contract)', () => {
    const [first] = enumerate404LocaleStaticPaths(true, CONFIG);
    expect(pageModuleKey(first!.props.pageId)).toBe('/src/pages/404.astro');
  });

  test('404 URLs are never advertised: hreflang and the switcher see no 404 entry', () => {
    // The invariant the separate enumerator exists for — 404 stays OUT of the slug
    // map, so the advertising surfaces cannot resolve it to a page:
    //   hreflang on the localized 404 → [] (no alternates pointing at error URLs),
    expect(buildHreflangLinks('/pl/404', 'pl', CONFIG, MAPPINGS)).toEqual([]);
    expect(buildHreflangLinks('/pl/404/', 'pl', CONFIG, MAPPINGS, 'https://x.test')).toEqual([]);
    //   and no slug-map entry means the page enumeration never emits a 404 path of
    //   its own (the switcher's links are slug-map-driven the same way).
    expect(enumerateLocaleStaticPaths(MAPPINGS, CONFIG).some((p) => p.props.pageId === '404')).toBe(false);
  });
});

describe('dedupeLocaleStaticPaths', () => {
  test('first occurrence wins on {locale, path} collisions (pages > CMS > 404)', () => {
    const pageEntry = { params: { locale: 'pl', path: 'blog/my-post' }, props: { pageId: 'blog/my-post' } };
    const cmsEntry = {
      params: { locale: 'pl', path: 'blog/my-post' },
      props: { pageId: 'blog/[slug]', cms: { title: 'x' } },
    };
    const other = { params: { locale: 'pl', path: 'contact' }, props: { pageId: 'contact' } };
    expect(dedupeLocaleStaticPaths([pageEntry, cmsEntry, other])).toEqual([pageEntry, other]);
    // Index entries (path: undefined) dedupe too.
    const idxA = { params: { locale: 'pl', path: undefined }, props: { pageId: 'index' } };
    const idxB = { params: { locale: 'pl', path: undefined }, props: { pageId: 'other' } };
    expect(dedupeLocaleStaticPaths([idxA, idxB])).toEqual([idxA]);
  });
});

describe('pageModuleKey', () => {
  test('maps pageIds to glob keys (index + nested)', () => {
    expect(pageModuleKey('about')).toBe('/src/pages/about.astro');
    expect(pageModuleKey('index')).toBe('/src/pages/index.astro');
    expect(pageModuleKey('docs/intro')).toBe('/src/pages/docs/intro.astro');
  });

  test('maps CMS template ids to their [slug].astro modules', () => {
    expect(pageModuleKey('blog/[slug]')).toBe('/src/pages/blog/[slug].astro');
    expect(pageModuleKey('[slug]')).toBe('/src/pages/[slug].astro');
  });
});

describe('buildHreflangLinks', () => {
  test('default-locale page: per-locale langTag links + x-default (relative hrefs)', () => {
    expect(buildHreflangLinks('/about', 'en', CONFIG, MAPPINGS)).toEqual([
      { hreflang: 'en-US', href: '/about' },
      { hreflang: 'pl-PL', href: '/pl/o-nas' },
      { hreflang: 'de-DE', href: '/de/about' }, // en-slug fallback under de prefix
      { hreflang: 'x-default', href: '/about' },
    ]);
  });

  test('localized-slug page resolves back across locales', () => {
    expect(buildHreflangLinks('/pl/o-nas', 'pl', CONFIG, MAPPINGS)).toEqual([
      { hreflang: 'en-US', href: '/about' },
      { hreflang: 'pl-PL', href: '/pl/o-nas' },
      { hreflang: 'de-DE', href: '/de/about' },
      { hreflang: 'x-default', href: '/about' },
    ]);
  });

  test('index page maps to / and /<locale>', () => {
    expect(buildHreflangLinks('/', 'en', CONFIG, MAPPINGS)).toEqual([
      { hreflang: 'en-US', href: '/' },
      { hreflang: 'pl-PL', href: '/pl' },
      { hreflang: 'de-DE', href: '/de' },
      { hreflang: 'x-default', href: '/' },
    ]);
  });

  test('unknown path → [] — no alternates to 404s', () => {
    expect(buildHreflangLinks('/blog/some-unknown-post', 'en', CONFIG, MAPPINGS)).toEqual([]);
  });

  test('CMS item URLs resolve through the merged map (default + localized forms)', () => {
    const expected = [
      { hreflang: 'en-US', href: '/blog/my-post' },
      { hreflang: 'pl-PL', href: '/pl/blog/moj-post' },
      { hreflang: 'de-DE', href: '/de/blog/my-post' },
      { hreflang: 'x-default', href: '/blog/my-post' },
    ];
    expect(buildHreflangLinks('/blog/my-post', 'en', CONFIG, MERGED)).toEqual(expected);
    // Astro's directory-format trailing slash, and the localized URL, resolve to the same set.
    expect(buildHreflangLinks('/blog/my-post/', 'en', CONFIG, MERGED)).toEqual(expected);
    expect(buildHreflangLinks('/pl/blog/moj-post/', 'pl', CONFIG, MERGED)).toEqual(expected);
  });

  test('exactLocales (CMS): a draft-hidden locale is NOT advertised — no fallback alternate', () => {
    const merged: SlugMap[] = [
      ...MAPPINGS,
      // pl hidden via _draftLocales → the loader omitted it from slugs.
      { pageId: 'blog/my-post', slugs: { en: 'blog/my-post', de: 'blog/my-post' }, exactLocales: true } as SlugMap,
    ];
    expect(buildHreflangLinks('/blog/my-post', 'en', CONFIG, merged)).toEqual([
      { hreflang: 'en-US', href: '/blog/my-post' },
      { hreflang: 'de-DE', href: '/de/blog/my-post' },
      { hreflang: 'x-default', href: '/blog/my-post' },
    ]);
    // Pages keep the fallback advertisement (about has no de slug but /de/about IS built).
    expect(buildHreflangLinks('/about', 'en', CONFIG, merged).some((l) => l.hreflang === 'de-DE')).toBe(true);
  });

  test('percent-encoded pathnames (Astro.url.pathname) still resolve non-ASCII slugs', () => {
    // Astro.url.pathname is percent-encoded; the index is keyed by raw UTF-8 slugs.
    const mapped: SlugMap[] = [{ pageId: 'about', slugs: { en: 'about', de: 'über-uns' } }];
    const cfgDe: I18nConfig = {
      defaultLocale: 'en',
      locales: [
        { code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' },
        { code: 'de', name: 'German', nativeName: 'Deutsch', langTag: 'de-DE' },
      ],
    };
    const links = buildHreflangLinks('/de/%C3%BCber-uns', 'de', cfgDe, mapped);
    expect(links.find((l) => l.hreflang === 'en-US')?.href).toBe('/about');
    expect(links.find((l) => l.hreflang === 'de-DE')?.href).toBe('/de/über-uns');
    const items = localeListItems('/de/%C3%BCber-uns', 'de', cfgDe, mapped, true);
    expect(items.find((i) => i.locale === 'en')?.href).toBe('/about');
  });

  test("trailing-slash pathnames (Astro's build.format: 'directory') still slug-translate", () => {
    expect(buildHreflangLinks('/about/', 'en', CONFIG, MAPPINGS)).toEqual([
      { hreflang: 'en-US', href: '/about' },
      { hreflang: 'pl-PL', href: '/pl/o-nas' },
      { hreflang: 'de-DE', href: '/de/about' },
      { hreflang: 'x-default', href: '/about' },
    ]);
    expect(buildHreflangLinks('/pl/o-nas/', 'pl', CONFIG, MAPPINGS).find((l) => l.hreflang === 'en-US')?.href).toBe(
      '/about',
    );
  });

  test('single-locale or empty mappings → []', () => {
    expect(buildHreflangLinks('/about', 'en', SINGLE, MAPPINGS)).toEqual([]);
    expect(buildHreflangLinks('/about', 'en', CONFIG, [])).toEqual([]);
  });

  test('baseUrl prefixes every href, x-default included (absolute hreflang)', () => {
    expect(buildHreflangLinks('/about', 'en', CONFIG, MAPPINGS, 'https://example.com')).toEqual([
      { hreflang: 'en-US', href: 'https://example.com/about' },
      { hreflang: 'pl-PL', href: 'https://example.com/pl/o-nas' },
      { hreflang: 'de-DE', href: 'https://example.com/de/about' },
      { hreflang: 'x-default', href: 'https://example.com/about' },
    ]);
  });

  test('baseUrl on the index page → bare origin + locale prefixes', () => {
    expect(buildHreflangLinks('/', 'en', CONFIG, MAPPINGS, 'https://example.com')).toEqual([
      { hreflang: 'en-US', href: 'https://example.com/' },
      { hreflang: 'pl-PL', href: 'https://example.com/pl' },
      { hreflang: 'de-DE', href: 'https://example.com/de' },
      { hreflang: 'x-default', href: 'https://example.com/' },
    ]);
  });

  test('no baseUrl keeps the original relative behavior (5th param optional)', () => {
    expect(buildHreflangLinks('/about', 'en', CONFIG, MAPPINGS, undefined)).toEqual(
      buildHreflangLinks('/about', 'en', CONFIG, MAPPINGS),
    );
    expect(buildHreflangLinks('/about', 'en', CONFIG, MAPPINGS)[0]).toEqual({
      hreflang: 'en-US',
      href: '/about',
    });
  });

  test('baseUrl + unroutable path still → [] (no absolute alternates to 404s)', () => {
    expect(buildHreflangLinks('/blog/my-post', 'en', CONFIG, MAPPINGS, 'https://example.com')).toEqual([]);
  });
});

describe('normalizePathname', () => {
  test('strips trailing slashes, keeps the root', () => {
    expect(normalizePathname('/about/')).toBe('/about');
    expect(normalizePathname('/pl/o-nas/')).toBe('/pl/o-nas');
    expect(normalizePathname('/about')).toBe('/about');
    expect(normalizePathname('/')).toBe('/');
    // a multi-slash tail collapses to the bare path; an all-slash path is the root
    expect(normalizePathname('/about//')).toBe('/about');
    expect(normalizePathname('//')).toBe('/');
  });
});

describe('localeListItems', () => {
  test('slug-translated hrefs; default locale un-prefixed; nativeName labels', () => {
    expect(localeListItems('/about', 'en', CONFIG, MAPPINGS, true)).toEqual([
      { locale: 'en', href: '/about', label: 'English', langTag: 'en-US', isCurrent: true, icon: undefined },
      { locale: 'pl', href: '/pl/o-nas', label: 'Polski', langTag: 'pl-PL', isCurrent: false, icon: '/icons/pl.svg' },
      { locale: 'de', href: '/de/about', label: 'Deutsch', langTag: 'de-DE', isCurrent: false, icon: undefined },
    ]);
  });

  test('from a non-default locale page back to the default', () => {
    const items = localeListItems('/pl/o-nas', 'pl', CONFIG, MAPPINGS, true);
    expect(items.find((i) => i.locale === 'en')?.href).toBe('/about');
    expect(items.find((i) => i.locale === 'pl')?.isCurrent).toBe(true);
  });

  test('showCurrent=false filters the active locale out', () => {
    const items = localeListItems('/about', 'en', CONFIG, MAPPINGS, false);
    expect(items.map((i) => i.locale)).toEqual(['pl', 'de']);
  });

  test('trailing-slash pathname still slug-translates', () => {
    const items = localeListItems('/pl/o-nas/', 'pl', CONFIG, MAPPINGS, true);
    expect(items.find((i) => i.locale === 'en')?.href).toBe('/about');
    expect(items.find((i) => i.locale === 'pl')?.href).toBe('/pl/o-nas');
  });

  test('unknown path degrades to locale-prefix swap (previous LocaleList behavior)', () => {
    const items = localeListItems('/blog/some-unknown-post', 'en', CONFIG, MAPPINGS, true);
    expect(items.find((i) => i.locale === 'pl')?.href).toBe('/pl/blog/some-unknown-post');
    expect(items.find((i) => i.locale === 'en')?.href).toBe('/blog/some-unknown-post');
  });

  test('CMS item pages slug-translate through the merged map (switcher on /blog/my-post)', () => {
    const items = localeListItems('/blog/my-post', 'en', CONFIG, MERGED, true);
    expect(items.find((i) => i.locale === 'pl')?.href).toBe('/pl/blog/moj-post');
    const back = localeListItems('/pl/blog/moj-post', 'pl', CONFIG, MERGED, true);
    expect(back.find((i) => i.locale === 'en')?.href).toBe('/blog/my-post');
  });

  test('exactLocales (CMS): draft-hidden locales are dropped from the switcher', () => {
    // Item published in en+de only — pl hidden via _draftLocales, so /pl/blog/… was
    // never built; its switcher link would 404 in static output (the same filter
    // buildHreflangLinks applies; deliberately exceeds JSON-SSR parity).
    const merged: SlugMap[] = [
      ...MAPPINGS,
      { pageId: 'blog/my-post', slugs: { en: 'blog/my-post', de: 'blog/my-post' }, exactLocales: true } as SlugMap,
    ];
    const items = localeListItems('/blog/my-post', 'en', CONFIG, merged, true);
    expect(items.map((i) => i.locale)).toEqual(['en', 'de']);
    // …and from the de side, the en + de links remain, pl stays hidden.
    const fromDe = localeListItems('/de/blog/my-post', 'de', CONFIG, merged, true);
    expect(fromDe.map((i) => i.locale)).toEqual(['en', 'de']);
  });

  test('exactLocales never affects regular pages (fallback links stay)', () => {
    // about has no de slug, but pages are BUILT in every locale (fallback slug) —
    // the de link must survive.
    const items = localeListItems('/about', 'en', CONFIG, MERGED, true);
    expect(items.map((i) => i.locale)).toEqual(['en', 'pl', 'de']);
  });
});
