import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { localizeHref, localizeHrefFor, localizeRichTextLinks } from './localizeHref';
import { runWithLocale } from './i18n';
import { clearSlugMappingsCache } from '../server/loadSlugMappings';
import type { I18nConfig } from 'meno-core/shared';
import type { SlugMap } from 'meno-core/shared';

const CONFIG: I18nConfig = {
  defaultLocale: 'en',
  locales: [
    { code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' },
    { code: 'pl', name: 'Polish', nativeName: 'Polski', langTag: 'pl-PL' },
  ],
};

const MAPPINGS: SlugMap[] = [
  { pageId: 'about', slugs: { en: 'about', pl: 'o-nas' } },
  { pageId: 'contact', slugs: { _default: 'contact' } },
  { pageId: 'index', slugs: { _default: '' } },
];

describe('localizeHrefFor (pure)', () => {
  test('slug-translates a mapped page for a non-default locale', () => {
    expect(localizeHrefFor('/about', 'pl', CONFIG, MAPPINGS)).toBe('/pl/o-nas');
  });

  test('slug-translates a CMS item href through the merged map', () => {
    // loadSlugMappings merges one entry per published CMS item, so authored links to
    // CMS items (/blog/my-post) localize exactly like page links on /pl renders.
    const merged: SlugMap[] = [
      ...MAPPINGS,
      {
        pageId: 'blog/my-post',
        slugs: { en: 'blog/my-post', pl: 'blog/moj-post' },
        exactLocales: true,
      } as SlugMap,
    ];
    expect(localizeHrefFor('/blog/my-post', 'pl', CONFIG, merged)).toBe('/pl/blog/moj-post');
    expect(localizeHrefFor('/blog/my-post', 'en', CONFIG, merged)).toBe('/blog/my-post');
  });

  test('prefix-only for slugless pages and the root', () => {
    expect(localizeHrefFor('/contact', 'pl', CONFIG, MAPPINGS)).toBe('/pl/contact');
    expect(localizeHrefFor('/', 'pl', CONFIG, MAPPINGS)).toBe('/pl');
  });

  test('default locale → unchanged', () => {
    expect(localizeHrefFor('/about', 'en', CONFIG, MAPPINGS)).toBe('/about');
    expect(localizeHrefFor('/', 'en', CONFIG, MAPPINGS)).toBe('/');
  });

  test('no slug map → bare locale prefix (SSR fallback parity)', () => {
    expect(localizeHrefFor('/about', 'pl', CONFIG, [])).toBe('/pl/about');
    expect(localizeHrefFor('/about', 'en', CONFIG, [])).toBe('/about');
  });

  test('external / protocol-relative / anchor / mail hrefs pass through', () => {
    for (const href of ['https://x.com/a', '//cdn.x.com/a', '#section', 'mailto:a@b.c', '']) {
      expect(localizeHrefFor(href, 'pl', CONFIG, MAPPINGS)).toBe(href);
    }
  });

  test('query/hash suffixes survive slug translation (no prefix-swap degrade)', () => {
    // The suffix would otherwise defeat the index lookup, degrading to
    // /pl/about#team — a route the static build never emits when a pl slug exists.
    expect(localizeHrefFor('/about#team', 'pl', CONFIG, MAPPINGS)).toBe('/pl/o-nas#team');
    expect(localizeHrefFor('/about?ref=x', 'pl', CONFIG, MAPPINGS)).toBe('/pl/o-nas?ref=x');
    expect(localizeHrefFor('/contact?a=1#b', 'pl', CONFIG, MAPPINGS)).toBe('/pl/contact?a=1#b');
    expect(localizeHrefFor('/?x=1', 'pl', CONFIG, MAPPINGS)).toBe('/pl?x=1');
    expect(localizeHrefFor('/about#team', 'en', CONFIG, MAPPINGS)).toBe('/about#team');
  });

  test('exactLocales (CMS): a link to a draft-hidden-locale item keeps the authored URL', () => {
    // The item is hidden in pl (_draftLocales) — its /pl/... URL was never built.
    // Fabricating /pl/blog/my-post via the default-slug fallback would 404; the
    // authored default-locale URL exists, so it stays. Same rule hreflang/LocaleList apply.
    const merged: SlugMap[] = [
      ...MAPPINGS,
      {
        pageId: 'blog/my-post',
        slugs: { en: 'blog/my-post' },
        exactLocales: true,
      } as SlugMap,
    ];
    expect(localizeHrefFor('/blog/my-post', 'pl', CONFIG, merged)).toBe('/blog/my-post');
    expect(localizeHrefFor('/blog/my-post', 'en', CONFIG, merged)).toBe('/blog/my-post');
    // A published locale still translates normally.
    const published: SlugMap[] = [
      ...MAPPINGS,
      {
        pageId: 'blog/my-post',
        slugs: { en: 'blog/my-post', pl: 'blog/moj-post' },
        exactLocales: true,
      } as SlugMap,
    ];
    expect(localizeHrefFor('/blog/my-post', 'pl', CONFIG, published)).toBe('/pl/blog/moj-post');
  });
});

describe('localizeHref / localizeRichTextLinks (locale context + project slug map)', () => {
  const tmps: string[] = [];
  const savedCwd = process.cwd();
  afterEach(() => {
    process.chdir(savedCwd);
    clearSlugMappingsCache();
    while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
  });

  /** A scratch astro project (cwd-based, like the components call it) with slugged pages. */
  function projectWithPages(): string {
    const dir = mkdtempSync(join(tmpdir(), 'localize-href-'));
    tmps.push(dir);
    const write = (rel: string, meta: string) => {
      const abs = join(dir, 'src', 'pages', rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `---\nconst meta = ${meta};\n---\n<div />\n`, 'utf8');
    };
    write('about.astro', '{ slugs: { en: "about", pl: "o-nas" } }');
    write('index.astro', '{ title: "Home" }');
    return dir;
  }

  test('rewrites inside a non-default locale context; untouched outside / for default', () => {
    process.chdir(projectWithPages());
    expect(runWithLocale('pl', CONFIG, () => localizeHref('/about'))).toBe('/pl/o-nas');
    expect(runWithLocale('en', CONFIG, () => localizeHref('/about'))).toBe('/about');
    expect(localizeHref('/about')).toBe('/about'); // no context (e.g. unit render)
    expect(runWithLocale('pl', CONFIG, () => localizeHref('https://x.com'))).toBe('https://x.com');
  });

  test('rich-text anchors rewrite, external anchors stay', () => {
    process.chdir(projectWithPages());
    const html = '<p><a href="/about">About</a> and <a href="https://x.com">X</a></p>';
    expect(runWithLocale('pl', CONFIG, () => localizeRichTextLinks(html))).toBe(
      '<p><a href="/pl/o-nas">About</a> and <a href="https://x.com">X</a></p>',
    );
    expect(runWithLocale('en', CONFIG, () => localizeRichTextLinks(html))).toBe(html);
  });
});
