import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { loadSlugMappings, has404Page, clearSlugMappingsCache } from './loadSlugMappings';

const tmps: string[] = [];

/** A scratch project with the given `src/pages` files (relPath → file source). */
function projectWith(pages: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'load-slugs-'));
  tmps.push(dir);
  for (const [rel, src] of Object.entries(pages)) {
    const abs = join(dir, 'src', 'pages', rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, src, 'utf8');
  }
  return dir;
}

/** A minimal emitted page with the given meta literal in its frontmatter. */
function pageWithMeta(metaLiteral: string): string {
  return `---\nimport BaseLayout from 'meno-astro/components/BaseLayout.astro';\nconst meta = ${metaLiteral};\n---\n<BaseLayout meta={meta} />\n`;
}

afterEach(() => {
  clearSlugMappingsCache();
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe('loadSlugMappings', () => {
  test('collects meta.slugs from pages that have them (emitted multi-line form)', () => {
    const root = projectWith({
      'about.astro': pageWithMeta(
        `{\n  title: { _i18n: true, en: "About Us", pl: "O nas" },\n  slugs: { en: "about", pl: "o-nas" }\n}`,
      ),
    });
    expect(loadSlugMappings(root)).toEqual([
      { pageId: 'about', slugs: { en: 'about', pl: 'o-nas' } },
    ]);
  });

  test('pages without slugs get the SSR `_default` shape (index → "")', () => {
    const root = projectWith({
      'index.astro': pageWithMeta(`{ title: "Home" }`),
      'contact.astro': pageWithMeta(`{ title: "Contact" }`),
    });
    expect(loadSlugMappings(root)).toEqual([
      { pageId: 'contact', slugs: { _default: 'contact' } },
      { pageId: 'index', slugs: { _default: '' } },
    ]);
  });

  test('default-locale slug is ALWAYS the filename (stale meta entry overridden)', () => {
    // Stale data shape: a default-locale slug edit that predates the rename flow
    // left meta.slugs.en disagreeing with the filename. The filename is the real
    // route — honoring "about-us" would break every lookup keyed by /about.
    const root = projectWith({
      'about.astro': pageWithMeta(`{ slugs: { pl: "o-nas", en: "about-us" } }`),
    });
    expect(loadSlugMappings(root)).toEqual([
      { pageId: 'about', slugs: { pl: 'o-nas', en: 'about' } },
    ]);
  });

  test('default-locale override respects a non-en default from project.config.json', () => {
    const root = projectWith({
      'o-nas.astro': pageWithMeta(`{ slugs: { pl: "inny", en: "about" } }`),
    });
    writeFileSync(
      join(root, 'project.config.json'),
      JSON.stringify({ i18n: { defaultLocale: 'pl', locales: ['pl', 'en'] } }),
      'utf8',
    );
    expect(loadSlugMappings(root)).toEqual([
      { pageId: 'o-nas', slugs: { pl: 'o-nas', en: 'about' } },
    ]);
  });

  test('legacy `export const meta` pages are read too', () => {
    const root = projectWith({
      'about.astro': `---\nexport const meta = { slugs: { en: "about", pl: "o-nas" } };\n---\n<div />\n`,
    });
    expect(loadSlugMappings(root)).toEqual([
      { pageId: 'about', slugs: { en: 'about', pl: 'o-nas' } },
    ]);
  });

  test('nested pages keep their full route path as pageId (and as the default slug)', () => {
    // Slugs are full path-after-locale (translatePath semantics) — the en URL of
    // docs/intro.astro is /docs/intro, so the filename override is the full path too.
    const root = projectWith({
      'docs/intro.astro': pageWithMeta(`{ slugs: { en: "intro", pl: "wstep" } }`),
    });
    expect(loadSlugMappings(root)).toEqual([
      { pageId: 'docs/intro', slugs: { en: 'docs/intro', pl: 'wstep' } },
    ]);
  });

  test('dynamic routes and error pages are excluded (CMS templates, 404/500)', () => {
    const root = projectWith({
      'blog/[slug].astro': pageWithMeta(`{ source: "cms" }`),
      '[...rest].astro': pageWithMeta(`{}`),
      '404.astro': pageWithMeta(`{}`),
      '500.astro': pageWithMeta(`{}`),
      'about.astro': pageWithMeta(`{ slugs: { en: "about" } }`),
    });
    expect(loadSlugMappings(root).map((m) => m.pageId)).toEqual(['about']);
  });

  test('has404Page: the slug-map-free existence check the localized-404 enumeration gates on', () => {
    // 404.astro is excluded from the map (above) but its EXISTENCE must still be
    // observable — the locale route builds /<locale>/404 twins only when it is real.
    const with404 = projectWith({
      '404.astro': pageWithMeta(`{}`),
      'about.astro': pageWithMeta(`{ slugs: { en: "about" } }`),
    });
    expect(has404Page(with404)).toBe(true);
    expect(loadSlugMappings(with404).map((m) => m.pageId)).toEqual(['about']); // still excluded

    const without404 = projectWith({ 'about.astro': pageWithMeta(`{}`) });
    expect(has404Page(without404)).toBe(false);

    // No src/pages at all → false, never throws.
    const empty = mkdtempSync(join(tmpdir(), 'load-slugs-no404-'));
    tmps.push(empty);
    expect(has404Page(empty)).toBe(false);
  });

  test('malformed meta / non-record slugs degrade to the `_default` entry', () => {
    const root = projectWith({
      'broken.astro': '---\nconst meta = { slugs: not a literal !;\n---\n<div />',
      'arr.astro': pageWithMeta(`{ slugs: ["en"] }`),
      'nonstr.astro': pageWithMeta(`{ slugs: { en: 5 } }`),
      'empty.astro': pageWithMeta(`{ slugs: {} }`),
    });
    expect(loadSlugMappings(root)).toEqual([
      { pageId: 'arr', slugs: { _default: 'arr' } },
      { pageId: 'broken', slugs: { _default: 'broken' } },
      { pageId: 'empty', slugs: { _default: 'empty' } },
      { pageId: 'nonstr', slugs: { _default: 'nonstr' } },
    ]);
  });

  test('no src/pages dir → [] (never throws)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-slugs-empty-'));
    tmps.push(dir);
    expect(loadSlugMappings(dir)).toEqual([]);
  });

  test('mtime cache: rewritten slugs take effect; deleted pages drop out', () => {
    const root = projectWith({
      'about.astro': pageWithMeta(`{ slugs: { en: "about", pl: "o-nas" } }`),
      'old.astro': pageWithMeta(`{ slugs: { en: "old" } }`),
    });
    expect(loadSlugMappings(root).map((m) => m.slugs.pl ?? m.slugs.en)).toEqual(['o-nas', 'old']);

    // Rewrite about.astro with a new pl slug and a bumped mtime (editor-save shape).
    const aboutPath = join(root, 'src', 'pages', 'about.astro');
    writeFileSync(aboutPath, pageWithMeta(`{ slugs: { en: "about", pl: "o-firmie" } }`), 'utf8');
    const future = new Date(Date.now() + 5_000);
    utimesSync(aboutPath, future, future);
    rmSync(join(root, 'src', 'pages', 'old.astro'));

    expect(loadSlugMappings(root)).toEqual([
      { pageId: 'about', slugs: { en: 'about', pl: 'o-firmie' } },
    ]);
  });
});
