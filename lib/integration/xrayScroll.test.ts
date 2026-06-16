/**
 * Unit tests for the bridge's in-page scroll helper (XRAY_SCROLL_JS) —
 * evaluated as real JS against stub `window` + `document`, exactly how the
 * injected script runs it in the play page. Unlike core's same-origin
 * scrollDocumentToElement ('nearest'), the play helper top-aligns the node with
 * a small gap below the viewport top (or below a stuck sticky/fixed header), a
 * deterministic landing that sidesteps the real-astro layout drift. It still
 * skips entirely when the node is already comfortably in view.
 */

import { describe, test, expect } from 'bun:test';
import { XRAY_SCROLL_JS } from './xray';

const GAP = 24; // SCROLL_TOP_GAP in XRAY_SCROLL_JS

interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** A fake element: a rect plus an optional computed `position` for the header probe. */
interface FakeEl {
  getBoundingClientRect: () => Rect;
  __pos?: string;
}

interface WindowStub {
  innerHeight: number;
  innerWidth: number;
  scrollX: number;
  scrollY: number;
  scrollTo: (opts: { left: number; top: number; behavior: string }) => void;
  getComputedStyle: (el: FakeEl) => { position: string };
}

interface DocumentStub {
  elementsFromPoint: (x: number, y: number) => FakeEl[];
}

/**
 * Build scrollWindowToElement bound to stub window + document, plus a calls log.
 * `headerEls` (if any) are returned by every elementsFromPoint hit-test, so the
 * stuck-header probe sees them.
 */
function makeScroller(win: Partial<WindowStub>, headerEls: FakeEl[] = []) {
  const calls: Array<{ left: number; top: number; behavior: string }> = [];
  const windowStub: WindowStub = {
    innerHeight: 800,
    innerWidth: 1000,
    scrollX: 0,
    scrollY: 0,
    scrollTo: (opts) => calls.push(opts),
    getComputedStyle: (el) => ({ position: el.__pos ?? 'static' }),
    ...win,
  };
  const documentStub: DocumentStub = {
    elementsFromPoint: () => headerEls,
  };
  const scroll = new Function('window', 'document', `${XRAY_SCROLL_JS}; return scrollWindowToElement;`)(
    windowStub,
    documentStub,
  ) as (el: FakeEl) => void;
  const elAt = (rect: Rect) => ({ getBoundingClientRect: () => rect });
  return { scroll, elAt, calls };
}

describe('scrollWindowToElement (play-iframe scroll: top with a small gap)', () => {
  test('element below the fold top-aligns with the gap (rect.top - GAP)', () => {
    const { scroll, elAt, calls } = makeScroller({ innerHeight: 800, scrollY: 0 });
    scroll(elAt({ top: 1000, bottom: 1200, left: 0, right: 100 }));
    expect(calls).toHaveLength(1);
    expect(calls[0].top).toBe(1000 - GAP); // 0 + 1000 - 24
    expect(calls[0].behavior).toBe('smooth');
  });

  test('element above the inset scrolls up to top - GAP (respects current scrollY)', () => {
    const { scroll, elAt, calls } = makeScroller({ innerHeight: 800, scrollY: 500 });
    scroll(elAt({ top: -100, bottom: 100, left: 0, right: 100 }));
    expect(calls[0].top).toBe(500 - 100 - GAP); // 376
  });

  test('element already comfortably in view does not move the window', () => {
    const { scroll, elAt, calls } = makeScroller({ innerHeight: 800, scrollY: 50 });
    // top (100) >= GAP and bottom (300) <= viewH (800) → no scroll.
    scroll(elAt({ top: 100, bottom: 300, left: 10, right: 200 }));
    expect(calls).toHaveLength(0);
  });

  test('element taller than the viewport still scrolls to show its top below the inset', () => {
    const { scroll, elAt, calls } = makeScroller({ innerHeight: 800, scrollY: 0 });
    // bottom (1500) > viewH (800), so even with top (40) >= GAP it scrolls.
    scroll(elAt({ top: 40, bottom: 1500, left: 0, right: 100 }));
    expect(calls[0].top).toBe(40 - GAP); // 16
  });

  test('target never goes negative (clamped to 0)', () => {
    const { scroll, elAt, calls } = makeScroller({ innerHeight: 800, scrollY: 0 });
    scroll(elAt({ top: -1000, bottom: -800, left: 0, right: 100 }));
    expect(calls[0].top).toBe(0); // 0 + (-1000) - 24 = -1024 → clamped
  });

  test('a stuck sticky header pushes the landing below it (inset = header bottom + GAP)', () => {
    const header: FakeEl = {
      __pos: 'sticky',
      getBoundingClientRect: () => ({ top: 0, bottom: 60, left: 0, right: 1000 }),
    };
    const { scroll, elAt, calls } = makeScroller({ innerHeight: 800, scrollY: 0 }, [header]);
    scroll(elAt({ top: 1000, bottom: 1200, left: 0, right: 100 }));
    // inset = 60 + 24 = 84 → targetY = 0 + 1000 - 84
    expect(calls[0].top).toBe(1000 - (60 + GAP));
  });

  test('a non-sticky element at the top is ignored by the header probe', () => {
    const banner: FakeEl = {
      __pos: 'static',
      getBoundingClientRect: () => ({ top: 0, bottom: 60, left: 0, right: 1000 }),
    };
    const { scroll, elAt, calls } = makeScroller({ innerHeight: 800, scrollY: 0 }, [banner]);
    scroll(elAt({ top: 1000, bottom: 1200, left: 0, right: 100 }));
    expect(calls[0].top).toBe(1000 - GAP); // inset falls back to just GAP
  });
});
