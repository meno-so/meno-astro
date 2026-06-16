/**
 * style() runtime — instance-over-root class merge (the `meta.root` contract).
 *
 * A parent passes per-instance styles to a component as a computed class string
 * (`<Image class={style({…}, __props, { instance: true })} />`); the component's
 * structure root is emitted with `root: true` so style() merges that incoming class
 * (`props.class`) over the root's own classes — instance wins per (breakpoint, CSS
 * property), mirroring meno-core's instance-over-root style-object merge. Without the
 * property-aware drop, `.h-full` and `.h-auto` would both apply and stylesheet order —
 * not the instance — would decide (the SliderCards regression: the card image kept
 * `height: 100%`, swallowing the card body).
 */

import { test, expect, describe } from 'bun:test';
import { style, mergeInstanceClasses, linkClass, inlineStyle } from './style';

describe('mergeInstanceClasses', () => {
  test('instance class overrides the root class on the same property', () => {
    // Image root: display:block, width/height 100%. Instance: width 100%, height auto.
    const merged = mergeInstanceClasses(['block', 'w-full', 'h-full', 'border-(--border)'], 'w-full h-auto');
    expect(merged).not.toContain('h-full'); // height: instance wins
    expect(merged).toContain('h-auto');
    expect(merged).toContain('block'); // untouched root classes survive
    expect(merged).toContain('border-(--border)');
    // The shared width class appears exactly once.
    expect(merged.filter((c) => c === 'w-full')).toHaveLength(1);
  });

  test('merge is breakpoint-scoped: a tablet override does not drop the base class', () => {
    const merged = mergeInstanceClasses(['h-full', 'tablet:h-full'], 'tablet:h-auto');
    expect(merged).toContain('h-full'); // base untouched
    expect(merged).not.toContain('tablet:h-full'); // tablet: instance wins
    expect(merged).toContain('tablet:h-auto');
  });

  test('unrecognized classes (interactive hash, dynamic registry) are always kept', () => {
    // `m_…` interactive classes don't decode to a CSS property — never conflict-dropped.
    const merged = mergeInstanceClasses(['m_card_abc123', 'p-[24px]'], 'm_inst_def456 p-[12px]');
    expect(merged).toContain('m_card_abc123');
    expect(merged).toContain('m_inst_def456');
    expect(merged).not.toContain('p-[24px]'); // padding: instance wins
    expect(merged).toContain('p-[12px]');
  });

  test('empty instance class is a no-op', () => {
    expect(mergeInstanceClasses(['block', 'w-full'], '')).toEqual(['block', 'w-full']);
  });
});

describe('style() with meta.root', () => {
  test('merges props.class over the computed classes (instance wins on conflicts)', () => {
    const cls = style(
      { base: { display: 'block', width: '100%', height: '100%' } },
      { class: 'w-full h-auto' },
      { root: true },
    );
    const classes = cls.split(' ');
    expect(classes).toContain('block');
    expect(classes).toContain('h-auto');
    expect(classes).not.toContain('h-full');
    expect(classes.filter((c) => c === 'w-full')).toHaveLength(1);
  });

  test('a style-less root still renders the incoming instance class', () => {
    // Emitted as `class={style({}, __props, { root: true })}` when the root has no style.
    expect(style({}, { class: 'w-full h-auto' }, { root: true })).toBe('w-full h-auto');
  });

  test('without meta.root, props.class is ignored (non-root elements)', () => {
    const cls = style({ base: { height: '100%' } }, { class: 'h-auto' });
    expect(cls).toBe('h-full');
  });

  test('root with no incoming class behaves as before', () => {
    expect(style({ base: { height: '100%' } }, { class: '' }, { root: true })).toBe('h-full');
    expect(style({ base: { height: '100%' } }, undefined, { root: true })).toBe('h-full');
  });
});

