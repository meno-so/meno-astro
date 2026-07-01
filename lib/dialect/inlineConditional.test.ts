import { test, expect, describe } from 'bun:test';
import { parse, emit, normalizeModel } from './index';

/** Parse a component body and return its root div's first child. */
function firstChild(body: string): any {
  const src = [
    '---',
    "import { resolveProps, style } from 'meno-astro';",
    'const { class: className } = resolveProps(Astro, {});',
    "const error = '', a = 1, b = 2, showIcon = true, user = {};",
    '---',
    `<div>${body}</div>`,
    '',
  ].join('\n');
  const kids = (parse(src).model as any).component.structure.children;
  return Array.isArray(kids) ? kids[0] : kids;
}

function assertRoundTrip(body: string): void {
  const src = [
    '---',
    "import { resolveProps, style } from 'meno-astro';",
    'const { class: className } = resolveProps(Astro, {});',
    "const error = '', a = 1, b = 2, showIcon = true, user = {};",
    '---',
    `<div>${body}</div>`,
    '',
  ].join('\n');
  const once = emit(parse(src).model as any);
  expect(emit(parse(once).model as any)).toBe(once); // emit idempotent
  expect(normalizeModel(parse(once).model)).toEqual(normalizeModel(parse(emit(parse(once).model as any)).model)); // parse stable
}

describe('inline conditional `{cond && <element>}` → dialect if-node (5a)', () => {
  test('a bare-identifier condition becomes an editable if-node', () => {
    const c = firstChild('{error && <p>{error}</p>}');
    expect(c.type).toBe('node');
    expect(c.tag).toBe('p');
    expect(c.if).toBe('{{error}}');
  });

  test('a self-closing element works', () => {
    const c = firstChild('{showIcon && <input type="text" />}');
    expect(c.tag).toBe('input');
    expect(c.if).toBe('{{showIcon}}');
  });

  test('a multi-`&&` condition keeps the whole condition', () => {
    const c = firstChild('{a && b && <p>hi</p>}');
    expect(c.tag).toBe('p');
    expect(c.if).toBe('{{a && b}}');
  });

  test('an optional-chaining condition is supported (rides 5b)', () => {
    const c = firstChild('{user?.email && <p>hi</p>}');
    expect(c.tag).toBe('p');
    expect(c.if).toBe('{{user?.email}}');
  });

  test('a styled element keeps its style()', () => {
    const c = firstChild('{error && <p class={style({ base: { color: "red" } })}>{error}</p>}');
    expect(c.style).toEqual({ base: { color: 'red' } });
    expect(c.if).toBe('{{error}}');
  });

  test('plain `{a && b}` (no element) stays a template binding, NOT an if-node', () => {
    const c = firstChild('<span>{a && b}</span>');
    expect(c.tag).toBe('span');
    expect(c.if).toBeUndefined();
    expect(c.children).toBe('{{a && b}}');
  });

  test('`{a && <x> && <y>}` (two elements) stays verbatim — never a lossy split', () => {
    const c = firstChild('{a && <b>x</b> && <i>y</i>}');
    expect(c._code).toBe(true); // preserved, not mis-converted
  });

  test('round-trips (emit canonicalizes to the parenthesized form, parse re-reads it)', () => {
    assertRoundTrip('{error && <p>{error}</p>}');
    assertRoundTrip('{user?.email && <p>{user.email}</p>}');
  });
});
