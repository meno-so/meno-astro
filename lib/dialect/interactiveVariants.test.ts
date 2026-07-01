/**
 * Interactive styles ⇄ variant classes (hover:/focus:/active:) + their build-time CSS.
 */
import { describe, test, expect } from 'bun:test';
import { stylesToClasses, clearRegistry } from 'meno-core/shared';
import { emit, parse, normalizeModel } from './index';
import { buildUtilityStylesheet } from '../integration/utilityCss';
import {
  interactiveToTokens,
  reconstructInteractive,
  generateStateVariantCss,
  extractStateVariantTokens,
  isStateVariantClass,
} from './interactiveVariants';

describe('interactiveStyles → variant tokens', () => {
  test('a simple :hover rule converts to a hover: token and round-trips', () => {
    const rules = [{ name: 'onHover', postfix: ':hover', style: { base: { background: '#222' } } }];
    const base = stylesToClasses({ background: '#222' })[0];
    const tokens = interactiveToTokens(rules);
    expect(tokens).toEqual([`hover:${base}`]);
    // Reconstruct (the inverse) reproduces the original rule (canonical name included).
    expect(reconstructInteractive(tokens!)).toEqual(rules);
  });

  test('interactive styles on a link/embed/markdown node lower into attributes.class (not just <tag> elements)', () => {
    // The lowering's isElementNode gate covers the class-stylable content nodes (embed/link/markdown),
    // mirroring the class-styling migration — not only HTML elements. A `:hover` with a `var(--token)`
    // color (whose name can't be a bare token) lowers via the arbitrary form and stays class-first.
    const out = emit(
      normalizeModel({
        component: {
          structure: {
            type: 'link',
            href: '/x',
            interactiveStyles: [
              { prefix: '', postfix: ':hover', style: { base: { backgroundColor: 'var(--salmon)' } } },
            ],
            children: 'go',
          },
        },
      } as never) as never,
    );
    expect(out).toContain('hover:bg-[var(--salmon)]'); // class-first, var() preserved
    expect(out).not.toContain('interactive:'); // not the style({ interactive: [...] }) object form
  });

  test('a flat (non-{base}) style is treated as base and round-trips', () => {
    const tokens = interactiveToTokens([{ postfix: ':focus', style: { color: 'red' } } as any]);
    expect(tokens?.[0]).toMatch(/^focus:/);
    // Reconstruct canonicalizes to { name:'onFocus', postfix, style:{ base } }.
    expect(reconstructInteractive(tokens!)).toEqual([
      {
        name: 'onFocus',
        postfix: ':focus',
        style: { base: stylesToClasses({ color: 'red' }).length ? { color: 'red' } : {} },
      },
    ]);
  });

  test('multiple distinct-variant rules convert in order', () => {
    const tokens = interactiveToTokens([
      { name: 'onHover', postfix: ':hover', style: { base: { opacity: '0.8' } } },
      { name: 'onActive', postfix: ':active', style: { base: { opacity: '0.6' } } },
    ]);
    expect(tokens!.some((t) => t.startsWith('hover:'))).toBe(true);
    expect(tokens!.some((t) => t.startsWith('active:'))).toBe(true);
    expect(reconstructInteractive(tokens!).map((r) => r.postfix)).toEqual([':hover', ':active']);
  });

  describe('non-convertible → null (stays on the style() remainder path)', () => {
    test('a context prefix', () => {
      expect(
        interactiveToTokens([{ prefix: '.is-dark ', postfix: ':hover', style: { base: { color: 'red' } } }]),
      ).toBeNull();
    });
    test('a compound/unknown postfix', () => {
      expect(interactiveToTokens([{ postfix: '.is-active:hover', style: { base: { color: 'red' } } }])).toBeNull();
    });
    test('a non-canonical name', () => {
      expect(
        interactiveToTokens([{ name: 'myHover', postfix: ':hover', style: { base: { color: 'red' } } }]),
      ).toBeNull();
    });
    test('a responsive interactive style (tablet override)', () => {
      expect(
        interactiveToTokens([{ postfix: ':hover', style: { base: { color: 'red' }, tablet: { color: 'blue' } } }]),
      ).toBeNull();
    });
    test('two rules sharing a postfix (ambiguous on parse)', () => {
      expect(
        interactiveToTokens([
          { postfix: ':hover', style: { base: { color: 'red' } } },
          { postfix: ':hover', style: { base: { background: '#000' } } },
        ]),
      ).toBeNull();
    });
  });

  test('extractStateVariantTokens splits variant tokens from the rest', () => {
    const base = stylesToClasses({ background: '#222' })[0];
    const { tokens, rest } = extractStateVariantTokens(`p-[24px] hover:${base} flex`);
    expect(tokens).toEqual([`hover:${base}`]);
    expect(rest).toBe('p-[24px] flex');
    expect(isStateVariantClass(`hover:${base}`)).toBe(true);
    expect(isStateVariantClass('p-[24px]')).toBe(false);
  });
});

