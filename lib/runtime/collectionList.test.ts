import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { getCollectionList, queryList } from './collectionList';
import { clearCmsSlugMappingsCache } from '../server/loadCmsSlugMappings';
import { loadSlugMappings, clearSlugMappingsCache } from '../server/loadSlugMappings';
import { loadI18nConfig } from '../server/loadI18nConfig';
import { localizeHrefFor } from './localizeHref';

const tmps: string[] = [];

/** A scratch project with the given files (relPath → source; objects are JSON-stringified). */
function projectWith(files: Record<string, string | object>): string {
  const dir = mkdtempSync(join(tmpdir(), 'collection-list-'));
  tmps.push(dir);
  for (const [rel, src] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof src === 'string' ? src : JSON.stringify(src, null, 2), 'utf8');
  }
  return dir;
}

/** The emitted CMS template shape `readPageMeta` reads (boilerplate omitted — parser-irrelevant). */
function cmsTemplate(cmsLiteral: string): string {
  return `---\nimport { getCollection } from 'astro:content';\nconst meta = {\n  source: "cms",\n  cms: ${cmsLiteral}\n};\n---\n<div />\n`;
}

const I18N_EN = JSON.stringify({ i18n: { defaultLocale: 'en', locales: ['en'] } });
const I18N_MULTI = JSON.stringify({ i18n: { defaultLocale: 'en', locales: ['en', 'pl'] } });
const BLOG_TEMPLATE = cmsTemplate(`{ id: "blog", slugField: "slug", urlPattern: "/blog/{{slug}}", fields: {} }`);

/** A content-layer `getCollection` mock: each entry is `{ id: <filename stem>, data }`. */
function getCollectionFrom(items: Record<string, Record<string, unknown>>) {
  const entries = Object.entries(items).map(([id, data]) => ({ id, data }));
  return async () => entries;
}

/** Run `fn` with cwd at `root` (getCollectionList reads the project from process.cwd()). */
async function atRoot<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.cwd();
  process.chdir(root);
  try {
    return await fn();
  } finally {
    process.chdir(prev);
  }
}

