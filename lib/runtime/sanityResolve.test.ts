import { test, expect, describe } from 'bun:test';
import { assetRefToUrl, resolveScalars, dereference } from './sanityResolve';

const conn = { projectId: 'pid', dataset: 'production' };

describe('assetRefToUrl', () => {
  test('image ref → cdn images URL (keeps dimensions)', () => {
    expect(assetRefToUrl('pid', 'production', 'image-abc123-1200x800-jpg')).toBe(
      'https://cdn.sanity.io/images/pid/production/abc123-1200x800.jpg',
    );
  });
  test('file ref → cdn files URL', () => {
    expect(assetRefToUrl('pid', 'production', 'file-def456-pdf')).toBe(
      'https://cdn.sanity.io/files/pid/production/def456.pdf',
    );
  });
  test('unrecognized ref → null', () => {
    expect(assetRefToUrl('pid', 'production', 'not-an-asset')).toBeNull();
  });
});

describe('resolveScalars', () => {
  test('slug → current string', () => {
    expect(resolveScalars(conn, { _type: 'slug', current: 'hello-world' })).toBe('hello-world');
  });

  test('image / file asset → cdn URL (top-level + nested)', () => {
    const row = {
      title: 'Post',
      cover: { _type: 'image', asset: { _ref: 'image-xyz-2000x1000-webp' } },
      attachments: [{ _type: 'file', asset: { _ref: 'file-doc1-pdf' } }],
      seo: { ogImage: { _type: 'image', asset: { _ref: 'image-og-1200x630-png' } } },
    };
    const out = resolveScalars(conn, row) as Record<string, any>;
    expect(out.cover).toBe('https://cdn.sanity.io/images/pid/production/xyz-2000x1000.webp');
    expect(out.attachments[0]).toBe('https://cdn.sanity.io/files/pid/production/doc1.pdf');
    expect(out.seo.ogImage).toBe('https://cdn.sanity.io/images/pid/production/og-1200x630.png');
  });

  test('Portable Text array → HTML string', () => {
    const body = [
      {
        _type: 'block',
        _key: 'a',
        style: 'normal',
        markDefs: [],
        children: [{ _type: 'span', _key: 's', text: 'Hello world', marks: [] }],
      },
    ];
    const html = resolveScalars(conn, { body }) as Record<string, string>;
    expect(html.body).toContain('Hello world');
    expect(html.body).toContain('<p');
  });

  test('reference objects are left intact (handled by dereference)', () => {
    const ref = { _type: 'reference', _ref: 'author-1' };
    expect(resolveScalars(conn, { author: ref })).toEqual({ author: ref });
  });

  test('plain scalars pass through untouched', () => {
    expect(resolveScalars(conn, { title: 'X', count: 3, on: true })).toEqual({ title: 'X', count: 3, on: true });
  });
});

describe('dereference', () => {
  test('inlines a referenced document one level + resolves its assets', async () => {
    const items = [{ _id: 'post-1', title: 'A', author: { _type: 'reference', _ref: 'author-1' } }];
    let askedQuery = '';
    const fetchResult = async (q: string) => {
      askedQuery = q;
      return [{ _id: 'author-1', name: 'Jane', avatar: { _type: 'image', asset: { _ref: 'image-av-100x100-png' } } }];
    };
    const [out] = (await dereference(conn, items, fetchResult)) as any[];
    expect(askedQuery).toContain('*[_id in ["author-1"]]');
    expect(out.author.name).toBe('Jane');
    expect(out.author.avatar).toBe('https://cdn.sanity.io/images/pid/production/av-100x100.png');
  });

  test('no references → no fetch, items unchanged', async () => {
    const items = [{ _id: '1', title: 'A' }];
    let called = false;
    const out = await dereference(conn, items, async () => {
      called = true;
      return [];
    });
    expect(called).toBe(false);
    expect(out).toEqual(items);
  });

  test('unresolved ref (RLS-hidden / missing) is left intact', async () => {
    const items = [{ _id: '1', author: { _type: 'reference', _ref: 'gone' } }];
    const [out] = (await dereference(conn, items, async () => [])) as any[];
    expect(out.author).toEqual({ _type: 'reference', _ref: 'gone' });
  });
});
