import { test, expect, describe, afterEach } from 'bun:test';
import { buildUtilityStylesheet, collectModelClassTokens, collectNodeClassTokens } from './utilityCss';
import { emit } from '../dialect';
import { style } from '../runtime/style';
import { DEFAULT_BREAKPOINTS } from 'meno-core/shared';
import type { ResponsiveScales } from 'meno-core/shared';

// A real styled component file (frontmatter + body) the parser fully understands.
const GOOD = emit({
  component: { structure: { type: 'node', tag: 'div', style: { base: { color: 'red' } }, children: 'hi' } },
} as any);

// The same file truncated mid-expression so `parse()` throws — stands in for the real-world
// skew where the published parser predates the converter's emitted syntax.
const BAD = GOOD.slice(0, GOOD.indexOf('class={style(') + 'class={style('.length);

describe('buildUtilityStylesheet', () => {
  const realWarn = console.warn;
  afterEach(() => {
    console.warn = realWarn;
  });

  test('a parse failure is skipped but does NOT drop the other files’ CSS', () => {
    console.warn = () => {};
    const css = buildUtilityStylesheet([
      { src: GOOD, path: 'a.astro' },
      { src: BAD, path: 'b.astro' },
    ]);
    // GOOD still contributed its utility class even though BAD threw.
    expect(css).toContain('color: red');
  });

  test('a parse failure WARNS with the file path (no silent CSS loss)', () => {
    const warnings: string[] = [];
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };
    buildUtilityStylesheet([{ src: BAD, path: 'src/components/Heading.astro' }]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('Heading.astro');
    expect(warnings[0]).toContain('meno-astro');
  });

  test('bare-string sources still work (path-less)', () => {
    console.warn = () => {};
    expect(buildUtilityStylesheet([GOOD])).toContain('color: red');
  });

  test('junk after a declaration value cannot corrupt the sheet; style() stays in sync', () => {
    // Real-world import junk (binome): UI text pasted after the actual box-shadow. In a
    // browser <style> the junk is dropped by error recovery, but the generated sheet
    // goes through PostCSS, which hard-fails the WHOLE file (CssSyntaxError) — so the
    // value must be sanitized at generation time.
    const junk = '0 0 56px 0 rgba(101, 41, 164, 0.38);  Assets Videos  colorflow-animation (16) 1 140 x 140';
    const src = emit({
      component: {
        structure: { type: 'node', tag: 'div', style: { base: { boxShadow: junk } }, children: 'hi' },
      },
    } as any);
    expect(src).not.toContain('Assets'); // the converter already emits the sanitized value
    const css = buildUtilityStylesheet([src]);
    expect(css).toContain('box-shadow: 0 0 56px 0 rgba(101, 41, 164, 0.38)');
    expect(css).not.toContain('Assets');
    // A STALE .astro (emitted before sanitization) still carries the junk literal — the
    // runtime style() must sanitize identically so its class matches the sheet's rule.
    // Tailwind-style class names carry brackets/parens, escaped in the selector.
    const cls = style({ base: { boxShadow: junk } });
    const escaped = cls.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    expect(css).toContain(`.${escaped} {`);
  });
});