describe('inlineStyle() — component-root prop-bound inline styles, instance-aware', () => {
  // A component root binds a CSS property to a prop via `{{prop}}` (e.g. maxWidth), which can't
  // be a build-time utility class, so it renders inline: `style={inlineStyle({ "max-width":
  // `${maxWidth}` }, __props)}`. An inline style outranks the utility class a parent's instance
  // override lands on the same element, so inlineStyle() drops a declaration the instance overrides
  // (read off `props.__menoStyle`) — restoring meno-core's "instance wins" (mergeComponentStyles).
  test('no instance override → the inline declaration is kept', () => {
    expect(inlineStyle({ 'max-width': '100%' }, { class: '' })).toBe('max-width: 100%');
    expect(inlineStyle({ 'max-width': '100%' }, undefined)).toBe('max-width: 100%');
  });

  test('a STATIC instance override → the inline declaration is dropped (its utility class wins)', () => {
    const props = { __menoStyle: { base: { maxWidth: '889px' }, tablet: {}, mobile: {} } };
    // max-width is overridden → dropped → undefined (Astro omits the attribute), so the merged
    // `.max-w-[889px]` class is the only max-width rule on the element.
    expect(inlineStyle({ 'max-width': '100%' }, props)).toBeUndefined();
  });

  test('only the overridden property is dropped; siblings stay inline', () => {
    const props = { __menoStyle: { base: { maxWidth: '889px' } } };
    expect(inlineStyle({ 'max-width': '100%', gap: '12px' }, props)).toBe('gap: 12px');
  });

  test('a prop-`_mapping` instance value counts as an override (it produced a utility class)', () => {
    const props = { __menoStyle: { base: { maxWidth: { _mapping: true, prop: 'size', values: { '1': '800px' } } } } };
    expect(inlineStyle({ 'max-width': '100%' }, props)).toBeUndefined();
  });

  test('a {{template}} instance value is NOT an override (no class is generated for it)', () => {
    // Suppressing here would leave the property unset, so the root keeps its own inline value.
    const props = { __menoStyle: { base: { maxWidth: '{{heroWidth}}' } } };
    expect(inlineStyle({ 'max-width': '100%' }, props)).toBe('max-width: 100%');
  });

  test('an empty / absent instance value does not suppress', () => {
    expect(inlineStyle({ 'max-width': '100%' }, { __menoStyle: { base: { maxWidth: '' } } })).toBe('max-width: 100%');
    expect(inlineStyle({ 'max-width': '100%' }, { __menoStyle: { base: { gap: '8px' } } })).toBe('max-width: 100%');
  });

  test('camelCase instance keys match kebab-case inline props (marginBottom ↔ margin-bottom)', () => {
    const props = { __menoStyle: { base: { marginBottom: '0' } } };
    expect(inlineStyle({ 'margin-bottom': '20px' }, props)).toBeUndefined();
  });

  test('a flat (non-responsive) instance style object is read too', () => {
    expect(inlineStyle({ 'max-width': '100%' }, { __menoStyle: { maxWidth: '500px' } })).toBeUndefined();
  });

  test('returns undefined when every declaration is dropped, so Astro omits the attr', () => {
    expect(inlineStyle({}, { class: '' })).toBeUndefined();
  });
});

