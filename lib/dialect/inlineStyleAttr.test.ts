import { test, expect, describe } from 'bun:test';
import { emit, parse, normalizeModel } from './index';

/** Round-trip gate: parse(emit(x)) === normalizeModel(x). */
function assertRoundTrip(x: unknown) {
  const n = normalizeModel(x);
  expect(normalizeModel(n)).toEqual(n as any);
  expect(parse(emit(n as any)).model).toEqual(n as any);
}

/** Parse a component whose structure root is the given single element source; return that root. */
function parseRoot(elementSrc: string): any {
  const src = `---
import { resolveProps, style } from 'meno-astro';
const __props = resolveProps(Astro, {});
---
${elementSrc}`;
  return (parse(src).model as any).component.structure;
}

describe('foreign inline `style=` is absorbed into the Meno node.style (one style system)', () => {
  test('a static literal style="…" becomes node.style.base (editable), no attributes.style', () => {
    const root = parseRoot('<div style="display:flex;align-items:center;gap:12px;padding:12px 0">x</div>');
    expect(root.style).toEqual({ base: { display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 0' } });
    expect(root.attributes).toBeUndefined();
  });

  test('a dynamic ternary style={cond ? "decls" : undefined} becomes per-property TEMPLATE values', () => {
    const root = parseRoot(`<div style={note.done ? 'text-decoration:line-through;color:#9ca3af' : undefined}>x</div>`);
    expect(root.style.base.textDecoration).toBe("{{note.done ? 'line-through' : 'unset'}}");
    expect(root.style.base.color).toBe("{{note.done ? '#9ca3af' : 'unset'}}");
    expect(root.attributes).toBeUndefined();
  });

  test("a property's false-branch default is the element's own static value when present", () => {
    // The card already sets color via class; the conditional's `: undefined` branch should fall
    // back to that static color, not a blind `unset`.
    const root = parseRoot(
      `<div class={style({ base: { color: "#111" } }, __props)} style={on ? 'color:#999' : undefined}>x</div>`,
    );
    expect(root.style.base.color).toBe("{{on ? '#999' : '#111'}}");
  });

  test('a foreign inline style merges OVER a class style (inline wins, browser specificity)', () => {
    const root = parseRoot(
      `<div class={style({ base: { padding: "4px", color: "red" } }, __props)} style="padding:20px">x</div>`,
    );
    expect(root.style.base.padding).toBe('20px'); // inline overrides the class value
    expect(root.style.base.color).toBe('red'); // class-only value preserved
  });

  test('an un-modelable dynamic style={expr} stays a verbatim attributes.style binding', () => {
    const root = parseRoot('<div style={dynamicStyleString}>x</div>');
    expect(root.style).toBeUndefined();
    expect(root.attributes.style).toBe('{{dynamicStyleString}}');
  });

  test("the dialect's DERIVED inline style is still skipped (reconstructed from class={style()})", () => {
    const root = parseRoot(
      `<div class={style({ base: { maxWidth: "{{maxWidth}}" } }, __props, { root: true })} style={inlineStyle({ "max-width": \`\${maxWidth}\` }, __props)} data-x="keep">x</div>`,
    );
    expect(root.style).toEqual({ base: { maxWidth: '{{maxWidth}}' } });
    expect(root.attributes?.style).toBeUndefined();
    expect(root.attributes?.['data-x']).toBe('keep');
  });

  describe('round-trips', () => {
    test('static literal', () => {
      assertRoundTrip({
        component: { structure: { type: 'node', tag: 'div', attributes: { style: 'color:red' }, children: ['x'] } },
      });
    });
    test('dynamic per-property template values', () => {
      assertRoundTrip({
        component: {
          structure: {
            type: 'node',
            tag: 'div',
            style: { base: { textDecoration: "{{note.done ? 'line-through' : 'unset'}}" } },
            children: ['x'],
          },
        },
      });
    });
    test('emitted form uses class={style(…)}, not an inline style="…"', () => {
      const out = emit(
        normalizeModel({
          component: { structure: { type: 'node', tag: 'div', attributes: { style: 'color:red' } } },
        }) as any,
      );
      // The root wraps style() in the cx instance-merge form; the point is the absorbed style is a
      // class-gen call, not a literal inline style="…".
      expect(out).toContain('class={cx(style(');
      expect(out).not.toContain('style="color:red"');
    });
  });
});

describe('class-string styling — literal attributes.class round-trips (NOT absorbed like style=)', () => {
  // The asymmetry the editor relies on: a literal class="…" is KEPT as attributes.class (the
  // class-styling storage), unlike a foreign style="…" which is absorbed into node.style.
  test('a child node keeps its literal class verbatim through parse', () => {
    const root = parseRoot('<div><span class="p-[24px] swiper">x</span></div>');
    expect(root.children[0].attributes.class).toBe('p-[24px] swiper');
    expect(root.children[0].style).toBeUndefined();
  });

  test('a structure ROOT round-trips attributes.class through the cx("…", className) form', () => {
    // Root emit differs from child emit (it folds the static class into the cx instance-merge
    // form, `cx("…", className)`) — verify the class survives that path too.
    const model = normalizeModel({
      component: {
        structure: { type: 'node', tag: 'div', attributes: { class: 'p-[24px] swiper' }, children: ['hi'] },
      },
    });
    const out = emit(model as any);
    expect(out).toContain('cx("p-[24px] swiper", className)');
    const back = (parse(out).model as any).component.structure;
    expect(back.attributes.class).toBe('p-[24px] swiper');
  });

  test('full round-trip gate holds for class-styled child + root', () => {
    assertRoundTrip({
      component: {
        structure: {
          type: 'node',
          tag: 'section',
          attributes: { class: 'p-[40px]' },
          children: [{ type: 'node', tag: 'p', attributes: { class: 'p-[24px] tablet:p-[16px]' }, children: ['hi'] }],
        },
      },
    });
  });
});