describe('buildUtilityStylesheet — tablet/mobile {{template}} CSS-variable bridge', () => {
  // A CSS-checkbox mobile menu: the panel's CLOSED state is a prop-bound opacity/visibility that
  // lives only in the `tablet` breakpoint, and an interactive `#menu-toggle:checked ~` rule sets the
  // OPEN state. Before the bridge, the tablet templates were dropped → the panel had no closed
  // default → it rendered open-by-default and the toggle did nothing.
  const MENU = emit({
    component: {
      structure: {
        type: 'node',
        tag: 'nav',
        children: [
          { type: 'node', tag: 'input', attributes: { type: 'checkbox', id: 'menu-toggle' } },
          {
            type: 'node',
            tag: 'div',
            label: 'NavList',
            style: {
              base: { display: 'flex' },
              tablet: { opacity: '{{isOpen ? 1 : 0}}', visibility: "{{isOpen ? 'visible' : 'hidden'}}" },
            },
            interactiveStyles: [
              {
                name: 'on Open',
                prefix: '#menu-toggle:checked ~',
                postfix: '',
                style: { base: {}, tablet: { opacity: '1', visibility: 'visible' }, mobile: {} },
              },
            ],
            children: 'links',
          },
        ],
      },
    },
  } as any);

  test('closed default (var rule) AND open override (interactive) are BOTH in the sheet', () => {
    const css = buildUtilityStylesheet([MENU]);
    // Closed default: the tablet templates now bridge to var-reading rules (previously dropped).
    expect(css).toContain('opacity: var(--m-tablet-opacity)');
    expect(css).toContain('visibility: var(--m-tablet-visibility)');
    // Open override: the :checked rule sets the property DIRECTLY, so it wins by specificity.
    expect(css).toMatch(/#menu-toggle:checked[^}]*opacity: 1/);
    // The element sets the variable inline to its render-resolved value (the bridge's other half).
    expect(MENU).toContain('--m-tablet-opacity: ${isOpen ? 1 : 0}');
  });
});

describe('buildUtilityStylesheet — link (olink) reset', () => {
  // The link reset lives off the model (applied at render by style()), so the build scan must
  // emit its utility rules unconditionally for link nodes — else the classes ship with no CSS.
  const linkPage = (link: Record<string, unknown>) =>
    emit({
      component: {
        structure: { type: 'node', tag: 'div', children: [{ type: 'link', href: '/x', children: 'Go', ...link }] },
      },
    } as any);

  test('a style-less link still emits the reset utilities (block / no-underline / text-inherit)', () => {
    const css = buildUtilityStylesheet([linkPage({})]);
    expect(css).toContain('display: block'); // .block
    expect(css).toContain('text-decoration: none'); // .no-underline
    expect(css).toContain('color: inherit'); // .text-inherit
  });

  test('a link with an explicit display still carries the reset rules (union, not object-merge)', () => {
    // The sheet over-generates: both `.flex` (its own) and `.block` (the reset) exist as rules.
    // Only one lands on the element at runtime (style() merges reset UNDER the node's style).
    const css = buildUtilityStylesheet([linkPage({ style: { base: { display: 'flex' } } })]);
    expect(css).toContain('display: flex'); // .flex — the link's own
    expect(css).toContain('display: block'); // .block — reset rule still present in the sheet
    expect(css).toContain('text-decoration: none');
    expect(css).toContain('color: inherit');
  });
});

describe('buildUtilityStylesheet — responsive scaling', () => {
  // A div whose base style sets a scalable property (padding). With scaling enabled this
  // class must get per-breakpoint / clamp() scaling, the same meno-core's SSR/canvas emit.
  const PADDED = emit({
    component: { structure: { type: 'node', tag: 'div', style: { base: { padding: '32px' } }, children: 'hi' } },
  } as any);

  test('breakpoints mode emits @media (max-width) scaled rules for utility classes', () => {
    const scales: ResponsiveScales = {
      enabled: true,
      mode: 'breakpoints',
      baseReference: 16,
      padding: { tablet: 0.75, mobile: 0.5 },
    };
    const css = buildUtilityStylesheet([PADDED], DEFAULT_BREAKPOINTS, scales);
    expect(css).toContain('padding: 32px'); // base rule still present
    expect(css).toContain('@media (max-width:'); // scaled overrides added
    // tablet scale 0.75 with baseRef 16: 32 + (32-16)*(0.75-1) = 28px
    expect(css).toContain('padding: 28px');
  });

  test('fluid mode bakes clamp() into the base utility rule (no @media)', () => {
    const scales: ResponsiveScales = {
      enabled: true,
      mode: 'fluid',
      baseReference: 16,
      fluidRange: { min: 320, max: 1440 },
      padding: { tablet: 0.75, mobile: 0.5 },
    };
    const css = buildUtilityStylesheet([PADDED], DEFAULT_BREAKPOINTS, scales);
    expect(css).toContain('clamp(');
    expect(css).not.toContain('@media (max-width:'); // fluid encodes scaling in the value
  });

  test('omitting the scales arg leaves utility CSS unscaled (back-compat)', () => {
    const css = buildUtilityStylesheet([PADDED]);
    expect(css).toContain('padding: 32px');
    expect(css).not.toContain('@media (max-width:');
    expect(css).not.toContain('clamp(');
  });

  test('disabled scaling config is a no-op', () => {
    const scales: ResponsiveScales = {
      enabled: false,
      mode: 'breakpoints',
      baseReference: 16,
      padding: { tablet: 0.75, mobile: 0.5 },
    };
    const css = buildUtilityStylesheet([PADDED], DEFAULT_BREAKPOINTS, scales);
    expect(css).not.toContain('@media (max-width:');
  });

  test('centered heading keeps margin-bottom on tablet (margin:auto shorthand cannot clobber it)', () => {
    // A centered heading: margin:auto (centering) + marginBottom (spacing). With margin
    // scaling on, both land in the tablet @media. The shorthand must precede the longhand
    // there (equal specificity ⇒ source order), else `margin: auto` resets margin-bottom to
    // 0 on tablet — the real Astro-play regression where select mode kept the margin but
    // Astro lost it (different class-collection order, unsorted @media).
    const HEADING = emit({
      component: {
        structure: {
          type: 'node',
          tag: 'h2',
          style: { base: { marginBottom: '16px', maxWidth: '520px', margin: 'auto' } },
          children: 'hi',
        },
      },
    } as any);
    const scales: ResponsiveScales = {
      enabled: true,
      mode: 'breakpoints',
      baseReference: 16,
      margin: { tablet: 0.7, mobile: 0.45 },
    };
    const css = buildUtilityStylesheet([HEADING], DEFAULT_BREAKPOINTS, scales);
    const t = css.indexOf('@media (max-width: 1024px)');
    const block = css.slice(t, css.indexOf('}\n}', t) + 3);
    const posShorthand = block.indexOf('.m-auto');
    const posLonghand = block.indexOf('.mb-\\[16px\\]');
    expect(posShorthand).toBeGreaterThanOrEqual(0);
    expect(posLonghand).toBeGreaterThan(posShorthand);
  });
});

describe('collectModelClassTokens', () => {
  test('unions every styled node’s class tokens across the tree (unstyled nodes contribute none)', () => {
    const model = {
      root: {
        type: 'node',
        tag: 'div',
        style: { base: { gap: '8px' } },
        children: [
          { type: 'node', tag: 'p', style: { base: { fontSize: '16px' } }, children: 'hi' },
          { type: 'component', component: 'Card', props: { title: 'x' } }, // no style → no tokens
        ],
      },
    };
    const tokens = collectModelClassTokens(model);
    for (const t of collectNodeClassTokens({ base: { gap: '8px' } }, undefined, undefined))
      expect(tokens.has(t)).toBe(true);
    for (const t of collectNodeClassTokens({ base: { fontSize: '16px' } }, undefined, undefined))
      expect(tokens.has(t)).toBe(true);
  });

  test('expands a prop _mapping across ALL its values (the variant-prop vocabulary)', () => {
    const model = {
      root: {
        type: 'node',
        tag: 'h1',
        style: {
          base: {
            textAlign: { _mapping: true, prop: 'align', values: { left: 'left', center: 'center', right: 'right' } },
          },
        },
      },
    };
    const tokens = collectModelClassTokens(model);
    for (const v of ['left', 'center', 'right']) {
      for (const t of collectNodeClassTokens({ base: { textAlign: v } }, undefined, undefined)) {
        expect(tokens.has(t)).toBe(true); // every mapping value is in the vocabulary
      }
    }
  });

  test('a model with no styled nodes yields no tokens', () => {
    expect(collectModelClassTokens({ root: { type: 'node', tag: 'div', children: 'hi' } }).size).toBe(0);
  });
});
