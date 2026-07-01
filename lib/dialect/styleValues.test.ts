/**
 * Durable `__styleValues` side-channel — codec round-trip.
 *
 * A hash-fallback utility class (a value that can't live in the class name — quotes/brackets, e.g.
 * grid-template-areas) loses its value on reload unless the `.astro` carries it. These tests prove
 * emit writes the `const __styleValues` side-channel and parse restores it, so the value survives a
 * fresh process (cleared registry). See dialect/styleValues.ts + meno-core's collect/restore.
 */
import { describe, test, expect } from 'bun:test';
import { emit, parse } from './index';
import { stylesToClasses, classToStyle, clearRegistry } from 'meno-core/shared';

const UNENCODABLE = '"a a" "b c"'; // grid-template-areas value — quotes can't live in a class name

/** Mint the hash-fallback class for an un-encodable grid-template-areas value (forward pass). */
function hashClassFor(value: string): string {
  const cls = stylesToClasses({ gridTemplateAreas: value });
  expect(cls).toHaveLength(1);
  return cls[0]!;
}

describe('durable __styleValues side-channel', () => {
  test('emit writes the const and parse restores the value across a registry wipe', () => {
    clearRegistry();
    const cls = hashClassFor(UNENCODABLE); // registry now warm (forward pass)
    const model = {
      component: { structure: { type: 'node', tag: 'div', attributes: { class: cls }, children: ['x'] } },
    };

    const src = emit(model as any);
    // The side-channel const is present and carries the un-encodable value + its CSS property.
    expect(src).toContain('const __styleValues = {');
    expect(src).toContain(cls);
    expect(src).toContain('grid-template-areas');

    // Fresh process: the class name ALONE can't recover the value.
    clearRegistry();
    expect(classToStyle(cls)).toBeNull();

    // Parsing the .astro restores the registry from the const → reverse read recovers the value.
    const back = parse(src).model as any;
    expect(classToStyle(cls)?.value).toBe(UNENCODABLE);
    // The class token round-trips onto the node unchanged.
    expect(back.component.structure.attributes.class).toBe(cls);
  });

  test('re-emit is byte-stable after a parse (parse warms the registry, emit re-derives the const)', () => {
    clearRegistry();
    const cls = hashClassFor(UNENCODABLE);
    const src = emit({
      component: { structure: { type: 'node', tag: 'div', attributes: { class: cls }, children: ['x'] } },
    } as any);

    clearRegistry(); // fresh process
    const reEmitted = emit(parse(src).model as any);
    expect(reEmitted).toBe(src);
  });

  test('no const is emitted when no node carries a hash-fallback class (no bloat)', () => {
    clearRegistry();
    const src = emit({
      component: {
        structure: { type: 'node', tag: 'div', attributes: { class: 'p-[24px] flex' }, children: ['x'] },
      },
    } as any);
    expect(src).not.toContain('__styleValues');
  });

  test('an instance override (props.class) hash value is side-channelled too', () => {
    clearRegistry();
    const cls = hashClassFor(UNENCODABLE);
    const page = {
      root: {
        type: 'node',
        tag: 'main',
        children: [{ type: 'component', component: 'Card', props: { class: cls } }],
      },
    };
    const src = emit(page as any);
    expect(src).toContain('const __styleValues = {');
    expect(src).toContain(cls);

    clearRegistry();
    parse(src); // restores
    expect(classToStyle(cls)?.value).toBe(UNENCODABLE);
  });
});