afterEach(() => {
  clearCmsSlugMappingsCache();
  clearSlugMappingsCache();
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe('getCollectionList — _url synthesis', () => {
  test('attaches the canonical /routeDir/slug url each card links to (the blog-list bug)', async () => {
    const root = projectWith({
      'project.config.json': I18N_EN,
      'src/pages/blog/[slug].astro': BLOG_TEMPLATE,
    });
    const getCollection = getCollectionFrom({
      'first-post': { _id: 'first-post', slug: 'first-post', title: 'First' },
      'second-post': { _id: 'second-post', slug: 'second-post', title: 'Second' },
    });
    const list = await atRoot(root, () => getCollectionList('blog', {}, undefined, getCollection));
    expect(list.map((i) => i._url)).toEqual(['/blog/first-post', '/blog/second-post']);
    // Stored fields pass through untouched.
    expect(list[0]!.title).toBe('First');
  });

  test('route dir comes from the FILE location, not the collection id', async () => {
    const root = projectWith({
      'project.config.json': I18N_EN,
      'src/pages/docs/guides/[slug].astro': cmsTemplate(
        `{ id: "guides", slugField: "slug", urlPattern: "/docs/guides/{{slug}}", fields: {} }`,
      ),
    });
    const getCollection = getCollectionFrom({ intro: { slug: 'intro' } });
    const list = await atRoot(root, () => getCollectionList('guides', {}, undefined, getCollection));
    expect(list[0]!._url).toBe('/docs/guides/intro');
  });

  test('custom slugField is honored; missing slug falls back to the entry id (filename)', async () => {
    const root = projectWith({
      'project.config.json': I18N_EN,
      'src/pages/work/[slug].astro': cmsTemplate(
        `{ id: "work", slugField: "urlSlug", urlPattern: "/work/{{slug}}", fields: {} }`,
      ),
    });
    const getCollection = getCollectionFrom({
      'case-a': { urlSlug: 'case-a' },
      'case-b': { title: 'no slug field' }, // → /work/case-b (entry id)
    });
    const list = await atRoot(root, () => getCollectionList('work', {}, undefined, getCollection));
    expect(list.map((i) => i._url)).toEqual(['/work/case-a', '/work/case-b']);
  });

  test('i18n slug → canonical url uses the DEFAULT-locale slug (Link.astro localizes per render)', async () => {
    const root = projectWith({
      'project.config.json': I18N_MULTI,
      'src/pages/blog/[slug].astro': BLOG_TEMPLATE,
    });
    const getCollection = getCollectionFrom({
      post: { slug: { _i18n: true, en: 'my-post', pl: 'moj-post' } },
    });
    const list = await atRoot(root, () => getCollectionList('blog', {}, undefined, getCollection));
    expect(list[0]!._url).toBe('/blog/my-post');
  });

  test('no template for the collection → /<source>/<slug> fallback', async () => {
    const root = projectWith({ 'project.config.json': I18N_EN });
    const getCollection = getCollectionFrom({ x: { slug: 'x' } });
    const list = await atRoot(root, () => getCollectionList('news', {}, undefined, getCollection));
    expect(list[0]!._url).toBe('/news/x');
  });

  test('_id is synthesized from the entry id when the stored item lacks one', async () => {
    const root = projectWith({
      'project.config.json': I18N_EN,
      'src/pages/blog/[slug].astro': BLOG_TEMPLATE,
    });
    const getCollection = getCollectionFrom({
      'has-id': { _id: 'stored-id', slug: 'has-id' },
      'no-id': { slug: 'no-id' },
    });
    const list = await atRoot(root, () => getCollectionList('blog', {}, undefined, getCollection));
    expect(list.map((i) => i._id)).toEqual(['stored-id', 'no-id']);
  });

  test('sort still operates on stored fields; the url rides along on each item', async () => {
    const root = projectWith({
      'project.config.json': I18N_EN,
      'src/pages/blog/[slug].astro': BLOG_TEMPLATE,
    });
    const getCollection = getCollectionFrom({
      a: { slug: 'a', _createdAt: '2026-01-01' },
      b: { slug: 'b', _createdAt: '2026-03-01' },
    });
    const list = await atRoot(root, () =>
      getCollectionList('blog', { sort: { field: '_createdAt', order: 'desc' } }, undefined, getCollection),
    );
    expect(list.map((i) => i._url)).toEqual(['/blog/b', '/blog/a']);
  });

  test('no getCollection (non-Astro context) → empty list, no crash', async () => {
    const root = projectWith({ 'project.config.json': I18N_EN });
    const list = await atRoot(root, () => getCollectionList('blog', {}));
    expect(list).toEqual([]);
  });
});

describe('getCollectionList — localization (end-to-end card link)', () => {
  // The canonical `_url` getCollectionList produces must round-trip through the SAME slug
  // map Link.astro localizes against (`loadSlugMappings` → `localizeHref`). This ties the
  // two halves together: a card link on a /pl render lands on the real localized post.
  test('canonical _url localizes to the active-locale post URL via the merged slug map', async () => {
    const root = projectWith({
      'project.config.json': I18N_MULTI,
      'src/pages/blog/[slug].astro': BLOG_TEMPLATE,
      // The CMS item must exist on disk: loadCmsSlugMappings scans src/content to build
      // the localized slug map (it's not fed by the getCollection mock).
      'src/content/blog/my-post.json': {
        _id: 'my-post',
        slug: { _i18n: true, en: 'my-post', pl: 'moj-post' },
      },
    });
    const getCollection = getCollectionFrom({
      'my-post': { _id: 'my-post', slug: { _i18n: true, en: 'my-post', pl: 'moj-post' } },
    });

    const { url, config, mappings } = await atRoot(root, async () => {
      const list = await getCollectionList('blog', {}, undefined, getCollection);
      return {
        url: list[0]!._url as string,
        config: loadI18nConfig(root),
        mappings: loadSlugMappings(root),
      };
    });

    // getCollectionList emits the default-locale canonical path…
    expect(url).toBe('/blog/my-post');
    // …which Link.astro localizes: default locale unchanged, pl slug-translated.
    expect(localizeHrefFor(url, 'en', config, mappings)).toBe('/blog/my-post');
    expect(localizeHrefFor(url, 'pl', config, mappings)).toBe('/pl/blog/moj-post');
  });

  test('item hidden for a locale keeps the (real) default-locale url instead of a 404', async () => {
    const root = projectWith({
      'project.config.json': I18N_MULTI,
      'src/pages/blog/[slug].astro': BLOG_TEMPLATE,
      'src/content/blog/en-only.json': { _id: 'en-only', slug: 'en-only', _draftLocales: ['pl'] },
    });
    const getCollection = getCollectionFrom({ 'en-only': { _id: 'en-only', slug: 'en-only' } });

    const { url, config, mappings } = await atRoot(root, async () => {
      const list = await getCollectionList('blog', {}, undefined, getCollection);
      return { url: list[0]!._url as string, config: loadI18nConfig(root), mappings: loadSlugMappings(root) };
    });

    expect(url).toBe('/blog/en-only');
    // pl is draft-hidden (exactLocales) → don't fabricate /pl/blog/en-only (never built).
    expect(localizeHrefFor(url, 'pl', config, mappings)).toBe('/blog/en-only');
  });
});

describe('queryList — query an already-fetched array (nested loop-var lists)', () => {
  // A docs sidebar fetches all docs once, then filters per-category INLINE with the outer
  // loop var resolved (`queryList(docsList, { filter: { … value: category._id }, … })`).
  const docs = [
    { _id: 'install', title: 'Installation', category: 'getting-started', order: 1 },
    { _id: 'quickstart', title: 'Quickstart', category: 'getting-started', order: 2 },
    { _id: 'dashboard', title: 'Dashboard', category: 'app', order: 1 },
  ];

  test('filter + sort parity with getCollectionList (eq on the loop-var value)', () => {
    const out = queryList(docs, {
      filter: { field: 'category', operator: 'eq', value: 'getting-started' },
      sort: { field: 'order', order: 'desc' },
    });
    expect(out.map((d) => d._id)).toEqual(['quickstart', 'install']);
  });

  test('null/undefined source → [] (a list that never resolved), no crash', () => {
    expect(queryList(undefined, { filter: { field: 'category', value: 'x' } })).toEqual([]);
    expect(queryList(null)).toEqual([]);
  });

  test('explicit items id list preserves order; excludeCurrentItem drops the page item', () => {
    expect(queryList(docs, { items: ['dashboard', 'install'] }).map((d) => d._id)).toEqual(['dashboard', 'install']);
    const astro = { props: { cms: { _id: 'install' } } };
    expect(
      queryList(docs, { filter: { field: 'category', value: 'getting-started' }, excludeCurrentItem: true }, astro).map(
        (d) => d._id,
      ),
    ).toEqual(['quickstart']);
  });
});
