import { test, expect, describe } from 'bun:test';
import { emit, parse, normalizeModel } from './index';

/** Round-trip gate: parse(emit(x)) === normalizeModel(x). */
function assertRoundTrip(x: unknown) {
  const n = normalizeModel(x);
  expect(normalizeModel(n)).toEqual(n as any);
  const back = parse(emit(n as any)).model;
  expect(back).toEqual(n as any);
}

const comp = (structure: unknown) => ({ component: { structure } });

/** Parse a component body wrapping `inner` as the structure's children, return the first child. */
function parseChild(inner: string): any {
  const src = `---
import { resolveProps, style } from 'meno-astro';
const __props = resolveProps(Astro, {});
---
<div>
${inner}
</div>`;
  return (parse(src).model as any).component.structure.children[0];
}

describe('expression-list: bare `<expr>.map(…)` over un-modelable frontmatter data', () => {
  test('a simple paren-wrapped .map promotes to an editable list (sourceType:expression)', () => {
    const node = parseChild('{notes?.map((note) => (<div>{note.title}</div>))}');
    expect(node.type).toBe('list');
    expect(node.sourceType).toBe('expression');
    expect(node.source).toBe('notes?');
    expect(node.itemAs).toBe('note');
    // The item template is real, editable nodes — not an opaque blob.
    expect(Array.isArray(node.children)).toBe(true);
    expect(node.children[0].type).toBe('node');
    expect(node.children[0].tag).toBe('div');
  });

  test('round-trips: a hand-authored expression-list is model-stable', () => {
    assertRoundTrip(
      comp({
        type: 'list',
        sourceType: 'expression',
        source: 'notes?',
        itemAs: 'note',
        children: [
          {
            type: 'node',
            tag: 'div',
            attributes: { style: 'display:flex;gap:12px' },
            children: ['{{note.title}}'],
          },
        ],
      }),
    );
  });

  test('a member-chain source (data.items) promotes', () => {
    const node = parseChild('{data.items.map((row) => (<span>{row.name}</span>))}');
    expect(node.sourceType).toBe('expression');
    expect(node.source).toBe('data.items');
    expect(node.itemAs).toBe('row');
  });

  test('emits a bare `<source>.map(...)` with NO list()/getCollectionList wrapper', () => {
    const out = emit(
      comp({
        type: 'list',
        sourceType: 'expression',
        source: 'notes?',
        itemAs: 'note',
        children: [{ type: 'node', tag: 'li', children: ['{{note.title}}'] }],
      }) as any,
    );
    expect(out).toContain('notes?.map((note, noteIndex) => (');
    expect(out).not.toContain('list(');
    expect(out).not.toContain('getCollectionList');
  });

  describe('gate: never silently lose or corrupt — stay verbatim {_code} when unsafe', () => {
    test('a call-expression source (items.filter(...).map) stays {_code}', () => {
      const node = parseChild('{items.filter((x) => x.active).map((x) => (<li>{x.name}</li>))}');
      expect(node._code).toBe(true);
      expect(node.type).toBeUndefined();
    });

    test('an UNPARENTHESIZED arrow body (x => <li/>) stays {_code} (no silent body drop)', () => {
      const node = parseChild('{items.map((x) => <li>{x.name}</li>)}');
      expect(node._code).toBe(true);
    });

    test('a block-body arrow (x => { return ... }) stays {_code}', () => {
      const node = parseChild('{items.map((x) => { return x.name })}');
      expect(node._code).toBe(true);
    });
  });

  test('a genuine prop list (list(items).map) is unaffected — still sourceType:prop', () => {
    assertRoundTrip(
      comp({
        type: 'list',
        sourceType: 'prop',
        source: '{{items}}',
        children: [{ type: 'node', tag: 'li', children: ['{{item.label}}'] }],
      }),
    );
  });
});
