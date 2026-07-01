import { test, expect, describe } from 'bun:test';
import { buildSitemapXml } from './sitemap';
import type { I18nConfig } from 'meno-core/shared';
import type { SlugMap } from 'meno-core/shared';

const SITE = 'https://example.com';

const CONFIG: I18nConfig = {
  defaultLocale: 'en',
  locales: [
    { code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' },
    { code: 'pl', name: 'Polish', nativeName: 'Polski', langTag: 'pl-PL' },
  ],
};

const SINGLE: I18nConfig = {
  defaultLocale: 'en',
  locales: [{ code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' }],
};

const MAPPINGS: SlugMap[] = [
  { pageId: 'about', slugs: { en: 'about', pl: 'o-nas' } },
  { pageId: 'index', slugs: { _default: '' } },
];

/** The <url> block whose <loc> is exactly `loc`, or '' (keeps assertions readable). */
function urlBlock(xml: string, loc: string): string {
  const blocks = xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
  return blocks.find((b) => b.includes(`<loc>${loc}</loc>`)) ?? '';
}

describe('buildSitemapXml', () => {
  test('multi-locale: slug-translated alternates per locale + x-default on both URL forms', () => {
    const xml = buildSitemapXml(
      [{ pathname: '' }, { pathname: 'about/' }, { pathname: 'pl/o-nas/' }],
      SITE,
      CONFIG,
      MAPPINGS,
    )!;
    // /about and /pl/o-nas are BOTH listed, and both carry the SAME alternate set
    // (the slug-translated pair + x-default → the default-locale URL).
    for (const loc of ['https://example.com/about', 'https://example.com/pl/o-nas']) {
      const block = urlBlock(xml, loc);
      expect(block).toContain(`<loc>${loc}</loc>`);
      expect(block).toContain('<xhtml:link rel="alternate" hreflang="en-US" href="https://example.com/about"/>');
      expect(block).toContain('<xhtml:link rel="alternate" hreflang="pl-PL" href="https://example.com/pl/o-nas"/>');
      expect(block).toContain('<xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/about"/>');
    }
    // The xhtml namespace is declared because alternates are present.
    expect(xml).toContain('xmlns:xhtml="http://www.w3.org/1999/xhtml"');
  });

  test('root page: loc is the bare origin + trailing slash, alternates → / and /pl', () => {
    const xml = buildSitemapXml([{ pathname: '' }], SITE, CONFIG, MAPPINGS)!;
    expect(xml).toContain('<loc>https://example.com/</loc>');
    expect(xml).toContain('hreflang="en-US" href="https://example.com/"');
    expect(xml).toContain('hreflang="pl-PL" href="https://example.com/pl"');
    expect(xml).toContain('hreflang="x-default" href="https://example.com/"');
  });

  test('unroutable pages are listed WITHOUT alternates', () => {
    const xml = buildSitemapXml([{ pathname: 'blog/my-post/' }], SITE, CONFIG, MAPPINGS)!;
    expect(xml).toContain('<url><loc>https://example.com/blog/my-post</loc></url>');
    expect(xml).not.toContain('xhtml:link');
    expect(xml).not.toContain('xmlns:xhtml');
  });

  test('CMS item URLs carry alternates once the merged slug map routes them', () => {
    // The same /blog/my-post that was plain above — with the loadSlugMappings CMS entry
    // present, both the default and the localized URL advertise the full alternate set.
    const merged: SlugMap[] = [
      ...MAPPINGS,
      {
        pageId: 'blog/my-post',
        slugs: { en: 'blog/my-post', pl: 'blog/moj-post' },
        exactLocales: true,
      } as SlugMap,
    ];
    const xml = buildSitemapXml(
      [{ pathname: 'blog/my-post/' }, { pathname: 'pl/blog/moj-post/' }],
      SITE,
      CONFIG,
      merged,
    )!;
    for (const loc of ['https://example.com/blog/my-post', 'https://example.com/pl/blog/moj-post']) {
      const block = urlBlock(xml, loc);
      expect(block).toContain('<xhtml:link rel="alternate" hreflang="en-US" href="https://example.com/blog/my-post"/>');
      expect(block).toContain(
        '<xhtml:link rel="alternate" hreflang="pl-PL" href="https://example.com/pl/blog/moj-post"/>',
      );
      expect(block).toContain(
        '<xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/blog/my-post"/>',
      );
    }
  });

  test('CMS item hidden for a locale (_draftLocales) advertises only its published locales', () => {
    const merged: SlugMap[] = [
      ...MAPPINGS,
      // pl hidden → the loader omitted it; exactLocales suppresses the fallback alternate.
      { pageId: 'blog/my-post', slugs: { en: 'blog/my-post' }, exactLocales: true } as SlugMap,
    ];
    const xml = buildSitemapXml([{ pathname: 'blog/my-post/' }], SITE, CONFIG, merged)!;
    const block = urlBlock(xml, 'https://example.com/blog/my-post');
    expect(block).toContain('hreflang="en-US"');
    expect(block).not.toContain('hreflang="pl-PL"');
  });

  test('single-locale project: plain sitemap, no alternates, no xhtml namespace', () => {
    const xml = buildSitemapXml([{ pathname: '' }, { pathname: 'about/' }], SITE, SINGLE, MAPPINGS)!;
    expect(xml).toContain('<url><loc>https://example.com/</loc></url>');
    expect(xml).toContain('<url><loc>https://example.com/about</loc></url>');
    expect(xml).not.toContain('xhtml');
  });

  test('404/500 error routes are excluded (any emitted form)', () => {
    const xml = buildSitemapXml(
      [
        { pathname: 'about/' },
        { pathname: '404/' },
        { pathname: '404.html' },
        { pathname: '500/' },
        { pathname: '500.html' },
      ],
      SITE,
      CONFIG,
      MAPPINGS,
    )!;
    expect(xml).toContain('https://example.com/about');
    expect(xml).not.toContain('404');
    expect(xml).not.toContain('500');
  });

  test('localized 404 twins (<locale>/404) are excluded; non-locale …/404 paths stay', () => {
    const xml = buildSitemapXml(
      [
        { pathname: 'about/' },
        { pathname: 'pl/404/' }, // the locale route's localized 404 build output
        { pathname: 'pl/404/index.html' },
        { pathname: 'archive/404/' }, // NOT a locale — a real (if odd) user page
      ],
      SITE,
      CONFIG,
      MAPPINGS,
    )!;
    expect(xml).not.toContain('https://example.com/pl/404');
    // The locale-keyed check keeps genuine pages: 'archive' is not a configured code.
    expect(xml).toContain('<loc>https://example.com/archive/404</loc>');
  });

  test("pathname forms normalize to the same clean URL ('' / 'about/' / 'about/index.html' / '/about')", () => {
    const xml = buildSitemapXml(
      [{ pathname: 'about/' }, { pathname: 'about/index.html' }, { pathname: '/about' }, { pathname: 'about' }],
      SITE,
      SINGLE,
      [],
    )!;
    // All four collapse into ONE deduped entry with a clean absolute URL.
    expect(xml.match(/<url>/g)).toHaveLength(1);
    expect(xml).toContain('<loc>https://example.com/about</loc>');
  });

  test('empty pages → null; only-error-routes → null (no empty <urlset> written)', () => {
    expect(buildSitemapXml([], SITE, CONFIG, MAPPINGS)).toBeNull();
    expect(buildSitemapXml([{ pathname: '404/' }], SITE, CONFIG, MAPPINGS)).toBeNull();
  });

  test('output is sorted and well-formed (header, urlset, trailing newline)', () => {
    const xml = buildSitemapXml([{ pathname: 'zeta/' }, { pathname: 'alpha/' }], SITE, SINGLE, [])!;
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset ')).toBe(true);
    expect(xml.endsWith('</urlset>\n')).toBe(true);
    expect(xml.indexOf('alpha')).toBeLessThan(xml.indexOf('zeta'));
  });

  test('URLs are XML-escaped', () => {
    const xml = buildSitemapXml([{ pathname: 'a&b/' }], SITE, SINGLE, [])!;
    expect(xml).toContain('<loc>https://example.com/a&amp;b</loc>');
    expect(xml).not.toContain('a&b');
  });
});

describe('buildSitemapXml — per-page sitemap meta (priority/changefreq/exclude)', () => {
  test('exclude drops the page (single-locale)', () => {
    const meta = new Map([['secret', { exclude: true }]]);
    const xml = buildSitemapXml([{ pathname: '' }, { pathname: 'secret/' }], SITE, SINGLE, [], meta)!;
    expect(xml).toContain('<loc>https://example.com/</loc>');
    expect(xml).not.toContain('/secret');
  });

  test('exclude keyed by every locale variant drops all of them', () => {
    // The author excludes the `about` page; loadSitemapMeta keys both '/about' and '/pl/o-nas'.
    const meta = new Map([
      ['about', { exclude: true }],
      ['pl/o-nas', { exclude: true }],
    ]);
    const xml = buildSitemapXml(
      [{ pathname: '' }, { pathname: 'about/' }, { pathname: 'pl/o-nas/' }],
      SITE,
      CONFIG,
      MAPPINGS,
      meta,
    )!;
    expect(xml).not.toContain('/about');
    expect(xml).not.toContain('/pl/o-nas');
    expect(xml).toContain('<loc>https://example.com/</loc>');
  });

  test('priority + changefreq are emitted (sitemaps.org order: loc, changefreq, priority)', () => {
    const meta = new Map([['', { priority: 1, changefreq: 'daily' }]]);
    const xml = buildSitemapXml([{ pathname: '' }], SITE, SINGLE, [], meta)!;
    expect(xml).toMatch(
      /<loc>https:\/\/example\.com\/<\/loc>\s*<changefreq>daily<\/changefreq>\s*<priority>1<\/priority>/,
    );
  });

  test('annotations coexist with hreflang alternates', () => {
    const meta = new Map([
      ['about', { priority: 0.8, changefreq: 'weekly' }],
      ['pl/o-nas', { priority: 0.8, changefreq: 'weekly' }],
    ]);
    const xml = buildSitemapXml([{ pathname: 'about/' }, { pathname: 'pl/o-nas/' }], SITE, CONFIG, MAPPINGS, meta)!;
    const block = urlBlock(xml, 'https://example.com/about');
    expect(block).toContain('<changefreq>weekly</changefreq>');
    expect(block).toContain('<priority>0.8</priority>');
    expect(block).toContain('<xhtml:link rel="alternate"');
  });

  test('pages without meta are unaffected (no annotations)', () => {
    const xml = buildSitemapXml([{ pathname: 'plain/' }], SITE, SINGLE, [], new Map())!;
    expect(xml).toContain('<url><loc>https://example.com/plain</loc></url>');
    expect(xml).not.toContain('<priority>');
  });
});

describe('normalizePagePath anchoring (via buildSitemapXml)', () => {
  test("a page whose segment merely ENDS in 'index.html' is not truncated (file format)", () => {
    const xml = buildSitemapXml(
      [{ pathname: 'zindex.html' }],
      'https://example.com',
      { defaultLocale: 'en', locales: [{ code: 'en', name: 'E', nativeName: 'E', langTag: 'en-US' }] },
      [],
    );
    expect(xml).toContain('<loc>https://example.com/zindex.html</loc>');
    expect(xml).not.toContain('<loc>https://example.com/z</loc>');
  });
});
