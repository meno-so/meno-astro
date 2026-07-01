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

describe('image optimization: <img data-meno-optimize> → <MenoImage>', () => {
  test('optimized img round-trips with the marker preserved', () => {
    assertRoundTrip(
      comp({
        type: 'node',
        tag: 'img',
        attributes: {
          src: '/images/hero.png',
          alt: 'Hero',
          width: 1200,
          height: 630,
          'data-meno-optimize': 'true',
        },
      }),
    );
  });

  test('emits <MenoImage> from meno-astro/components, marker consumed (not literal)', () => {
    const src = emitComp({
      type: 'node',
      tag: 'img',
      attributes: { src: '/images/hero.png', alt: 'Hero', width: 1200, height: 630, 'data-meno-optimize': 'true' },
    });
    expect(src).toContain('<MenoImage');
    expect(src).toContain("from 'meno-astro/components'");
    expect(src).toContain('import { MenoImage }');
    // The discriminator marker must NOT appear as a literal attribute in the output.
    expect(src).not.toContain('data-meno-optimize');
    // The real image attributes still emit.
    expect(src).toContain('src="/images/hero.png"');
    expect(src).toContain('width={1200}');
    expect(src).toContain('height={630}');
  });

  test('templated src + optimize round-trips (src emits as expression)', () => {
    const structure = {
      type: 'node',
      tag: 'img',
      attributes: { src: '/images/{{slug}}.png', alt: 'A', 'data-meno-optimize': 'true' },
    };
    const src = emitComp(structure);
    // A `{{slug}}` src becomes a JS expression, not a literal attribute string.
    expect(src).toContain('src={`/images/${slug}.png`}');
    assertRoundTrip(comp(structure));
  });

  test('optimized img keeps style() class + inline style', () => {
    assertRoundTrip(
      comp({
        type: 'node',
        tag: 'img',
        style: { base: { borderRadius: '8px' } },
        attributes: { src: '/images/x.png', alt: '', 'data-meno-optimize': 'true' },
      }),
    );
  });

  test('a LOCAL <img> with no marker is optimized BY DEFAULT (emits <MenoImage>)', () => {
    const structure = { type: 'node', tag: 'img', attributes: { src: '/images/x.png', alt: 'X' } };
    const src = emitComp(structure);
    // No explicit marker, but a local raster src → normalize stamps it → <MenoImage>.
    expect(src).toContain('<MenoImage');
    expect(src).not.toContain('data-meno-optimize'); // marker is consumed, never literal
    // normalizeModel canonicalizes the default-on marker, so the model round-trips exactly.
    assertRoundTrip(comp(structure));
  });

  test('an explicit data-meno-optimize="false" OPTS OUT — stays a bare <img>', () => {
    const structure = {
      type: 'node',
      tag: 'img',
      attributes: { src: '/images/x.png', alt: 'X', 'data-meno-optimize': 'false' },
    };
    const src = emitComp(structure);
    expect(src).toContain('<img');
    expect(src).not.toContain('<MenoImage');
    // The opt-out marker IS a real attribute (only "true" is the consumed discriminator).
    expect(src).toContain('data-meno-optimize="false"');
    assertRoundTrip(comp(structure));
  });

  test('a REMOTE <img> is NOT optimized by default (the default is local-scoped)', () => {
    const structure = { type: 'node', tag: 'img', attributes: { src: 'https://cdn.example/x.png', alt: 'X' } };
    const src = emitComp(structure);
    expect(src).toContain('<img');
    expect(src).not.toContain('<MenoImage');
    expect(src).not.toContain('data-meno-optimize');
    assertRoundTrip(comp(structure));
  });

  test('a LOCAL .svg is NOT optimized by default (no raster gain)', () => {
    const structure = { type: 'node', tag: 'img', attributes: { src: '/icons/logo.svg', alt: '' } };
    const src = emitComp(structure);
    expect(src).toContain('<img');
    expect(src).not.toContain('<MenoImage');
    assertRoundTrip(comp(structure));
  });

  test('a user component named MenoImage does not shadow the runtime tag', () => {
    // Mirrors the `link` → `<Link>` shadow guard: a component literally named "MenoImage"
    // must emit under a uniquified import ident, never the reserved runtime tag.
    const both = normalizeModel(
      comp({
        type: 'node',
        tag: 'div',
        children: [
          { type: 'component', component: 'MenoImage' },
          { type: 'node', tag: 'img', attributes: { src: '/i/a.png', alt: 'a', 'data-meno-optimize': 'true' } },
        ],
      }),
    );
    const src = emit(both as any);
    // The user component is uniquified away from the reserved `MenoImage` tag.
    expect(src).toMatch(/import MenoImage_2 from/);
    assertRoundTrip(both);
  });
});
