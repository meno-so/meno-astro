import { test, expect, describe } from 'bun:test';
import { emit, parse, normalizeModel } from './index';
import { PageDataSchema } from 'meno-core/shared/validation/schemas';

/** Round-trip gate: parse(emit(x)) === normalizeModel(x). */
function assertRoundTrip(x: unknown) {
  const n = normalizeModel(x);
  expect(normalizeModel(n)).toEqual(n as any); // idempotent
  expect(parse(emit(n as any)).model).toEqual(n as any);
}

// biome-ignore lint/suspicious/noExplicitAny: test fixture passed to emit()/normalizeModel() (DialectModel | unknown)
const page = (root: unknown): any => ({ meta: { title: 'Remote' }, root });

describe('remote-data list (sourceType: "remote") — emit/parse round-trip', () => {
  test('basic remote list with url + path + field bindings', () => {
    assertRoundTrip(
      page({
        type: 'node',
        tag: 'ul',
        children: [
          {
            type: 'list',
            sourceType: 'remote',
            url: 'https://api.example.com/markets',
            path: 'data',
            children: [{ type: 'node', tag: 'li', children: '{{item.name}}' }],
          },
        ],
      }),
    );
  });

  test('remote list with query (filter/sort/limit/offset)', () => {
    assertRoundTrip(
      page({
        type: 'list',
        sourceType: 'remote',
        url: 'https://api.example.com/coins',
        path: 'result.items',
        filter: { field: 'active', operator: 'eq', value: true },
        sort: { field: 'rank', order: 'asc' },
        limit: 8,
        offset: 2,
        children: [{ type: 'node', tag: 'span', children: '{{item.symbol}}' }],
      }),
    );
  });

  test('custom itemAs round-trips; default "item" is dropped', () => {
    assertRoundTrip(
      page({
        type: 'list',
        sourceType: 'remote',
        url: 'https://api.example.com/users',
        itemAs: 'user',
        children: [{ type: 'node', tag: 'p', children: '{{user.email}}' }],
      }),
    );
    // itemAs === default 'item' normalizes away (not carried in the model). normalizeModel only
    // descends into a page's `root`, so assert on the normalized root, not a bare node.
    const normalized = normalizeModel(
      page({ type: 'list', sourceType: 'remote', url: 'https://x.dev/a', itemAs: 'item', children: ['{{item.x}}'] }),
    ) as { root: Record<string, unknown> };
    expect(normalized.root.itemAs).toBeUndefined();
  });

  test('emit produces a getRemoteData frontmatter const + map body (no content API)', () => {
    const out = emit(
      page({
        type: 'list',
        sourceType: 'remote',
        url: 'https://api.example.com/markets',
        path: 'data',
        limit: 5,
        children: [{ type: 'node', tag: 'li', children: '{{item.name}}' }],
      }),
    );
    expect(out).toContain('await getRemoteData("https://api.example.com/markets"');
    expect(out).toContain('.map((item, itemIndex) => (');
    expect(out).not.toContain('getCollection'); // not a content-collection list
  });

  test('the parsed model validates against the authoritative PageDataSchema', () => {
    // Guard: the editor validates loaded pages with schemas.ts (NOT the dialect codec). A
    // remote list must pass ListNodeSchemaBasic — i.e. sourceType:'remote' + url/path are
    // allowed there too, or the editor throws a LoadError on open.
    const model = parse(
      emit(
        page({
          type: 'list',
          sourceType: 'remote',
          url: 'https://api.example.com/markets',
          path: 'data',
          limit: 8,
          children: [{ type: 'node', tag: 'li', children: '{{item.name}}' }],
        }),
      ),
    ).model;
    expect(PageDataSchema.safeParse(model).success).toBe(true);
  });
});