describe('style() — {{template}} declarations bridge through a CSS variable so interactive rules can override', () => {
  test('a tablet template becomes a var(--m-tablet-<prop>) utility class', () => {
    const out = style(
      {
        base: { display: 'flex' },
        tablet: { opacity: '{{isOpen ? 1 : 0}}', pointerEvents: "{{isOpen ? 'auto' : 'none'}}" },
      },
      { isOpen: false },
    );
    const tokens = out.split(/\s+/);
    expect(tokens).toContain('flex'); // static base prop unaffected
    expect(tokens).toContain('tablet:opacity-(--m-tablet-opacity)');
    expect(tokens).toContain('tablet:[pointer-events:var(--m-tablet-pointer-events)]');
  });

  test('a mobile template bridges with the mobile-scoped variable name', () => {
    const out = style({ mobile: { opacity: '{{isOpen ? 1 : 0}}' } }, { isOpen: false });
    expect(out.split(/\s+/)).toContain('mobile:opacity-(--m-mobile-opacity)');
  });

  test('a NON-ROOT base template ALSO bridges (so a :hover/.is-open rule can override it — the dropdown bug)', () => {
    // The dropdown panel's closed state is a base-breakpoint prop binding; if it rendered as a
    // direct inline `opacity:0` it would outrank the `li.is-open .menu { opacity:1 }` class and the
    // panel could never open. Bridged via a variable, the property is class-only → the interactive
    // rule wins by specificity.
    const out = style({ base: { opacity: '{{isOpen ? 1 : 0}}' } }, { isOpen: false });
    expect(out.split(/\s+/)).toContain('opacity-(--m-base-opacity)');
  });

  test('a ROOT base template is NOT bridged (kept on the direct-inline instance-over-root path)', () => {
    // meta.root → the base template stays a direct inline declaration (inlineStyle), so the
    // instance-over-root suppression governs it; only tablet/mobile bridge on a root.
    const out = style(
      { base: { maxWidth: '{{maxWidth}}' }, tablet: { opacity: '{{isOpen ? 1 : 0}}' } },
      {},
      { root: true },
    );
    expect(out).not.toContain('--m-base-'); // base stays direct
    expect(out.split(/\s+/)).toContain('tablet:opacity-(--m-tablet-opacity)'); // tablet still bridges
  });
});

describe('linkClass() — the intrinsic link UA reset', () => {
  // meno-core seeds every link node with the `.olink` class (`display:block; text-decoration:none;
  // color:inherit`). meno-astro's Link.astro runtime component mirrors that by running its class
  // through linkClass(), which adds the SAME reset as utilities — `block no-underline text-inherit`
  // — conflict-aware: a reset utility is kept only when the link's own classes don't set that
  // property. No per-node marker, no re-conversion: it reaches every <Link> at render.
  test('a style-less link (no incoming class) gets the full reset', () => {
    const full = ['block', 'no-underline', 'text-inherit'];
    for (const empty of [undefined, '', null]) {
      const classes = linkClass(empty).split(' ').filter(Boolean);
      expect(classes).toEqual(expect.arrayContaining(full));
      expect(classes).toHaveLength(3); // exactly the reset, nothing else (order is irrelevant)
    }
  });

  test("an explicit display drops the reset's block — one display class, no cascade fight", () => {
    const classes = linkClass('flex gap-[8px]').split(' ');
    expect(classes).toContain('flex');
    expect(classes).not.toContain('block'); // conflict-aware: link's own display wins
    expect(classes).toContain('no-underline'); // untouched reset utilities remain
    expect(classes).toContain('text-inherit');
    expect(classes).toContain('gap-[8px]'); // unrelated link classes pass through
  });

  test('an authored text-decoration / color drops the matching reset utility', () => {
    expect(linkClass('underline').split(' ')).not.toContain('no-underline');
    expect(linkClass('underline')).toContain('underline');
    expect(linkClass('text-[#f00]').split(' ')).not.toContain('text-inherit');
    expect(linkClass('text-[#f00]')).toContain('text-[#f00]');
  });

  test('a base display drops base block but a tablet-only override keeps it (breakpoint-scoped)', () => {
    // tablet:flex conflicts only at the tablet breakpoint; the base block reset stays.
    const classes = linkClass('tablet:flex').split(' ');
    expect(classes).toContain('block');
    expect(classes).toContain('tablet:flex');
  });

  test('a foreign/static class (no recognized CSS property) is always kept', () => {
    const classes = linkClass('swiper m_card_abc123').split(' ');
    expect(classes).toEqual(
      expect.arrayContaining(['block', 'no-underline', 'text-inherit', 'swiper', 'm_card_abc123']),
    );
  });
});
