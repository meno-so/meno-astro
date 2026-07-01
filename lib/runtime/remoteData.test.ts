import { test, expect, describe, afterEach } from 'bun:test';
import { getRemoteData } from './remoteData';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Stub global fetch with a JSON body (or a thrown error / non-ok status). */
function stubFetch(body: unknown, opts: { ok?: boolean; throws?: boolean } = {}) {
  globalThis.fetch = (async () => {
    if (opts.throws) throw new Error('network down');
    return {
      ok: opts.ok ?? true,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('getRemoteData', () => {
  test('top-level array response (no path)', async () => {
    stubFetch([{ name: 'a' }, { name: 'b' }]);
    const items = await getRemoteData('https://x.dev/a');
    expect(items.map((i) => i.name)).toEqual(['a', 'b']);
    expect(items[0]!._id).toBe('0'); // synthesized
  });

  test('navigates a dot-path to the items array', async () => {
    stubFetch({ result: { items: [{ id: 7, name: 'z' }] } });
    const items = await getRemoteData('https://x.dev/a', { path: 'result.items' });
    expect(items).toHaveLength(1);
    expect(items[0]!.name).toBe('z');
    expect(items[0]!._id).toBe('7'); // from item.id
  });

  test('applies filter/sort/limit via shared queryItems', async () => {
    stubFetch([
      { name: 'a', rank: 3, active: true },
      { name: 'b', rank: 1, active: false },
      { name: 'c', rank: 2, active: true },
    ]);
    const items = await getRemoteData('https://x.dev/a', {
      filter: { field: 'active', operator: 'eq', value: true },
      sort: { field: 'rank', order: 'asc' },
      limit: 1,
    });
    expect(items.map((i) => i.name)).toEqual(['c']); // active, lowest rank
  });

  test('wraps primitive items as { _id, value }', async () => {
    stubFetch(['x', 'y']);
    const items = await getRemoteData('https://x.dev/a');
    expect(items).toEqual([
      { _id: '0', value: 'x' },
      { _id: '1', value: 'y' },
    ]);
  });

  test('graceful empty on network error / non-ok / non-array / missing url', async () => {
    stubFetch(null, { throws: true });
    expect(await getRemoteData('https://x.dev/a')).toEqual([]);
    stubFetch([{ a: 1 }], { ok: false });
    expect(await getRemoteData('https://x.dev/a')).toEqual([]);
    stubFetch({ not: 'an array' });
    expect(await getRemoteData('https://x.dev/a', { path: 'not' })).toEqual([]);
    expect(await getRemoteData('')).toEqual([]);
  });
});
