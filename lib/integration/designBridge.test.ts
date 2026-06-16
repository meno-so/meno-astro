import { describe, test, expect } from 'bun:test';
import { PLAY_DESIGN_BRIDGE_SCRIPT, PLAY_DESIGN_MODE_MESSAGE_TYPE } from './designBridge';

// The bridge ships as an injected head-script string. These assertions pin the
// viewport-pinning contract (the twin of studio MessageHandlers ENTER/EXIT_
// DESIGN_MODE) so a refactor can't silently drop it and reopen the design-mode
// height runaway.
describe('PLAY_DESIGN_BRIDGE_SCRIPT — viewport pinning', () => {
  test('listens for the design-mode toggle message', () => {
    expect(PLAY_DESIGN_BRIDGE_SCRIPT).toContain(PLAY_DESIGN_MODE_MESSAGE_TYPE);
  });

  test('reads the design viewport (vh/vw) carried with the toggle', () => {
    expect(PLAY_DESIGN_BRIDGE_SCRIPT).toContain('pinViewport(d.vh, d.vw)');
  });

  test('sets every --design-* vh and vw variant', () => {
    for (const v of [
      '--design-vh',
      '--design-svh',
      '--design-lvh',
      '--design-dvh',
      '--design-vw',
      '--design-svw',
      '--design-lvw',
      '--design-dvw',
    ]) {
      expect(PLAY_DESIGN_BRIDGE_SCRIPT).toContain(v);
    }
    expect(PLAY_DESIGN_BRIDGE_SCRIPT).toContain('setProperty');
  });

  test('pins on activate and clears on deactivate', () => {
    expect(PLAY_DESIGN_BRIDGE_SCRIPT).toContain('clearViewport()');
    expect(PLAY_DESIGN_BRIDGE_SCRIPT).toContain('removeProperty');
    // Pins to px derived from the sent viewport (value / 100 per CSS unit).
    expect(PLAY_DESIGN_BRIDGE_SCRIPT).toContain("(vh / 100) + 'px'");
    expect(PLAY_DESIGN_BRIDGE_SCRIPT).toContain("(vw / 100) + 'px'");
  });
});
