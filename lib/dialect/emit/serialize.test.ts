import { test, expect, describe } from 'bun:test';
import { serializeLiteral, isIdentifier } from './serialize';

/** Evaluate an emitted JS literal back to a value (proves the output is valid, parseable JS). */
function evalLiteral(src: string): unknown {
  // eslint-disable-next-line no-new-func
  return new Function(`return (${src});`)();
}

describe('serializeLiteral — primitives', () => {
  test('strings use JSON escaping', () => {
    expect(serializeLiteral('hi')).toBe('"hi"');
    expect(serializeLiteral('a "quote" and \\ slash')).toBe('"a \\"quote\\" and \\\\ slash"');
    expect(serializeLiteral('line\nbreak')).toBe('"line\\nbreak"');
  });
  test('numbers, booleans, null', () => {
    expect(serializeLiteral(42)).toBe('42');
    expect(serializeLiteral(0.8)).toBe('0.8');
    expect(serializeLiteral(true)).toBe('true');
    expect(serializeLiteral(false)).toBe('false');
    expect(serializeLiteral(null)).toBe('null');
  });
  test('non-finite numbers degrade to null (JSON semantics)', () => {
    expect(serializeLiteral(NaN)).toBe('null');
    expect(serializeLiteral(Infinity)).toBe('null');
  });
});

describe('serializeLiteral — keys', () => {
  test('identifier keys unquoted, others quoted', () => {
    expect(isIdentifier('marginTop')).toBe(true);
    expect(isIdentifier('_mapping')).toBe(true);
    expect(isIdentifier('aria-label')).toBe(false);
    expect(serializeLiteral({ marginTop: '4px' })).toBe('{ marginTop: "4px" }');
    expect(serializeLiteral({ 'aria-label': 'x' })).toBe('{ "aria-label": "x" }');
  });
});

describe('serializeLiteral — empty + inline', () => {
  test('empty object/array', () => {
    expect(serializeLiteral({})).toBe('{}');
    expect(serializeLiteral([])).toBe('[]');
  });
  test('small objects render inline', () => {
    expect(serializeLiteral({ href: '/pricing' })).toBe('{ href: "/pricing" }');
    expect(serializeLiteral({ base: {} })).toBe('{ base: {} }');
    expect(serializeLiteral([1, 2, 3])).toBe('[1, 2, 3]');
  });
});

describe('serializeLiteral — multi-line expansion', () => {
  test('expands every object whose own column would overflow (width 80)', () => {
    const style = {
      base: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px' },
      tablet: { padding: '12px' },
    };
    const out = serializeLiteral(style, { indent: 0, width: 80 });
    expect(out).toBe(
      [
        '{',
        '  base: {',
        '    display: "flex",',
        '    flexDirection: "column",',
        '    gap: "12px",',
        '    padding: "24px"',
        '  },',
        '  tablet: { padding: "12px" }',
        '}',
      ].join('\n'),
    );
  });

  test('keeps sub-objects inline when they fit at their column (width 100)', () => {
    const style = {
      base: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px' },
      tablet: { padding: '12px' },
    };
    const out = serializeLiteral(style, { indent: 0, width: 100 });
    expect(out).toBe(
      [
        '{',
        '  base: { display: "flex", flexDirection: "column", gap: "12px", padding: "24px" },',
        '  tablet: { padding: "12px" }',
        '}',
      ].join('\n'),
    );
  });

  test('a sub-object that overflows its column expands too', () => {
    const style = {
      base: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '24px' },
    };
    // width 40 forces the base object (which starts at column 8) to break.
    const out = serializeLiteral(style, { indent: 0, width: 40 });
    expect(out).toBe(
      [
        '{',
        '  base: {',
        '    display: "flex",',
        '    flexDirection: "column",',
        '    gap: "12px",',
        '    padding: "24px"',
        '  }',
        '}',
      ].join('\n'),
    );
  });

  test('continuation lines respect a non-zero base indent', () => {
    const out = serializeLiteral(
      { a: 'xxxxxxxxxx', b: 'yyyyyyyyyy', c: 'zzzzzzzzzz', d: 'wwwwwwwwww' },
      { indent: 4, width: 20 },
    );
    // Each property indented to baseIndent+2 = 6 spaces; closing brace at baseIndent = 4.
    expect(out.split('\n')[1]!.startsWith('      a: ')).toBe(true);
    expect(out.split('\n').at(-1)).toBe('    }');
  });
});

describe('serializeLiteral — determinism + parseability (property)', () => {
  const samples: unknown[] = [
    { _i18n: true, en: 'Hello', pl: 'Cześć', de: 'Hallo' },
    { base: { display: 'flex' }, mobile: { padding: '8px' } },
    { _mapping: true, prop: 'isMarginTop', values: { true: '40px', false: '0' } },
    { text: 'Get started', isMarginTop: true, link: { href: '/x', target: '_blank' } },
    [{ title: 'A' }, { title: 'B' }],
    { nested: { deep: { deeper: { x: [1, 2, { y: 'z' }] } } } },
    { 'data-id': '123', 'aria-label': 'Button', count: 3 },
  ];

  test('same input always yields identical output', () => {
    for (const s of samples) {
      expect(serializeLiteral(s)).toBe(serializeLiteral(s));
    }
  });

  test('output evaluates back to a structurally-equal value', () => {
    for (const s of samples) {
      for (const width of [80, 20, 1]) {
        const out = serializeLiteral(s, { width });
        expect(evalLiteral(out)).toEqual(s as any);
      }
    }
  });
});
