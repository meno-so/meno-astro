import { test, expect, describe } from 'bun:test';
import { emit, parse, normalizeModel } from './index';

/** The core GATE: round-trip is exact on canonical models. */
function assertRoundTrip(x: unknown) {
  const n = normalizeModel(x);
  expect(normalizeModel(n)).toEqual(n as any);
  const back = parse(emit(n as any)).model;
  expect(back).toEqual(n as any);
}

const comp = (structure: unknown) => ({ component: { structure } });
const emitComp = (structure: unknown) => emit(normalizeModel(comp(structure)) as any);

describe('markdown node: type:"markdown" → <Markdown> → renderMarkdown', () => {
  test('single-line markdown round-trips', () => {
    assertRoundTrip(comp({ type: 'markdown', source: '# Hello' }));
  });

  test('multi-line, whitespace-significant markdown round-trips byte-exact', () => {
    const source = '# Title\n\nBody with `code` and **bold**, then:\n\n    indented code block\n\n- a\n- b\n';
    assertRoundTrip(comp({ type: 'markdown', source }));
  });

  test('markdown containing backticks, ${...}, and {{...}} survives verbatim', () => {
    // None of these are template-resolved — markdown source is opaque.
    const source = 'Use `npm` or `${VAR}` and a literal {{token}} plus a \\ backslash.\nLine two.';
    const model = comp({ type: 'markdown', source });
    const back = parse(emit(normalizeModel(model) as any)).model as any;
    expect(back.component.structure.source).toBe(source);
    assertRoundTrip(model);
  });

  test('emits <Markdown> from meno-astro/components with a hoisted __md const (multi-line)', () => {
    const src = emitComp({ type: 'markdown', source: '# A\n\nB' });
    expect(src).toContain('<Markdown');
    expect(src).toContain("from 'meno-astro/components'");
    expect(src).toContain('import { Markdown }');
    expect(src).toMatch(/const __md0 = `/);
    expect(src).toContain('source={__md0}');
  });

  test('single-line markdown emits inline (no hoist)', () => {
    const src = emitComp({ type: 'markdown', source: '# Inline' });
    expect(src).toContain('source={`# Inline`}');
    expect(src).not.toMatch(/const __md\d+ =/);
  });

  test('markdown node with style() class round-trips', () => {
    assertRoundTrip(comp({ type: 'markdown', source: '# Styled\n\ntext', style: { base: { padding: '16px' } } }));
  });

  test('a user component named Markdown does not shadow the runtime tag', () => {
    const both = normalizeModel(
      comp({
        type: 'node',
        tag: 'div',
        children: [
          { type: 'component', component: 'Markdown' },
          { type: 'markdown', source: '# real\n\nmd' },
        ],
      }),
    );
    const src = emit(both as any);
    expect(src).toMatch(/import Markdown_2 from/);
    assertRoundTrip(both);
  });

  test('markdown as a page root round-trips with page meta', () => {
    assertRoundTrip({
      meta: { title: 'Docs', slugs: { en: 'docs' } },
      root: { type: 'markdown', source: '# Docs\n\nWelcome to the **docs**.\n' },
    });
  });
});
