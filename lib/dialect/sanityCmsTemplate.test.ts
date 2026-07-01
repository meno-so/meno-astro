import { test, expect, describe } from 'bun:test';
import { emit, parse, normalizeModel } from './index';

/**
 * A Sanity-backed CMS template (`meta.source: 'cms'` + `meta.cms.source: 'sanity'`) emits a
 * `getStaticPaths()` that fetches via `getSanityData(documentType)` instead of `getCollection`,
 * and must NOT import `astro:content` (no content collection exists). The `meta.cms.source` /
 * `documentType` discriminator round-trips as plain meta. Items are read-only (authored in Sanity).
 */
const sanityTemplate = {
  meta: {
    title: '{{cms.title}}',
    source: 'cms' as const,
    cms: {
      id: 'post',
      source: 'sanity' as const,
      documentType: 'post',
      slugField: 'slug',
      urlPattern: '/blog/{{slug}}',
      fields: { slug: { type: 'string' }, title: { type: 'string' } },
    },
  },
  root: { type: 'node' as const, tag: 'article', children: ['{{cms.title}}'] },
};

describe('Sanity-backed CMS template', () => {
  test('getStaticPaths fetches via getSanityData; no astro:content import', () => {
    const out = emit(sanityTemplate as any);
    expect(out).toContain('await getSanityData("post", {}, Astro)');
    expect(out).toContain('params: { slug: item.slug ?? item._id }');
    expect(out).toContain('props: { cms: item }');
    expect(out).not.toContain("from 'astro:content'");
    expect(out).not.toContain('getCollection');
    // Still statically prerendered (the standard Sanity+Astro pattern).
    expect(out).toContain('export const prerender = true;');
  });

  test('meta.cms.source / documentType round-trip; getStaticPaths is emit-only boilerplate', () => {
    const n = normalizeModel(sanityTemplate);
    expect(parse(emit(n as any)).model).toEqual(n as any);
    // The emitted body is recognized + skipped (not captured as foreign passthrough).
    expect(JSON.stringify(parse(emit(n as any)).model)).not.toContain('_frontmatter');
  });

  test('a file-backed CMS template still uses getCollection (no regression)', () => {
    const fileBacked = {
      meta: {
        title: '{{cms.title}}',
        source: 'cms' as const,
        cms: { id: 'blog', slugField: 'slug', urlPattern: '/blog/{{slug}}', fields: { title: { type: 'string' } } },
      },
      root: { type: 'node' as const, tag: 'article', children: ['{{cms.title}}'] },
    };
    const out = emit(fileBacked as any);
    expect(out).toContain("from 'astro:content'");
    expect(out).toContain('getCollection("blog")');
    expect(out).not.toContain('getSanityData');
  });
});
