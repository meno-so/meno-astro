import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import {
  loadCmsSlugMappings,
  resolveCmsEntrySlug,
  clearCmsSlugMappingsCache,
} from './loadCmsSlugMappings';
import { loadSlugMappings, clearSlugMappingsCache } from './loadSlugMappings';
import type { CmsAwareSlugMap } from '../runtime/localeRoutes';

const tmps: string[] = [];

/** A scratch project with the given files (relPath → source; objects are JSON-stringified). */
function projectWith(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), 'load-cms-slugs-'));
  tmps.push(dir);
  for (const [rel, src] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof src === 'string' ? src : JSON.stringify(src, null, 2), 'utf8');
  }
  return dir;
}

/** The emitted CMS template shape `readPageMeta` reads (boilerplate omitted — parser-irrelevant here). */
function cmsTemplate(cmsLiteral: string): string {
  return `---\nimport { getCollection } from 'astro:content';\nconst meta = {\n  source: "cms",\n  cms: ${cmsLiteral}\n};\n---\n<div />\n`;
}

const I18N = JSON.stringify({
  i18n: { defaultLocale: 'en', locales: ['en', 'pl', 'de'] },
});

const BLOG_TEMPLATE = cmsTemplate(`{ id: "blog", slugField: "slug", urlPattern: "/blog/{{slug}}", fields: {} }`);

