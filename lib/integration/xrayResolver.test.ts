/**
 * Unit tests for the bridge's shared identity resolver (XRAY_RESOLVER_JS) —
 * evaluated as real JS against a happy-dom document, exactly how the injected
 * script runs it in the play page.
 *
 * The synthetic DOM mirrors the adv-17 shape that produced the field bugs:
 * stacked roots (sections wrapping themselves in a <Section> wrapper → one
 * element carries the hop list "0,0;0"), file-local path collisions (the
 * page's "0,0" vs component-internal "0,0" elements), and LIST COPIES — a
 * slider rendering the same Card instance 3 times and a page-level list with
 * a nested inner list. Copies carry IDENTICAL identity attributes; the
 * resolver disambiguates them by occurrence (`item` — the play twin of SSR's
 * data-cms-item-index).
 *
 *   page:  Layout ("0") → slot: [Hero ("0,0"), Slider ("0,1"), ul ("0,2")]
 *   Layout.astro:  <div #0> <nav #0,1> <a #0,1,0>
 *   Hero.astro:    <Section> wrapper (stacked) → slot: <h1 #0,0>
 *   Slider.astro:  <Section> wrapper (stacked) → slot: Card list ("0,0,2" ×3)
 *   Card.astro:    <div #0> <span #0,0>
 *   Section.astro: <section #0> (its own file)
 *   page list:     <ul #0,2> → <li #0,2,0> ×2, each with <ul #0,2,0,1> → <li #0,2,0,1,0> ×2
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { Window } from 'happy-dom';
import { XRAY_RESOLVER_JS } from './xray';

// One DOM element per line; data-element-path / data-meno-instance /
// data-meno-slot mirror exactly what stampElementPaths emits at serve time.
// List copies are what the runtime produces: the same stamped template
// rendered N times as siblings.
const PAGE_HTML = `
  <div id="layout-root" data-element-path="0" data-meno-instance="0">
    <nav data-element-path="0,1">
      <a id="nav-link" data-element-path="0,1,0">Home</a>
    </nav>
    <!-- Hero at page path 0,0 — stacked root (Hero wraps <Section>) -->
    <section id="hero-section" data-element-path="0"
             data-meno-instance="0,0;0" data-meno-slot="0;">
      <h1 id="hero-h1" data-element-path="0,0" data-meno-slot="0">Welcome</h1>
    </section>
    <!-- Slider at page path 0,1 — stacked root with a LIST of Card instances -->
    <section id="slider-section" data-element-path="0"
             data-meno-instance="0,1;0" data-meno-slot="0;">
      <article id="card0" data-element-path="0"
               data-meno-instance="0,0,2" data-meno-slot="0">
        <span id="card0-span" data-element-path="0,0">Card 0</span>
      </article>
      <article id="card1" data-element-path="0"
               data-meno-instance="0,0,2" data-meno-slot="0">
        <span id="card1-span" data-element-path="0,0">Card 1</span>
      </article>
      <article id="card2" data-element-path="0"
               data-meno-instance="0,0,2" data-meno-slot="0">
        <span id="card2-span" data-element-path="0,0">Card 2</span>
      </article>
    </section>
    <!-- Page-level element list at 0,2 with a NESTED inner list -->
    <ul id="features" data-element-path="0,2" data-meno-slot="0">
      <li id="feat0" data-element-path="0,2,0" data-meno-slot="0">
        <ul data-element-path="0,2,0,1" data-meno-slot="0">
          <li id="feat0-inner0" data-element-path="0,2,0,1,0" data-meno-slot="0">a</li>
          <li id="feat0-inner1" data-element-path="0,2,0,1,0" data-meno-slot="0">b</li>
        </ul>
      </li>
      <li id="feat1" data-element-path="0,2,0" data-meno-slot="0">
        <ul data-element-path="0,2,0,1" data-meno-slot="0">
          <li id="feat1-inner0" data-element-path="0,2,0,1,0" data-meno-slot="0">c</li>
          <li id="feat1-inner1" data-element-path="0,2,0,1,0" data-meno-slot="0">d</li>
        </ul>
      </li>
    </ul>
  </div>`;

interface Resolver {
  identify: (el: Element | null) => { chain: string[]; path: string; item: string } | null;
  resolveTarget: (t: { chain: string[]; path: string; isComponent: boolean; item?: string }) => Element | null;
}

let doc: Document;
let resolver: Resolver;
const byId = (id: string) => doc.getElementById(id)!;

beforeAll(() => {
  const win = new Window();
  // happy-dom ≥20.9 references `window.SyntaxError` from its selector parser
  // but never defines it, breaking EVERY querySelector — same patch as
  // meno-core's test-utils dom-setup.
  (win as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
  win.document.body.innerHTML = PAGE_HTML;
  doc = win.document as unknown as Document;
  // Evaluate the resolver string the way the page would, with `document`
  // injected so the functions close over the test DOM.
  resolver = new Function(
    'document',
    `${XRAY_RESOLVER_JS}; return { identify: identify, resolveTarget: resolveTarget };`,
  )(doc) as Resolver;
});

describe('identify (click side)', () => {
  test('page slot content under a stacked root skips the wrapper hop', () => {
    expect(resolver.identify(byId('hero-h1'))).toEqual({ chain: ['0,0'], path: '0,0', item: '' });
  });

  test('the stacked root element itself carries both hops', () => {
    expect(resolver.identify(byId('hero-section'))).toEqual({ chain: ['0,0', '0'], path: '0', item: '' });
  });

  test('component internals chain through their instance', () => {
    expect(resolver.identify(byId('nav-link'))).toEqual({ chain: ['0'], path: '0,1,0', item: '' });
    expect(resolver.identify(byId('card0-span'))).toEqual({ chain: ['0,1', '0,0,2'], path: '0,0', item: '0' });
  });

  test('list copies report their occurrence as the item path', () => {
    expect(resolver.identify(byId('card2'))!.item).toBe('2');
    expect(resolver.identify(byId('card2-span'))).toEqual({ chain: ['0,1', '0,0,2'], path: '0,0', item: '2' });
    expect(resolver.identify(byId('feat1'))).toEqual({ chain: [], path: '0,2,0', item: '1' });
  });

  test('nested lists compose dot-joined item paths (outer.inner)', () => {
    expect(resolver.identify(byId('feat0-inner1'))).toEqual({ chain: [], path: '0,2,0,1,0', item: '0.1' });
    expect(resolver.identify(byId('feat1-inner0'))).toEqual({ chain: [], path: '0,2,0,1,0', item: '1.0' });
  });

  test('same-path elements that differ in instance identity are NOT copies', () => {
    // hero-section and slider-section share path "0" and slot "0;" but carry
    // different instance values — no item index for either.
    expect(resolver.identify(byId('slider-section'))!.item).toBe('');
  });
});

describe('resolveTarget (draw side) — identify()’s inverse', () => {
  test('component target resolves to the stacked root (regression: was null)', () => {
    // Drilled into Slider, Card selected: chain from navigationHistory.
    // No item → first copy (pre-list behavior).
    const el = resolver.resolveTarget({ chain: ['0,1'], path: '0,0,2', isComponent: true });
    expect(el?.id).toBe('card0');
  });

  test('component target with an item path borders THAT copy (the user ask)', () => {
    expect(resolver.resolveTarget({ chain: ['0,1'], path: '0,0,2', isComponent: true, item: '1' })?.id).toBe('card1');
    expect(resolver.resolveTarget({ chain: ['0,1'], path: '0,0,2', isComponent: true, item: '2' })?.id).toBe('card2');
  });

  test('component target ignores a descendant list item path — borders the instance, not a child (ControlSection/LEVEL-01 regression)', () => {
    // Hovering a list child of an UN-ENTERED component (Slider's Card copies —
    // the analog of ControlSection's per-card "LEVEL 0x" instances) collapses
    // the hover to the Slider instance but carries the child's leaked item path.
    // The border must land on the Slider wrapper, never an inner Card copy.
    for (const item of ['0', '1', '2']) {
      expect(resolver.resolveTarget({ chain: [], path: '0,1', isComponent: true, item })?.id).toBe('slider-section');
    }
    // And with no leaked item it must still resolve to the wrapper (unchanged).
    expect(resolver.resolveTarget({ chain: [], path: '0,1', isComponent: true })?.id).toBe('slider-section');
  });

  test('page-level section instances resolve to their wrapper element', () => {
    expect(resolver.resolveTarget({ chain: [], path: '0,0', isComponent: true })?.id).toBe('hero-section');
    expect(resolver.resolveTarget({ chain: [], path: '0,1', isComponent: true })?.id).toBe('slider-section');
  });

  test('plain paths disambiguate across files (regression: wrong-element border)', () => {
    // "0,0" exists as the hero h1 (page... Hero-file) AND the Card-internal
    // spans. The chain decides; no document-order fallback may cross files.
    expect(resolver.resolveTarget({ chain: ['0,0'], path: '0,0', isComponent: false })?.id).toBe('hero-h1');
    expect(resolver.resolveTarget({ chain: ['0,1', '0,0,2'], path: '0,0', isComponent: false, item: '1' })?.id).toBe(
      'card1-span',
    );
  });

  test('nested-list item paths pick the exact inner copy', () => {
    expect(resolver.resolveTarget({ chain: [], path: '0,2,0,1,0', isComponent: false, item: '1.1' })?.id).toBe(
      'feat1-inner1',
    );
  });

  test('lenient prefix match: an outer container matches a deeper item path (SSR parity)', () => {
    // Selection captured "1.0" from an inner-list descendant; the bordered
    // container (outer li) only carries level "1" — prefix match wins.
    expect(resolver.resolveTarget({ chain: [], path: '0,2,0', isComponent: false, item: '1.0' })?.id).toBe('feat1');
  });

  test('returns null rather than a wrong element/copy when nothing matches', () => {
    expect(resolver.resolveTarget({ chain: [], path: '9,9', isComponent: false })).toBeNull();
    expect(resolver.resolveTarget({ chain: ['0,0'], path: 'not-a-path', isComponent: false })).toBeNull();
    // Item path beyond the rendered copies: hidden, never the wrong copy.
    expect(resolver.resolveTarget({ chain: [], path: '0,2,0', isComponent: false, item: '9' })).toBeNull();
  });

  test('round-trip: identify(resolveTarget(identity)) is stable for every stamped element', () => {
    const els = Array.from(doc.querySelectorAll('[data-element-path]'));
    for (const el of els) {
      const id = resolver.identify(el);
      expect(id).not.toBeNull();
      const back = resolver.resolveTarget({
        chain: id!.chain,
        path: id!.path,
        isComponent: false,
        item: id!.item,
      });
      const reId = resolver.identify(back);
      expect(reId).toEqual(id);
    }
  });
});
