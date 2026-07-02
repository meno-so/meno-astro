/**
 * Unit tests for the bridge's in-page spacing-ruler math (RULER_SPACING_JS) —
 * evaluated as real JS against stub `window` + fake elements, exactly how the
 * injected script runs it in the play page. This is the cross-origin twin of
 * studio's RulerOverlay: given the resolved selected element it returns the
 * margin (amber), padding (green) and flex/grid gap (purple) boxes to draw,
 * in viewport coordinates (getBoundingClientRect space).
 */

import { describe, test, expect } from 'bun:test';
import { RULER_SPACING_JS } from './xray';

const MARGIN = 'rgba(251, 191, 36, 0.3)';
const PADDING = 'rgba(34, 197, 94, 0.35)';
const GAP = 'rgba(168, 85, 247, 0.25)';

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

interface FakeEl {
  __style: Record<string, string>;
  getBoundingClientRect: () => Rect;
  children: FakeEl[];
}

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
  color: string;
  value: number;
}

/** A DOMRect-shaped literal (right/bottom derived) the gap math reads. */
function rect(top: number, left: number, width: number, height: number): Rect {
  return { top, left, width, height, right: left + width, bottom: top + height };
}

function el(style: Record<string, string>, r: Rect, children: FakeEl[] = []): FakeEl {
  return { __style: style, getBoundingClientRect: () => r, children };
}

/** Build rulerBuildBoxes bound to a stub window whose getComputedStyle reads `__style`. */
function makeRuler() {
  const windowStub = {
    getComputedStyle: (e: FakeEl) => e.__style,
  };
  const fns = new Function('window', `${RULER_SPACING_JS}; return { rulerBuildBoxes: rulerBuildBoxes };`)(
    windowStub,
  ) as { rulerBuildBoxes: (e: FakeEl) => Box[] };
  return fns.rulerBuildBoxes;
}

/** Empty computed style — every band 0 / display block, so no margin/padding/gap. */
const BLANK: Record<string, string> = { display: 'block' };

describe('rulerBuildBoxes — margin + padding', () => {
  test('uniform margin (10) + padding (20) produces 8 correctly-placed boxes', () => {
    const build = makeRuler();
    const style = {
      display: 'block',
      marginTop: '10px',
      marginRight: '10px',
      marginBottom: '10px',
      marginLeft: '10px',
      paddingTop: '20px',
      paddingRight: '20px',
      paddingBottom: '20px',
      paddingLeft: '20px',
    };
    const boxes = build(el(style, rect(100, 50, 200, 100)));
    // 4 margin + 4 padding, no gaps.
    expect(boxes).toHaveLength(8);

    const margins = boxes.filter((b) => b.color === MARGIN);
    const paddings = boxes.filter((b) => b.color === PADDING);
    expect(margins).toHaveLength(4);
    expect(paddings).toHaveLength(4);

    // margin-top: above the element, full width.
    expect(margins).toContainEqual({ top: 90, left: 50, width: 200, height: 10, color: MARGIN, value: 10 });
    // margin-bottom: below the element.
    expect(margins).toContainEqual({ top: 200, left: 50, width: 200, height: 10, color: MARGIN, value: 10 });
    // margin-left: full height incl. top+bottom margins.
    expect(margins).toContainEqual({ top: 90, left: 40, width: 10, height: 120, color: MARGIN, value: 10 });
    // margin-right.
    expect(margins).toContainEqual({ top: 90, left: 250, width: 10, height: 120, color: MARGIN, value: 10 });

    // padding-top: inside the top edge.
    expect(paddings).toContainEqual({ top: 100, left: 50, width: 200, height: 20, color: PADDING, value: 20 });
    // padding-bottom.
    expect(paddings).toContainEqual({ top: 180, left: 50, width: 200, height: 20, color: PADDING, value: 20 });
    // padding-left: inset by top/bottom padding.
    expect(paddings).toContainEqual({ top: 120, left: 50, width: 20, height: 60, color: PADDING, value: 20 });
    // padding-right.
    expect(paddings).toContainEqual({ top: 120, left: 230, width: 20, height: 60, color: PADDING, value: 20 });
  });

  test('zero-value bands are dropped', () => {
    const build = makeRuler();
    const style = {
      display: 'block',
      marginTop: '12px',
      marginRight: '0px',
      marginBottom: '0px',
      marginLeft: '0px',
      paddingTop: '0px',
      paddingRight: '0px',
      paddingBottom: '0px',
      paddingLeft: '0px',
    };
    const boxes = build(el(style, rect(0, 0, 100, 100)));
    // Only margin-top survives.
    expect(boxes).toEqual([{ top: -12, left: 0, width: 100, height: 12, color: MARGIN, value: 12 }]);
  });

  test('collapsed (0x0) element yields no boxes', () => {
    const build = makeRuler();
    const boxes = build(el({ ...BLANK, marginTop: '10px' }, rect(0, 0, 0, 0)));
    expect(boxes).toEqual([]);
  });
});

describe('rulerBuildBoxes — flex/grid gaps', () => {
  test('flex row with columnGap draws one purple gap between the two children', () => {
    const build = makeRuler();
    const containerStyle = {
      display: 'flex',
      flexDirection: 'row',
      flexWrap: 'nowrap',
      columnGap: '24px',
      rowGap: '0px',
    };
    const childStyle = { display: 'block', visibility: 'visible' };
    const a = el(childStyle, rect(0, 0, 100, 50));
    const b = el(childStyle, rect(0, 124, 100, 50));
    const boxes = build(el(containerStyle, rect(0, 0, 224, 50), [a, b]));
    const gaps = boxes.filter((box) => box.color === GAP);
    expect(gaps).toEqual([{ top: 0, left: 100, width: 24, height: 50, color: GAP, value: 24 }]);
  });

  test('grid with rowGap draws one purple gap between stacked children', () => {
    const build = makeRuler();
    const containerStyle = { display: 'grid', rowGap: '16px', columnGap: '0px' };
    const childStyle = { display: 'block', visibility: 'visible' };
    const a = el(childStyle, rect(0, 0, 100, 50));
    const b = el(childStyle, rect(66, 0, 100, 50));
    const boxes = build(el(containerStyle, rect(0, 0, 100, 116), [a, b]));
    const gaps = boxes.filter((box) => box.color === GAP);
    expect(gaps).toEqual([{ top: 50, left: 0, width: 100, height: 16, color: GAP, value: 16 }]);
  });

  test('hidden children are excluded from gap computation (fewer than 2 visible → no gaps)', () => {
    const build = makeRuler();
    const containerStyle = {
      display: 'flex',
      flexDirection: 'row',
      flexWrap: 'nowrap',
      columnGap: '24px',
      rowGap: '0px',
    };
    const a = el({ display: 'block', visibility: 'visible' }, rect(0, 0, 100, 50));
    const b = el({ display: 'none', visibility: 'visible' }, rect(0, 124, 100, 50));
    const boxes = build(el(containerStyle, rect(0, 0, 224, 50), [a, b]));
    expect(boxes.filter((box) => box.color === GAP)).toEqual([]);
  });

  test('non-flex/grid container reports no gaps even with gap values set', () => {
    const build = makeRuler();
    const containerStyle = { display: 'block', columnGap: '24px', rowGap: '24px' };
    const child = el({ display: 'block', visibility: 'visible' }, rect(0, 0, 100, 50));
    const boxes = build(el(containerStyle, rect(0, 0, 100, 200), [child, child]));
    expect(boxes.filter((box) => box.color === GAP)).toEqual([]);
  });
});