describe('generateStateVariantCss', () => {
  test('emits an escaped pseudo-class rule with the base declaration', () => {
    clearRegistry();
    const base = stylesToClasses({ background: '#222' })[0]; // e.g. bg-[#222]
    const css = generateStateVariantCss([`hover:${base}`]);
    // Selector: escaped full token + :hover ; body: the base utility's declaration.
    expect(css).toContain(':hover');
    expect(css).toMatch(/\.hover\\:/); // class colon is backslash-escaped in the selector
    expect(css).toMatch(/background(-color)?:\s*#222/);
  });

  test('skips non-variant tokens', () => {
    expect(generateStateVariantCss(['p-[24px]', 'flex'])).toBe('');
  });
});

describe('codec round-trip (emit lowers → parse lifts)', () => {
  test('a convertible :hover rule emits as a variant token and reconstructs on parse', () => {
    const model = {
      component: {
        structure: {
          type: 'node',
          tag: 'a',
          attributes: { class: 'p-[24px]' },
          interactiveStyles: [{ name: 'onHover', postfix: ':hover', style: { base: { background: '#222' } } }],
          children: ['hi'],
        },
      },
    };
    const base = stylesToClasses({ background: '#222' })[0];
    const src = emit(normalizeModel(model) as any);
    // Lowered into the class string as a variant token — NOT the style() interactive meta.
    expect(src).toContain(`hover:${base}`);
    expect(src).not.toContain('interactive:');

    // Parse lifts it back into reconstructed interactiveStyles; the static class survives.
    const back = (parse(src).model as any).component.structure;
    expect(back.interactiveStyles).toEqual([
      { name: 'onHover', postfix: ':hover', style: { base: { background: '#222' } } },
    ]);
    expect(back.attributes.class).toBe('p-[24px]');
  });

  test('full round-trip is exact for a multi-state node', () => {
    const model = {
      component: {
        structure: {
          type: 'node',
          tag: 'button',
          interactiveStyles: [
            { name: 'onHover', postfix: ':hover', style: { base: { opacity: '0.8' } } },
            { name: 'onActive', postfix: ':active', style: { base: { opacity: '0.6' } } },
          ],
          children: ['x'],
        },
      },
    };
    const norm = normalizeModel(model);
    const back = parse(emit(norm as any)).model;
    expect(back).toEqual(norm as any);
  });

  test('the build scan generates :hover CSS matching the element class (emit → buildUtilityStylesheet)', () => {
    clearRegistry();
    const src = emit({
      meta: { title: 'T' },
      root: {
        type: 'node',
        tag: 'main',
        interactiveStyles: [{ name: 'onHover', postfix: ':hover', style: { base: { color: '#ff0000' } } }],
        children: ['hover'],
      },
    } as any);
    const base = stylesToClasses({ color: '#ff0000' })[0]; // text-[#ff0000]
    expect(src).toContain(`hover:${base}`); // the element renders with this class
    const css = buildUtilityStylesheet([src]);
    // A :hover rule setting the color — selector escaping aside, the declaration + pseudo must be there.
    expect(css).toMatch(/:hover\s*\{[^}]*color:\s*#ff0000/);
  });

  test('a non-convertible rule (context prefix) stays on the style() interactive path', () => {
    const model = {
      component: {
        structure: {
          type: 'node',
          tag: 'div',
          interactiveStyles: [{ prefix: '.is-dark ', postfix: ':hover', style: { base: { color: 'red' } } }],
          children: ['x'],
        },
      },
    };
    const src = emit(normalizeModel(model) as any);
    expect(src).toContain('interactive:'); // kept in style() meta
    expect(src).not.toMatch(/hover:/);
    // Still round-trips (via the existing style() path).
    const norm = normalizeModel(model);
    expect(parse(emit(norm as any)).model).toEqual(norm as any);
  });
});
