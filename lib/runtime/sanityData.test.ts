import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSanityData, buildSanityQueryUrl } from './sanityData';

const realFetch = globalThis.fetch;
const realCwd = process.cwd();
const tmps: string[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  process.chdir(realCwd);
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

/** chdir into a fresh temp project whose project.config.json carries the given sanity config. */
function chdirProject(sanity: unknown): void {
  const dir = mkdtempSync(join(tmpdir(), 'sanity-data-'));
  tmps.push(dir);
  writeFileSync(join(dir, 'project.config.json'), JSON.stringify({ integrations: { sanity } }), 'utf8');
  process.chdir(dir);
}

/** Stub global fetch; records the requested URL and returns the given JSON body. */
function stubFetch(body: unknown, opts: { ok?: boolean; throws?: boolean } = {}): { url: string } {
  const captured = { url: '' };
  globalThis.fetch = (async (url: string) => {
    captured.url = String(url);
    if (opts.throws) throw new Error('network down');
    return { ok: opts.ok ?? true, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return captured;
}

describe('buildSanityQueryUrl', () => {
  test('apicdn host by default, v-prefixed version, encoded query', () => {
    const url = buildSanityQueryUrl(
      { projectId: 'p1', dataset: 'production', apiVersion: '2024-01-01', useCdn: true },
      '*[_type == "post"]',
    );
    expect(url).toBe(
      'https://p1.apicdn.sanity.io/v2024-01-01/data/query/production?query=*%5B_type%20%3D%3D%20%22post%22%5D',
    );
  });

  test('useCdn:false uses the fresh api host; strips a leading v on apiVersion', () => {
    const url = buildSanityQueryUrl({ projectId: 'p1', dataset: 'd', apiVersion: 'v2021-10-21', useCdn: false }, '*');
    expect(url).toBe('https://p1.api.sanity.io/v2021-10-21/data/query/d?query=*');
  });
});

describe('getSanityData', () => {
  test('reads payload.result, keeps _id, builds the configured GROQ URL', async () => {
    chdirProject({ projectId: 'pid', dataset: 'production' });
    const cap = stubFetch({
      ms: 1,
      query: '…',
      result: [
        { _id: 'post-1', title: 'A' },
        { _id: 'post-2', title: 'B' },
      ],
    });
    const items = await getSanityData('post');
    expect(items.map((i) => i.title)).toEqual(['A', 'B']);
    expect(items[0]!._id).toBe('post-1');
    expect(cap.url).toContain('https://pid.apicdn.sanity.io/v2024-01-01/data/query/production?query=');
    expect(decodeURIComponent(cap.url)).toContain('*[_type == "post"]');
  });

  test('flattens slug-typed fields to their `current` string', async () => {
    chdirProject({ projectId: 'pid', dataset: 'd' });
    stubFetch({ result: [{ _id: '1', slug: { _type: 'slug', current: 'hello-world' } }] });
    const items = await getSanityData('post');
    expect(items[0]!.slug).toBe('hello-world');
  });

  test('resolves images and dereferences a reference end-to-end', async () => {
    chdirProject({ projectId: 'pid', dataset: 'production' });
    // Query-aware stub: the post query returns a row with an image + author ref; the second
    // `*[_id in [...]]` query returns the author doc (itself carrying an image).
    globalThis.fetch = (async (url: string) => {
      const groq = decodeURIComponent(String(url).split('query=')[1] || '');
      const body = groq.includes('_id in')
        ? {
            result: [
              { _id: 'author-1', name: 'Jane', avatar: { _type: 'image', asset: { _ref: 'image-av-50x50-png' } } },
            ],
          }
        : {
            result: [
              {
                _id: 'post-1',
                title: 'Hello',
                cover: { _type: 'image', asset: { _ref: 'image-cv-1200x630-jpg' } },
                author: { _type: 'reference', _ref: 'author-1' },
              },
            ],
          };
      return { ok: true, json: async () => body } as unknown as Response;
    }) as unknown as typeof fetch;

    const items = (await getSanityData('post')) as Array<Record<string, any>>;
    expect(items[0]!.cover).toBe('https://cdn.sanity.io/images/pid/production/cv-1200x630.jpg');
    expect(items[0]!.author.name).toBe('Jane');
    expect(items[0]!.author.avatar).toBe('https://cdn.sanity.io/images/pid/production/av-50x50.png');
  });

  test('serializes a Portable Text body field to HTML', async () => {
    chdirProject({ projectId: 'pid', dataset: 'd' });
    stubFetch({
      result: [
        {
          _id: '1',
          body: [
            {
              _type: 'block',
              _key: 'a',
              style: 'normal',
              markDefs: [],
              children: [{ _type: 'span', _key: 's', text: 'Rich body', marks: [] }],
            },
          ],
        },
      ],
    });
    const items = (await getSanityData('post')) as Array<Record<string, any>>;
    expect(items[0]!.body).toContain('<p');
    expect(items[0]!.body).toContain('Rich body');
  });

  test('applies filter/sort/limit via shared queryItems', async () => {
    chdirProject({ projectId: 'pid', dataset: 'd' });
    stubFetch({
      result: [
        { _id: '1', name: 'a', rank: 3, active: true },
        { _id: '2', name: 'b', rank: 1, active: false },
        { _id: '3', name: 'c', rank: 2, active: true },
      ],
    });
    const items = await getSanityData('post', {
      filter: { field: 'active', operator: 'eq', value: true },
      sort: { field: 'rank', order: 'asc' },
      limit: 1,
    });
    expect(items.map((i) => i.name)).toEqual(['c']);
  });

  test('synthesizes _id from index when absent', async () => {
    chdirProject({ projectId: 'pid', dataset: 'd' });
    stubFetch({ result: [{ title: 'no id' }] });
    const items = await getSanityData('post');
    expect(items[0]!._id).toBe('0');
  });

  test('no sanity config -> [] (never fetches)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sanity-data-empty-'));
    tmps.push(dir);
    writeFileSync(join(dir, 'project.config.json'), JSON.stringify({}), 'utf8');
    process.chdir(dir);
    stubFetch({ result: [{ _id: '1' }] });
    expect(await getSanityData('post')).toEqual([]);
  });

  test('graceful empty on empty documentType / non-ok / throw / non-array result', async () => {
    chdirProject({ projectId: 'pid', dataset: 'd' });
    expect(await getSanityData('')).toEqual([]);
    stubFetch({ result: [{ _id: '1' }] }, { ok: false });
    expect(await getSanityData('post')).toEqual([]);
    stubFetch(null, { throws: true });
    expect(await getSanityData('post')).toEqual([]);
    stubFetch({ result: 'not an array' });
    expect(await getSanityData('post')).toEqual([]);
  });
});
