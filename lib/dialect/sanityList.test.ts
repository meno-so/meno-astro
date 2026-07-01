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
const page = (root: unknown): any => ({ meta: { title: 'Sanity' }, root });

describe('sanity list (sourceType: "sanity") — emit/parse round-trip', () => {
  test('basic sanity list with documentType + field bindings', () => {
    assertRoundTrip(
      page({
        type: 'node',
        tag: 'ul',
        children: [
          {
            type: 'list',
            sourceType: 'sanity',
            documentType: 'post',
            children: [{ type: 'node', tag: 'li', children: '{{item.title}}' }],
          },
        ],
      }),
    );
  });

  test('sanity list with query (filter/sort/limit/offset)', () => {
    assertRoundTrip(
      page({
        type: 'list',
        sourceType: 'sanity',
        documentType: 'product',
        filter: { field: 'active', operator: 'eq', value: true },
        sort: { field: 'order', order: 'asc' },
        limit: 8,
        offset: 2,
        children: [{ type: 'node', tag: 'span', children: '{{item.name}}' }],
      }),
    );
  });

  test('custom itemAs round-trips; default "item" is dropped', () => {
    assertRoundTrip(
      page({
        type: 'list',
        sourceType: 'sanity',
        documentType: 'author',
        itemAs: 'author',
        children: [{ type: 'node', tag: 'p', children: '{{author.name}}' }],
      }),
    );
    const normalized = normalizeModel(
      page({ type: 'list', sourceType: 'sanity', documentType: 'post', itemAs: 'item', children: ['{{item.x}}'] }),
    ) as { root: Record<string, unknown> };
    expect(normalized.root.itemAs).toBeUndefined();
  });

  test('emit produces a getSanityData frontmatter const (no projectId/dataset baked in, no content API)', () => {
    const out = emit(
      page({
        type: 'list',
        sourceType: 'sanity',
        documentType: 'post',
        limit: 5,
        children: [{ type: 'node', tag: 'li', children: '{{item.title}}' }],
      }),
    );
    expect(out).toContain('await getSanityData("post"');
    expect(out).toContain('.map((item, itemIndex) => (');
    expect(out).not.toContain('getCollection'); // not a content-collection list
    expect(out).not.toContain('apicdn.sanity.io'); // projectId/dataset resolved at runtime, not emitted
  });

  test('the parsed model validates against the authoritative PageDataSchema', () => {
    const model = parse(
      emit(
        page({
          type: 'list',
          sourceType: 'sanity',
          documentType: 'post',
          limit: 8,
          children: [{ type: 'node', tag: 'li', children: '{{item.title}}' }],
        }),
      ),
    ).model;
    expect(PageDataSchema.safeParse(model).success).toBe(true);
  });
});
