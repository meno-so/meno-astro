/**
 * Tier 2 client-side CMS filtering data: a filter-wired collection list
 * (`emitTemplate: true`) ships its items as an inline
 * `<script type="application/json" id="meno-cms-<collection>">` so the MenoFilter runtime
 * filters/sorts/counts the real data. Emit-only — the parser drops the script and the list's
 * `emitTemplate` flag re-derives it, so the model round-trips.
 */
import { test, expect, describe } from 'bun:test';
import { emitNode, buildClientDataScripts } from './emitNode';
import { createEmitContext } from './emitContext';
import { emit, parse } from '../index';
import { serializeClientCmsData } from '../../runtime/collectionList';

function collectionList(extra: Record<string, unknown> = {}) {
  return {
    type: 'list',
    sourceType: 'collection',
    source: 'products',
    itemAs: 'item',
    children: [
      {
        type: 'node',
        tag: 'div',
        attributes: { 'data-id': '{{item._id}}', 'data-category': '{{item.category}}' },
        children: ['{{item.title}}'],
      },
    ],
    ...extra,
  };
}

describe('client CMS data registration (renderList)', () => {
  test('emitTemplate:true registers the collection + binding and the runtime helper', () => {
    const ctx = createEmitContext();
    emitNode(collectionList({ emitTemplate: true }) as any, ctx, 0);
    expect(ctx.clientDataCollections).toEqual([{ collection: 'products', binding: 'productsList' }]);
    expect(ctx.runtime.has('serializeClientCmsData')).toBe(true);
  });

  test('a plain collection list (no emitTemplate) registers NOTHING', () => {
    const ctx = createEmitContext();
    emitNode(collectionList() as any, ctx, 0);
    expect(ctx.clientDataCollections).toEqual([]);
    expect(ctx.runtime.has('serializeClientCmsData')).toBe(false);
  });
});

describe('buildClientDataScripts', () => {
  test('emits one inline JSON data script per registered collection (binding-bound)', () => {
    const ctx = createEmitContext();
    ctx.clientDataCollections.push({ collection: 'products', binding: 'productsList' });
    expect(buildClientDataScripts(ctx, 2)).toBe(
      '  <script type="application/json" id="meno-cms-products" is:inline set:html={serializeClientCmsData(productsList)}></script>',
    );
  });

  test('dedupes by collection — one script even if two lists target it', () => {
    const ctx = createEmitContext();
    ctx.clientDataCollections.push({ collection: 'products', binding: 'productsList' });
    ctx.clientDataCollections.push({ collection: 'products', binding: 'productsList_1' });
    const out = buildClientDataScripts(ctx, 0);
    expect(out.match(/id="meno-cms-products"/g)?.length).toBe(1);
  });

  test('empty when no filter-wired list was emitted', () => {
    expect(buildClientDataScripts(createEmitContext(), 0)).toBe('');
  });
});

describe('serializeClientCmsData', () => {
  test('JSON-stringifies items and escapes `<` so a "</script>" value cannot break out', () => {
    const out = serializeClientCmsData([{ title: 'a </script> b', _id: '1' }]);
    expect(out).not.toContain('</script>');
    expect(out).toContain('\\u003c/script>');
    // Still valid JSON that parses back to the original `<`.
    expect(JSON.parse(out)[0].title).toBe('a </script> b');
  });

  test('tolerates null / non-array (renders [])', () => {
    expect(serializeClientCmsData(null)).toBe('[]');
    expect(serializeClientCmsData(undefined)).toBe('[]');
  });
});

describe('page emit + round-trip', () => {
  const page = {
    meta: { title: 'Shop' },
    root: {
      type: 'node',
      tag: 'div',
      attributes: { 'data-meno-filter': 'products' },
      children: [
        {
          type: 'node',
          tag: 'div',
          attributes: { 'data-meno-list': '' },
          children: [collectionList({ emitTemplate: true })],
        },
      ],
    },
  };

  test('the data script is emitted after the body, inside <BaseLayout>', () => {
    const out = emit(page as any);
    expect(out).toContain('import { getCollectionList');
    expect(out).toContain('serializeClientCmsData');
    expect(out).toContain(
      '<script type="application/json" id="meno-cms-products" is:inline set:html={serializeClientCmsData(productsList)}></script>',
    );
    // It sits before </BaseLayout> (a sibling of the page root), not inside [data-meno-list].
    expect(out.indexOf('meno-cms-products')).toBeLessThan(out.indexOf('</BaseLayout>'));
  });

  test('a <template data-meno-item> is emitted (synthetic item = referenced fields + _id)', () => {
    const out = emit(page as any);
    expect(out).toContain('<template data-meno-item>');
    expect(out).toContain('"_id": "{{item._id}}"');
    expect(out).toContain('"category": "{{item.category}}"');
    expect(out).toContain('"title": "{{item.title}}"');
    // The template sits inside the list container, before the page-level data script.
    expect(out.indexOf('<template data-meno-item>')).toBeLessThan(out.indexOf('id="meno-cms-products"'));
  });

  test('round-trips: parse drops the data script + item template, keeps emitTemplate; idempotent', () => {
    const out = emit(page as any);
    const { model } = parse(out) as any;
    // No phantom <script> / <template> node anywhere in the model.
    let scripts = 0;
    let templates = 0;
    let list: any = null;
    const walk = (n: any) => {
      if (!n || typeof n !== 'object') return;
      if (n.tag === 'script') scripts++;
      if (n.tag === 'template') templates++;
      if (n.type === 'list' && n.sourceType === 'collection') list = n;
      (Array.isArray(n.children) ? n.children : []).forEach(walk);
    };
    walk(model.root);
    expect(scripts).toBe(0);
    expect(templates).toBe(0);
    expect(list?.emitTemplate).toBe(true);
    // Idempotent on re-emit.
    expect(emit(model as any)).toBe(out);
  });
});
