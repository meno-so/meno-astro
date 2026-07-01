/**
 * Verbatim-code escape hatch: arbitrary JS the Meno model can't represent as a binding
 * is preserved as a `{ _code, expr }` marker, round-trips exactly, renders natively in the
 * Astro build, and is reported via `parse().regions`. The predicate boundary is meno-core's
 * own template-engine grammar (`isSupportedTemplateExpression`) — so anything it can
 * evaluate stays a `{{binding}}` and only un-evaluatable JS (function/method calls, etc.)
 * becomes verbatim.
 */

import { test, expect, describe } from 'bun:test';
import { emit, parse, normalizeModel } from './index';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const comp = (structure: unknown): any => ({ component: { structure } });

/** Round-trip gate, identical to roundtrip.test.ts. */
function assertRoundTrip(x: unknown) {
  const n = normalizeModel(x);
  expect(normalizeModel(n)).toEqual(n as any); // idempotent
  expect(parse(emit(n as any)).model).toEqual(n as any);
}

const code = (expr: string) => ({ _code: true, expr });

describe('verbatim code: round-trips in every value position', () => {
  test('text/child position — the motivating example', () => {
    assertRoundTrip(
      comp({
        type: 'node',
        tag: 'span',
        children: [code('(product.price * 0.8).toFixed(2)')],
      }),
    );
  });

  test('attribute / prop position', () => {
    assertRoundTrip(
      comp({
        type: 'node',
        tag: 'input',
        attributes: { 'data-total': code('sum(a, b)') },
      }),
    );
    assertRoundTrip(
      comp({
        type: 'component',
        component: 'Card',
        props: { score: code('Math.round(value * 100)') },
      }),
    );
  });

  test('if-condition position', () => {
    assertRoundTrip(comp({ type: 'node', tag: 'div', if: code('getFlag()'), children: 'X' }));
  });

  test('multi-line expression is hoisted to a const and round-trips', () => {
    assertRoundTrip(
      comp({
        type: 'node',
        tag: 'span',
        children: [code('items\n  .filter((x) => x.active)\n  .map((x) => x.name)\n  .join(", ")')],
      }),
    );
  });

  test('a multi-line backtick template literal inside a _code expr keeps its significant indentation', () => {
    // dedentCode strips CODE indentation but must NOT touch whitespace inside a template literal —
    // that whitespace is string content. Here the `    return 1` line + closing backtick are indented.
    const expr = 'hl`def f():\n    return 1\n    `';
    const model = comp({ type: 'node', tag: 'pre', children: [code(expr)] });
    assertRoundTrip(model);
    // and the verbatim string survives the full round-trip byte-for-byte
    const back = (parse(emit(model)).model as any).component.structure.children[0];
    expect(back.expr).toBe(expr);
  });

  test('verbatim alongside real children and bindings', () => {
    assertRoundTrip(
      comp({
        type: 'node',
        tag: 'p',
        children: [
          'Price: ',
          code('formatMoney(item.price)'),
          { type: 'node', tag: 'span', children: '{{item.title}}' },
        ],
      }),
    );
  });
});

describe('verbatim code: the predicate boundary (no over-capture)', () => {
  // Everything meno-core's expression evaluator supports MUST stay a `{{binding}}`,
  // never a verbatim marker — otherwise existing projects would silently change shape.
  const BINDINGS = [
    'item.price',
    'autoPlay && !isEditorMode',
    "href || '#'",
    'a ? b : c',
    'count + 1',
    'item.tags[0]',
    'price * quantity',
  ];

  for (const expr of BINDINGS) {
    test(`keeps "${expr}" as a binding`, () => {
      const back = parse(emit(comp({ type: 'node', tag: 'p', children: [`{{${expr}}}`] }))).model as any;
      const children = back.component.structure.children;
      const val = Array.isArray(children) ? children[0] : children;
      expect(val).toBe(`{{${expr}}}`); // a string binding, NOT a _code marker
    });
  }

  // Anything with a function/method call (or otherwise un-evaluatable) MUST be verbatim.
  const VERBATIM = ['(product.price * 0.8).toFixed(2)', 'items.map((x) => x.id)', 'Math.max(a, b)', 'fn()'];

  for (const expr of VERBATIM) {
    test(`preserves "${expr}" as verbatim`, () => {
      const back = parse(emit(comp({ type: 'node', tag: 'p', children: [code(expr)] }))).model as any;
      const children = back.component.structure.children;
      const val = Array.isArray(children) ? children[0] : children;
      expect(val).toEqual({ _code: true, expr });
    });
  }
});

describe('verbatim code: regions reporting', () => {
  test('parse() reports a verbatim region whose span covers the source JS', () => {
    const src = emit(
      comp({
        type: 'node',
        tag: 'span',
        children: [code('(a * b).toFixed(2)')],
      }),
    );
    const { regions } = parse(src);
    expect(regions.length).toBe(1);
    expect(regions[0]!.kind).toBe('verbatim');
    expect(src.slice(regions[0]!.start, regions[0]!.end)).toContain('(a * b).toFixed(2)');
  });

  test('no verbatim code → no regions (unchanged for ordinary models)', () => {
    const src = emit(comp({ type: 'node', tag: 'p', children: '{{item.title}}' }));
    expect(parse(src).regions).toEqual([]);
  });

  test('multiple verbatim spans are all reported, in source order', () => {
    const src = emit(
      comp({
        type: 'node',
        tag: 'div',
        children: [
          { type: 'node', tag: 'span', children: [code('first()')] },
          { type: 'node', tag: 'span', children: [code('second()')] },
        ],
      }),
    );
    const { regions } = parse(src);
    expect(regions.length).toBe(2);
    expect(regions.every((r) => r.kind === 'verbatim')).toBe(true);
    expect(regions[0]!.start).toBeLessThan(regions[1]!.start);
  });
});

describe('verbatim code: renders natively at build', () => {
  test('emitted .astro contains the literal JS (Astro evaluates it, not Meno)', () => {
    const src = emit(
      comp({
        type: 'node',
        tag: 'span',
        children: [code('(product.price * 0.8).toFixed(2)')],
      }),
    );
    expect(src).toContain('{(product.price * 0.8).toFixed(2)}');
  });
});
