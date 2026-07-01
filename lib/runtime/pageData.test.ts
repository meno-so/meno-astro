import { afterEach, describe, expect, it, mock } from 'bun:test';
import { loadPageData } from './pageData';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Install a fetch mock that records calls and returns `body` (or a status for failure). */
function mockFetch(impl: (url: string, init?: RequestInit) => { ok?: boolean; status?: number; json: unknown }) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const r = impl(u, init);
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      statusText: '',
      json: async () => r.json,
    } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe('loadPageData', () => {
  it('resolves an object source with _ok and the payload fields', async () => {
    mockFetch(() => ({ json: { full_name: 'withastro/astro', stargazers_count: 42 } }));
    const out = await loadPageData({
      sources: { repo: { type: 'fetch', url: 'https://api.example.com/repo' } },
    });
    expect(out.repo).toMatchObject({ full_name: 'withastro/astro', stargazers_count: 42, _ok: true, _error: null });
  });

  it('navigates `path` into the response', async () => {
    mockFetch(() => ({ json: { data: { item: { name: 'X' } } } }));
    const out = await loadPageData({
      sources: { thing: { type: 'fetch', url: 'https://api.example.com/x', path: 'data.item' } },
    });
    expect(out.thing).toMatchObject({ name: 'X', _ok: true });
  });

  it('sets _ok:false + _error on a non-2xx response, never throwing', async () => {
    mockFetch(() => ({ ok: false, status: 503, json: null }));
    const out = await loadPageData({
      sources: { repo: { type: 'fetch', url: 'https://api.example.com/repo' } },
    });
    expect(out.repo).toMatchObject({ _ok: false });
    expect((out.repo as { _error: string })._error).toContain('503');
  });

  it('sets _ok:false on a network error, never throwing', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const out = await loadPageData({
      sources: { repo: { type: 'fetch', url: 'https://api.example.com/repo' } },
    });
    expect(out.repo).toMatchObject({ _ok: false, _error: 'ECONNREFUSED' });
  });

  it('rejects a non-object payload (e.g. a bare array) for object cardinality', async () => {
    mockFetch(() => ({ json: [1, 2, 3] }));
    const out = await loadPageData({
      sources: { repo: { type: 'fetch', url: 'https://api.example.com/repo' } },
    });
    expect(out.repo).toMatchObject({ _ok: false });
  });

  it('returns an item array for cardinality:list', async () => {
    mockFetch(() => ({
      json: [
        { id: 1, name: 'a' },
        { id: 2, name: 'b' },
      ],
    }));
    const out = await loadPageData({
      sources: { items: { type: 'fetch', url: 'https://api.example.com/items', cardinality: 'list' } },
    });
    expect(Array.isArray(out.items)).toBe(true);
    expect((out.items as unknown[]).length).toBe(2);
  });

  it('interpolates {{query.q}} into the URL, URL-encoded', async () => {
    const calls = mockFetch(() => ({ json: { ok: 1 } }));
    await loadPageData(
      { sources: { search: { type: 'fetch', url: 'https://api.example.com/s?q={{query.q}}' } } },
      { url: new URL('https://site.test/live?q=hello world&danger=%26') },
    );
    expect(calls[0]!.url).toBe('https://api.example.com/s?q=hello%20world');
  });

  it('interpolates {{params.owner}} into the URL path, URL-encoded', async () => {
    const calls = mockFetch(() => ({ json: { ok: 1 } }));
    await loadPageData(
      { sources: { repo: { type: 'fetch', url: 'https://api.example.com/repos/{{params.owner}}' } } },
      { params: { owner: 'with astro' } },
    );
    expect(calls[0]!.url).toBe('https://api.example.com/repos/with%20astro');
  });

  it('strips CR/LF from header interpolation (injection guard)', async () => {
    const calls = mockFetch(() => ({ json: { ok: 1 } }));
    await loadPageData(
      {
        sources: {
          repo: {
            type: 'fetch',
            url: 'https://api.example.com/repo',
            headers: { 'x-token': 'a{{query.t}}b' },
          },
        },
      },
      { url: new URL('https://site.test/?t=x%0d%0aevil:1') },
    );
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['x-token']).toBe('ax\r\nevil:1b'.replace(/[\r\n]/g, ''));
    expect(headers['x-token']).not.toContain('\n');
  });

  it('resolves multiple sources concurrently into one map', async () => {
    mockFetch((url) => ({ json: { from: url } }));
    const out = await loadPageData({
      sources: {
        a: { type: 'fetch', url: 'https://api.example.com/a' },
        b: { type: 'fetch', url: 'https://api.example.com/b' },
      },
    });
    expect((out.a as { from: string }).from).toBe('https://api.example.com/a');
    expect((out.b as { from: string }).from).toBe('https://api.example.com/b');
  });

  it('returns {} for a missing/empty config (degrades, no throw)', async () => {
    expect(await loadPageData(undefined)).toEqual({});
    expect(await loadPageData({})).toEqual({});
    expect(await loadPageData({ sources: {} })).toEqual({});
  });

  it('resolves {{env.TOKEN}} into a header from process.env (no URL-encode, no literal)', async () => {
    const prev = process.env.MENO_TEST_TOKEN;
    process.env.MENO_TEST_TOKEN = 'sk-abc/123+xyz';
    try {
      const calls = mockFetch(() => ({ json: { ok: 1 } }));
      await loadPageData({
        sources: {
          repo: {
            type: 'fetch',
            url: 'https://api.example.com/repo',
            headers: { authorization: 'Bearer {{env.MENO_TEST_TOKEN}}' },
          },
        },
      });
      const headers = calls[0]!.init?.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer sk-abc/123+xyz'); // raw token, not URL-encoded
    } finally {
      if (prev === undefined) delete process.env.MENO_TEST_TOKEN;
      else process.env.MENO_TEST_TOKEN = prev;
    }
  });

  it('a missing {{env.X}} resolves to empty (never ships the literal template)', async () => {
    delete process.env.MENO_DEFINITELY_UNSET;
    const calls = mockFetch(() => ({ json: { ok: 1 } }));
    await loadPageData({
      sources: {
        repo: {
          type: 'fetch',
          url: 'https://api.example.com/repo',
          headers: { authorization: 'Bearer {{env.MENO_DEFINITELY_UNSET}}' },
        },
      },
    });
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer ');
    expect(headers.authorization).not.toContain('{{');
  });

  it('origin-lock does not false-positive on normal path/query interpolation', async () => {
    mockFetch(() => ({ json: { ok: 1 } }));
    const out = await loadPageData(
      { sources: { repo: { type: 'fetch', url: 'https://api.example.com/r/{{params.id}}?x={{query.x}}' } } },
      { params: { id: '7' }, url: new URL('https://site.test/?x=1') },
    );
    expect((out.repo as { _ok: boolean })._ok).toBe(true); // not blocked
  });
});