afterEach(() => {
  clearCmsSlugMappingsCache();
  clearSlugMappingsCache();
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe('loadCmsSlugMappings', () => {
  test('i18n slug → one full-path slug per locale; missing locale falls back (JSON-build parity)', () => {
    const root = projectWith({
      'project.config.json': I18N,
      'src/pages/blog/[slug].astro': BLOG_TEMPLATE,
      'src/content/blog/my-post.json': {
        _id: 'post-1',
        slug: { _i18n: true, en: 'my-post', pl: 'moj-post' }, // no de → falls back to en
        title: { _i18n: true, en: 'Hello', pl: 'Czesc' },
      },
    });
    expect(loadCmsSlugMappings(root)).toEqual([
      {
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
        },
      },
    ]);
  });

  test('plain-string slug → the same slug for every locale (item exists everywhere)', () => {
    const root = projectWith({
      'project.config.json': I18N,
      'src/pages/blog/[slug].astro': BLOG_TEMPLATE,
      'src/content/blog/static-post.json': { _id: 'p', slug: 'static-post' },
    });
    expect(loadCmsSlugMappings(root)[0]!.map.slugs).toEqual({
      en: 'blog/static-post',
      pl: 'blog/static-post',
      de: 'blog/static-post',
    });
  });

  test('missing slug field → filename fallback (the boilerplate\'s `?? entry.id` contract)', () => {
    const root = projectWith({
      'project.config.json': I18N,
      'src/pages/blog/[slug].astro': BLOG_TEMPLATE,
      'src/content/blog/no-slug.json': { _id: 'something-else', title: 'X' },
    });
    expect(loadCmsSlugMappings(root)[0]!.map.pageId).toBe('blog/no-slug');
  });

  test('custom slugField from meta.cms is honored', () => {
    const root = projectWith({
      'project.config.json': I18N,
      'src/pages/work/[slug].astro': cmsTemplate(
        `{ id: "work", slugField: "urlSlug", urlPattern: "/work/{{slug}}", fields: {} }`,
      ),
      'src/content/work/case.json': { urlSlug: { _i18n: true, en: 'case', pl: 'realizacja' } },
    });
    expect(loadCmsSlugMappings(root)[0]!.map.slugs.pl).toBe('work/realizacja');
  });

  test('*.draft.json siblings (WIP versions) are skipped entirely', () => {
    const root = projectWith({
      'project.config.json': I18N,
      'src/pages/blog/[slug].astro': BLOG_TEMPLATE,
      'src/content/blog/published.json': { slug: 'published' },
      'src/content/blog/published.draft.json': { slug: 'published-edited' },
      'src/content/blog/unpublished.draft.json': { slug: 'never-published' },
    });
    const entries = loadCmsSlugMappings(root);
    expect(entries.map((e) => e.map.pageId)).toEqual(['blog/published']);
  });

  test('per-locale draft (_draftLocales) omits that locale; the DEFAULT locale is never omitted', () => {
    const root = projectWith({
      'project.config.json': I18N,
      'src/pages/blog/[slug].astro': BLOG_TEMPLATE,
      'src/content/blog/pl-hidden.json': {
        slug: { _i18n: true, en: 'pl-hidden', pl: 'ukryty' },
        _draftLocales: ['pl'],
      },
      // Hidden for the default locale too — but the emitted boilerplate still builds
      // the default URL unconditionally, so the map must keep it routable.
      'src/content/blog/en-hidden.json': {
        slug: 'en-hidden',
        _draftLocales: ['en', 'de'],
      },
    });
    const byId = new Map(loadCmsSlugMappings(root).map((e) => [e.map.pageId, e.map.slugs]));
    expect(byId.get('blog/pl-hidden')).toEqual({ en: 'blog/pl-hidden', de: 'blog/pl-hidden' });
    expect(byId.get('blog/en-hidden')).toEqual({ en: 'blog/en-hidden', pl: 'blog/en-hidden' });
  });

  test('unparseable / non-object item JSON is skipped (never throws)', () => {
    const root = projectWith({
      'project.config.json': I18N,
      'src/pages/blog/[slug].astro': BLOG_TEMPLATE,
      'src/content/blog/broken.json': '{ not json',
      'src/content/blog/array.json': '[1, 2]',
      'src/content/blog/ok.json': { slug: 'ok' },
    });
    expect(loadCmsSlugMappings(root).map((e) => e.map.pageId)).toEqual(['blog/ok']);
  });

  test('nested route dirs: the FILE location (not the urlPattern) is the route prefix', () => {
    const root = projectWith({
      'project.config.json': I18N,
      'src/pages/docs/guides/[slug].astro': cmsTemplate(
        `{ id: "guides", slugField: "slug", urlPattern: "/docs/guides/{{slug}}", fields: {} }`,
      ),
      'src/content/guides/intro.json': { slug: { _i18n: true, en: 'intro', pl: 'wstep' } },
    });
    expect(loadCmsSlugMappings(root)).toEqual([
      {
        map: {
          pageId: 'docs/guides/intro',
          slugs: { en: 'docs/guides/intro', pl: 'docs/guides/wstep', de: 'docs/guides/intro' },
          exactLocales: true,
        },
        templateId: 'docs/guides/[slug]',
        item: { slug: { _i18n: true, en: 'intro', pl: 'wstep' } },
      },
    ]);
  });

  test('root-level template (the {{locale}}-pattern emit degrade) routes at the pages root', () => {
    // "/{{locale}}/blog/{{slug}}" patterns degrade to src/pages/[slug].astro at emit
    // time (cmsRouteDirFromUrlPattern) — the loader maps what exists on disk.
    const root = projectWith({
      'project.config.json': I18N,
      'src/pages/[slug].astro': cmsTemplate(
        `{ id: "posts", slugField: "slug", urlPattern: "/{{locale}}/blog/{{slug}}", fields: {} }`,
      ),
      'src/content/posts/hello.json': { slug: { _i18n: true, en: 'hello', pl: 'czesc' } },
    });
    expect(loadCmsSlugMappings(root)).toEqual([
      {
        map: {
          pageId: 'hello',
          slugs: { en: 'hello', pl: 'czesc', de: 'hello' },
          exactLocales: true,
        },
        templateId: '[slug]',
        item: { slug: { _i18n: true, en: 'hello', pl: 'czesc' } },
      },
    ]);
  });

  test('non-CMS [slug].astro, bad collection ids, and missing content dirs contribute nothing', () => {
    const root = projectWith({
      'project.config.json': I18N,
      'src/pages/things/[slug].astro': `---\nconst meta = { title: "not cms" };\n---\n<div />\n`,
      'src/pages/evil/[slug].astro': cmsTemplate(`{ id: "../escape", slugField: "slug" }`),
      'src/pages/ghost/[slug].astro': cmsTemplate(`{ id: "ghost", slugField: "slug" }`), // no src/content/ghost
    });
    expect(loadCmsSlugMappings(root)).toEqual([]);
  });

  test('no src/pages dir → [] (never throws)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-cms-slugs-empty-'));
    tmps.push(dir);
    expect(loadCmsSlugMappings(dir)).toEqual([]);
  });

  test('mtime cache: rewritten items take effect; deleted items drop out', () => {
    const root = projectWith({
      'project.config.json': I18N,
      'src/pages/blog/[slug].astro': BLOG_TEMPLATE,
      'src/content/blog/a.json': { slug: { _i18n: true, en: 'a', pl: 'a-pl' } },
      'src/content/blog/old.json': { slug: 'old' },
    });
    expect(loadCmsSlugMappings(root).map((e) => e.map.slugs.pl)).toEqual(['blog/a-pl', 'blog/old']);

    const aPath = join(root, 'src', 'content', 'blog', 'a.json');
    writeFileSync(aPath, JSON.stringify({ slug: { _i18n: true, en: 'a', pl: 'nowy-a' } }), 'utf8');
    const future = new Date(Date.now() + 5_000);
    utimesSync(aPath, future, future);
    rmSync(join(root, 'src', 'content', 'blog', 'old.json'));

    expect(loadCmsSlugMappings(root).map((e) => e.map.slugs.pl)).toEqual(['blog/nowy-a']);
  });

  test('mtime cache: template slugField edits take effect', () => {
    const root = projectWith({
      'project.config.json': I18N,
      'src/pages/blog/[slug].astro': BLOG_TEMPLATE,
      'src/content/blog/x.json': { slug: 'from-slug', altSlug: 'from-alt' },
    });
    expect(loadCmsSlugMappings(root)[0]!.map.pageId).toBe('blog/from-slug');

    const tplPath = join(root, 'src', 'pages', 'blog', '[slug].astro');
    writeFileSync(
      tplPath,
      cmsTemplate(`{ id: "blog", slugField: "altSlug", urlPattern: "/blog/{{slug}}", fields: {} }`),
      'utf8',
    );
    const future = new Date(Date.now() + 5_000);
    utimesSync(tplPath, future, future);

    expect(loadCmsSlugMappings(root)[0]!.map.pageId).toBe('blog/from-alt');
  });
});

