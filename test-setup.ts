// DOM globals for client-side tests (happy-dom), loaded via bunfig.toml preload.
// Mirrors the monorepo's packages/core/lib/test-utils/dom-setup.ts.
import { Window } from 'happy-dom';

const window = new Window({ url: 'http://localhost:3000', width: 1920, height: 1080 });
// happy-dom >=20.9 references window.SyntaxError from its selector parser but never
// defines it, so every querySelector throws — mirror real browsers and expose it.
(window as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;

const g = globalThis as any;
g.window = window;
g.document = window.document;
for (const k of [
  'HTMLElement', 'HTMLDivElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLAnchorElement',
  'HTMLSpanElement', 'HTMLFormElement', 'Element', 'Node', 'Text', 'DocumentFragment',
  'KeyboardEvent', 'MouseEvent', 'CustomEvent', 'MessageEvent', 'Event',
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver',
]) {
  g[k] = (window as any)[k];
}
g.getComputedStyle = window.getComputedStyle.bind(window);
g.requestAnimationFrame = window.requestAnimationFrame.bind(window);
g.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