describe('loadSlugMappings (merged pages + CMS)', () => {
  test('CMS item entries join the page map (sorted; exactLocales marks them)', () => {
    const root = projectWith({
      'project.config.json': I18N,
      'src/pages/about.astro': `---\nconst meta = { slugs: { en: "about", pl: "o-nas" } };\n---\n<div />\n`,
      'src/pages/blog/[slug].astro': BLOG_TEMPLATE,
      'src/content/blog/my-post.json': { slug: { _i18n: true, en: 'my-post', pl: 'moj-post' } },
    });
    expect(loadSlugMappings(root) as CmsAwareSlugMap[]).toEqual([
      { pageId: 'about', slugs: { en: 'about', pl: 'o-nas' } },
      {
        pageId: 'blog/my-post',
        slugs: { en: 'blog/my-post', pl: 'blog/moj-post', de: 'blog/my-post' },
        exactLocales: true,
      },
    ]);
  });
});

describe('resolveCmsEntrySlug', () => {
  /** Run `fn` with cwd at `root` (the content.config.ts runtime contract). */
  function atRoot<T>(root: string, fn: () => T): T {
    const prev = process.cwd();
    process.chdir(root);
    try {
      return fn();
    } finally {
      process.chdir(prev);
    }
  }

  test('i18n slug resolves to the default-locale string (other fields untouched)', () => {
    const root = projectWith({
      'project.config.json': I18N,
      'src/pages/blog/[slug].astro': BLOG_TEMPLATE,
    });
    const data = {
      slug: { _i18n: true, en: 'my-post', pl: 'moj-post' },
      title: { _i18n: true, en: 'Hello', pl: 'Czesc' },
    };
    expect(atRoot(root, () => resolveCmsEntrySlug(data, 'blog'))).toEqual({
      slug: 'my-post',
      title: { _i18n: true, en: 'Hello', pl: 'Czesc' },
    });
  });

  test('plain slug → data returned unchanged (same reference, zero-copy)', () => {
    const root = projectWith({
      'project.config.json': I18N,
      'src/pages/blog/[slug].astro': BLOG_TEMPLATE,
    });
    const data = { slug: 'my-post' };
    expect(atRoot(root, () => resolveCmsEntrySlug(data, 'blog'))).toBe(data);
  });

  test('degenerate i18n slug (no usable string) is DROPPED so the boilerplate falls back to entry.id', () => {
    const root = projectWith({
      'project.config.json': I18N,
      'src/pages/blog/[slug].astro': BLOG_TEMPLATE,
    });
    const data = { slug: { _i18n: true }, title: 'T' };
    expect(atRoot(root, () => resolveCmsEntrySlug(data, 'blog'))).toEqual({ title: 'T' });
  });

  test('custom slugField is read from the template at call time; unknown collections default to "slug"', () => {
    const root = projectWith({
      'project.config.json': I18N,
      'src/pages/work/[slug].astro': cmsTemplate(
        `{ id: "work", slugField: "urlSlug", urlPattern: "/work/{{slug}}", fields: {} }`,
      ),
    });
    expect(
      atRoot(root, () => resolveCmsEntrySlug({ urlSlug: { _i18n: true, en: 'case' } }, 'work')),
    ).toEqual({ urlSlug: 'case' });
    expect(
      atRoot(root, () => resolveCmsEntrySlug({ slug: { _i18n: true, en: 'x' } }, 'nope')),
    ).toEqual({ slug: 'x' });
  });
});
