import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import meno, {
  toAstroI18nOptions,
  LOCALE_MIDDLEWARE_ENTRYPOINT,
  LOCALE_ROUTE_PATTERN,
  LOCALE_ROUTE_ENTRYPOINT,
  MENO_ASSET_DIRS,
  MENO_PLAY_ENV,
  PLAY_NAVIGATE_MESSAGE_TYPE,
  PLAY_NAVIGATION_BRIDGE_SCRIPT,
  PLAY_MARKER_HEADER,
  assetDirForPath,
  resolveAssetFile,
  copyAssetDirsToOutput,
  collectUtilitySources,
  frameworkFsAllow,
  adapterFactoryOptions,
  UTILITY_CSS_MODULE,
  type MenoIntegration,
} from './index';

// `meno()` returns an array — the meno-astro integration plus any installed island-
// framework renderers (Astro flattens it). These tests exercise the meno-astro
// integration itself, so pull it out by name (typed so hook params keep inferring).
const menoBase = (): MenoIntegration => (meno() as unknown as MenoIntegration[]).find((i) => i.name === 'meno-astro')!;
import {
  PLAY_XRAY_BRIDGE_SCRIPT,
  PLAY_COMMENT_MODE_MESSAGE_TYPE,
  PLAY_COMMENT_RECTS_MESSAGE_TYPE,
  PLAY_COMMENT_PLACE_MESSAGE_TYPE,
} from './xray';
import { PLAY_PATCH_BRIDGE_SCRIPT } from './playPatch';
import {
  PLAY_DESIGN_BRIDGE_SCRIPT,
  PLAY_DESIGN_MODE_MESSAGE_TYPE,
  PLAY_HEIGHT_MESSAGE_TYPE,
  PLAY_WHEEL_MESSAGE_TYPE,
  PLAY_PAN_MESSAGE_TYPE,
  PLAY_SPACE_MESSAGE_TYPE,
} from './designBridge';
import type { I18nConfig } from 'meno-core/shared';
import { emit } from '../dialect';

const tmps: string[] = [];
afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

const cfg: I18nConfig = {
  defaultLocale: 'en',
  locales: [
    { code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' },
    { code: 'pl', name: 'Polish', nativeName: 'Polski', langTag: 'pl-PL' },
  ],
};

describe('toAstroI18nOptions (pure mapping)', () => {
  test('maps defaultLocale + locale codes, default routing un-prefixed', () => {
    expect(toAstroI18nOptions(cfg)).toEqual({
      defaultLocale: 'en',
      locales: ['en', 'pl'],
      routing: { prefixDefaultLocale: false },
    });
  });

  test('de-duplicates locale codes', () => {
    const dupes: I18nConfig = {
      defaultLocale: 'en',
      locales: [
        { code: 'en', name: 'E', nativeName: 'E', langTag: 'en-US' },
        { code: 'pl', name: 'P', nativeName: 'P', langTag: 'pl-PL' },
        { code: 'pl', name: 'P2', nativeName: 'P2', langTag: 'pl-PL' },
      ],
    };
    expect(toAstroI18nOptions(dupes).locales).toEqual(['en', 'pl']);
  });

  test('ensures defaultLocale is present in locales even if omitted from the list', () => {
    const missing: I18nConfig = {
      defaultLocale: 'en',
      locales: [{ code: 'pl', name: 'P', nativeName: 'P', langTag: 'pl-PL' }],
    };
    expect(toAstroI18nOptions(missing).locales).toEqual(['en', 'pl']);
    expect(toAstroI18nOptions(missing).defaultLocale).toBe('en');
  });

  test('single default locale -> single-entry list', () => {
    const single: I18nConfig = {
      defaultLocale: 'en',
      locales: [{ code: 'en', name: 'E', nativeName: 'E', langTag: 'en-US' }],
    };
    expect(toAstroI18nOptions(single)).toEqual({
      defaultLocale: 'en',
      locales: ['en'],
      routing: { prefixDefaultLocale: false },
    });
  });
});

describe('meno() integration', () => {
  function projectRootWith(i18n: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'meno-integ-'));
    tmps.push(dir);
    writeFileSync(join(dir, 'project.config.json'), JSON.stringify({ i18n }), 'utf8');
    return dir;
  }

  /** A project root whose project.config.json is the given full object (for the Astro-config extras). */
  function projectRootWithConfig(config: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'meno-integ-'));
    tmps.push(dir);
    writeFileSync(join(dir, 'project.config.json'), JSON.stringify(config), 'utf8');
    return dir;
  }

  /** Run config:setup for `command`/play and return the single updateConfig payload. */
  function runConfigSetup(root: string, command: 'dev' | 'build', play: boolean): Record<string, unknown> {
    const updates: Record<string, unknown>[] = [];
    const prev = process.env[MENO_PLAY_ENV];
    if (play) process.env[MENO_PLAY_ENV] = '1';
    else delete process.env[MENO_PLAY_ENV];
    try {
      menoBase().hooks['astro:config:setup']({
        config: { root: pathToFileURL(`${root}/`) },
        command,
        updateConfig: (c) => updates.push(c),
        addMiddleware: () => {},
        injectScript: () => {},
        addWatchFile: () => {},
      });
    } finally {
      if (prev === undefined) delete process.env[MENO_PLAY_ENV];
      else process.env[MENO_PLAY_ENV] = prev;
    }
    return updates[0]!;
  }

  test('shape: name + config:setup and build:done hooks', () => {
    const integ = menoBase();
    expect(integ.name).toBe('meno-astro');
    expect(typeof integ.hooks['astro:config:setup']).toBe('function');
    expect(typeof integ.hooks['astro:build:done']).toBe('function');
  });

  test('astro:config:setup maps i18n via updateConfig and injects the middleware', () => {
    const root = projectRootWith({
      defaultLocale: 'en',
      locales: [
        { code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' },
        { code: 'pl', name: 'Polish', nativeName: 'Polski', langTag: 'pl-PL' },
      ],
    });

    const updates: Record<string, unknown>[] = [];
    const middlewares: { entrypoint: string | URL; order: 'pre' | 'post' }[] = [];
    menoBase().hooks['astro:config:setup']({
      config: { root: pathToFileURL(`${root}/`) },
      updateConfig: (c) => updates.push(c),
      addMiddleware: (m) => middlewares.push(m),
    });

    // (a) i18n routing config mapped from project.config.json + the registered vite plugins.
    expect(updates).toHaveLength(1);
    expect((updates[0] as any).i18n).toEqual({
      defaultLocale: 'en',
      locales: ['en', 'pl'],
      routing: { prefixDefaultLocale: false },
    });
    const pluginNames = (updates[0] as any).vite.plugins.map((p: any) => p.name);
    expect(pluginNames).toEqual(['meno-astro:utility-css', 'meno-astro:static-assets']);

    // meno-astro ships .astro components — it must stay out of Vite's dep
    // pre-bundle (plain esbuild can't parse .astro) and be SSR-noExternal.
    expect((updates[0] as any).vite.optimizeDeps).toEqual({ exclude: ['meno-astro'] });
    expect((updates[0] as any).vite.ssr).toEqual({ noExternal: ['meno-astro'] });

    // Island hydration chunks live in the play runtime's HOISTED workspace node_modules
    // (outside the Vite root) — fs.allow must widen to reach them or `/@fs/…` 403s. The
    // Vite root (project copy) is always present so the allow-list is never empty.
    // (The resolved root carries a trailing slash from the file:// URL round-trip.)
    const fsAllow = (updates[0] as any).vite.server.fs.allow as string[];
    expect(Array.isArray(fsAllow)).toBe(true);
    expect(fsAllow.some((p) => p.replace(/[\\/]$/, '') === root)).toBe(true);

    // (b) locale middleware injected, ordered before user middleware.
    expect(middlewares).toEqual([{ entrypoint: LOCALE_MIDDLEWARE_ENTRYPOINT, order: 'pre' }]);
  });

  test('multi-locale project: injects the /[locale]/[...path] locale route (prerendered)', () => {
    const root = projectRootWith({
      defaultLocale: 'en',
      locales: [
        { code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' },
        { code: 'pl', name: 'Polish', nativeName: 'Polski', langTag: 'pl-PL' },
      ],
    });

    const routes: { pattern: string; entrypoint: string | URL; prerender?: boolean }[] = [];
    menoBase().hooks['astro:config:setup']({
      config: { root: pathToFileURL(`${root}/`) },
      updateConfig: () => {},
      addMiddleware: () => {},
      injectRoute: (r) => routes.push(r),
    });

    expect(routes).toEqual([{ pattern: LOCALE_ROUTE_PATTERN, entrypoint: LOCALE_ROUTE_ENTRYPOINT, prerender: true }]);
  });

  test('output: static by default — no `output` forced into the Astro config', () => {
    // meno() resolves the adapter from cwd (the repo, which has no SSR config), so the
    // common case never sets output — Astro keeps its static default.
    const root = projectRootWith({
      defaultLocale: 'en',
      locales: [{ code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' }],
    });
    const payload = runConfigSetup(root, 'build', false);
    expect(payload.output).toBeUndefined();
  });

  test('SSR adapter not installed → graceful static fallback (output stays unset)', () => {
    // A project asking for output: 'server' with an adapter that isn't in the runtime store
    // must NOT force output: 'server' (that would hard-fail the build). Since this test env
    // has no @astrojs/* adapter installed, loadAdapterIntegration returns null and output is
    // never set — proving the fallback path.
    const root = projectRootWithConfig({
      i18n: {
        defaultLocale: 'en',
        locales: [{ code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' }],
      },
      output: 'server',
      adapter: { name: 'node' },
    });
    const payload = runConfigSetup(root, 'build', false);
    expect(payload.output).toBeUndefined();
    // And meno() never appended a broken adapter integration.
    const names = (meno() as unknown as { name: string }[]).map((i) => i.name);
    expect(names).toContain('meno-astro');
  });

  test('single-locale project: locale route NOT injected (zero-cost no-op)', () => {
    const root = projectRootWith({
      defaultLocale: 'en',
      locales: [{ code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' }],
    });

    const routes: unknown[] = [];
    menoBase().hooks['astro:config:setup']({
      config: { root: pathToFileURL(`${root}/`) },
      updateConfig: () => {},
      addMiddleware: () => {},
      injectRoute: (r) => routes.push(r),
    });

    expect(routes).toEqual([]);
  });

  test('watches project.config.json so config edits restart astro dev (locale adds go live)', () => {
    // The i18n routing options, `site`, and WHETHER the locale route is injected are
    // all frozen at config:setup time. addWatchFile makes a config save re-run the
    // hook — without it, adding a locale in the editor 404s until a manual restart.
    const root = projectRootWith({
      defaultLocale: 'en',
      locales: [{ code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' }],
    });

    const watched: (string | URL)[] = [];
    menoBase().hooks['astro:config:setup']({
      config: { root: pathToFileURL(`${root}/`) },
      updateConfig: () => {},
      addMiddleware: () => {},
      addWatchFile: (p) => watched.push(p),
    });

    expect(watched).toEqual([join(root, 'project.config.json')]);
  });

  test('play mode does NOT watch project.config.json (settings saves must not restart the play server)', () => {
    // A config watch-file turns every editor settings save into a full dev-server
    // restart, which drops the play iframe's HMR socket and blanks the preview.
    // Play keeps an always-on server instead — frozen config applies on re-toggle.
    const root = projectRootWith({
      defaultLocale: 'en',
      locales: [{ code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' }],
    });
    const watched: (string | URL)[] = [];
    const prev = process.env[MENO_PLAY_ENV];
    process.env[MENO_PLAY_ENV] = '1';
    try {
      menoBase().hooks['astro:config:setup']({
        config: { root: pathToFileURL(`${root}/`) },
        command: 'dev',
        updateConfig: () => {},
        addMiddleware: () => {},
        injectScript: () => {},
        addWatchFile: (p) => watched.push(p),
      });
    } finally {
      if (prev === undefined) delete process.env[MENO_PLAY_ENV];
      else process.env[MENO_PLAY_ENV] = prev;
    }
    expect(watched).toEqual([]);
  });

  test('multi-locale without injectRoute (older Astro slice) degrades gracefully', () => {
    const root = projectRootWith({
      defaultLocale: 'en',
      locales: [
        { code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' },
        { code: 'pl', name: 'Polish', nativeName: 'Polski', langTag: 'pl-PL' },
      ],
    });

    expect(() =>
      menoBase().hooks['astro:config:setup']({
        config: { root: pathToFileURL(`${root}/`) },
        updateConfig: () => {},
        addMiddleware: () => {},
      }),
    ).not.toThrow();
  });

  test('play mode (MENO_PLAY=1): injects the navigation bridge as an inline head script', () => {
    const root = projectRootWith({ defaultLocale: 'en', locales: [] });
    const injected: { stage: string; content: string }[] = [];
    const prev = process.env[MENO_PLAY_ENV];
    process.env[MENO_PLAY_ENV] = '1';
    try {
      menoBase().hooks['astro:config:setup']({
        config: { root: pathToFileURL(`${root}/`) },
        updateConfig: () => {},
        addMiddleware: () => {},
        injectScript: (stage, content) => injected.push({ stage, content }),
      });
    } finally {
      if (prev === undefined) delete process.env[MENO_PLAY_ENV];
      else process.env[MENO_PLAY_ENV] = prev;
    }
    // `head-inline`: inlined verbatim into <head>, no module-graph participation —
    // the simplest correct delivery for dependency-free bridges (see the bridge
    // section in integration/index.ts). Play mode injects the navigation
    // bridge, the X-Ray bridge (lib/integration/xray.ts — which also owns
    // pinned-comment resolution) and the design bridge
    // (lib/integration/designBridge.ts).
    expect(injected).toEqual([
      { stage: 'head-inline', content: PLAY_NAVIGATION_BRIDGE_SCRIPT },
      { stage: 'head-inline', content: PLAY_XRAY_BRIDGE_SCRIPT },
      { stage: 'head-inline', content: PLAY_DESIGN_BRIDGE_SCRIPT },
    ]);
    // The bridge posts the editor-matched message type with the pathname.
    expect(PLAY_NAVIGATION_BRIDGE_SCRIPT).toContain(PLAY_NAVIGATE_MESSAGE_TYPE);
    expect(PLAY_NAVIGATION_BRIDGE_SCRIPT).toContain('postMessage');
    // Soft navigations under Astro's client router are covered too.
    expect(PLAY_NAVIGATION_BRIDGE_SCRIPT).toContain('astro:page-load');
  });

  test('design bridge script carries the full editor message contract', () => {
    // The studio matches these literals (it deliberately doesn't import from
    // meno-astro — the integration module is server-only): inbound design-mode
    // toggle, outbound height/wheel/pan/space. A drift here silently kills
    // design-mode zoom/pan and frame sizing over the play iframe.
    expect(PLAY_DESIGN_MODE_MESSAGE_TYPE).toBe('meno:astro:design-mode');
    expect(PLAY_HEIGHT_MESSAGE_TYPE).toBe('meno:astro:height');
    expect(PLAY_WHEEL_MESSAGE_TYPE).toBe('meno:astro:wheel');
    expect(PLAY_PAN_MESSAGE_TYPE).toBe('meno:astro:pan');
    expect(PLAY_SPACE_MESSAGE_TYPE).toBe('meno:astro:space');
    for (const type of [
      PLAY_DESIGN_MODE_MESSAGE_TYPE,
      PLAY_HEIGHT_MESSAGE_TYPE,
      PLAY_WHEEL_MESSAGE_TYPE,
      PLAY_PAN_MESSAGE_TYPE,
      PLAY_SPACE_MESSAGE_TYPE,
    ]) {
      expect(PLAY_DESIGN_BRIDGE_SCRIPT).toContain(`'${type}'`);
    }
    // Wheel capture must be non-passive so preventDefault stops in-frame
    // scrolling, and height reporting must survive soft navigations.
    expect(PLAY_DESIGN_BRIDGE_SCRIPT).toContain('preventDefault');
    expect(PLAY_DESIGN_BRIDGE_SCRIPT).toContain('passive: false');
    expect(PLAY_DESIGN_BRIDGE_SCRIPT).toContain('astro:page-load');
  });

  test('x-ray bridge carries the pinned-comment editor message contract', () => {
    // The studio matches these literals (see lib/client/utils/astroCommentTargets.ts
    // — it deliberately doesn't import from meno-astro). Drift here silently
    // breaks pin rendering / placement over the cross-origin play iframe.
    expect(PLAY_COMMENT_MODE_MESSAGE_TYPE).toBe('meno:astro:comment-mode');
    expect(PLAY_COMMENT_RECTS_MESSAGE_TYPE).toBe('meno:astro:comment-rects');
    expect(PLAY_COMMENT_PLACE_MESSAGE_TYPE).toBe('meno:astro:comment-place');
    for (const type of [
      PLAY_COMMENT_MODE_MESSAGE_TYPE,
      PLAY_COMMENT_RECTS_MESSAGE_TYPE,
      PLAY_COMMENT_PLACE_MESSAGE_TYPE,
    ]) {
      expect(PLAY_XRAY_BRIDGE_SCRIPT).toContain(`'${type}'`);
    }
    // Comments are ELEMENT-anchored: the bridge resolves each comment target via
    // resolveTarget and streams per-comment rects keyed by id (not a page box),
    // shows a crosshair while adding, captures the click without navigating, and
    // re-resolves across soft navigations.
    expect(PLAY_XRAY_BRIDGE_SCRIPT).toContain('commentTargets');
    expect(PLAY_XRAY_BRIDGE_SCRIPT).toContain('resolveTarget(t)');
    expect(PLAY_XRAY_BRIDGE_SCRIPT).toContain('id: t.id');
    expect(PLAY_XRAY_BRIDGE_SCRIPT).toContain('crosshair');
    expect(PLAY_XRAY_BRIDGE_SCRIPT).toContain('preventDefault');
    expect(PLAY_XRAY_BRIDGE_SCRIPT).toContain('astro:page-load');
  });

  test("play mode + command 'dev': patch bridge injected and patch plugin registered", () => {
    const root = projectRootWith({ defaultLocale: 'en', locales: [] });
    const injected: { stage: string; content: string }[] = [];
    const updates: Record<string, unknown>[] = [];
    const prev = process.env[MENO_PLAY_ENV];
    process.env[MENO_PLAY_ENV] = '1';
    try {
      menoBase().hooks['astro:config:setup']({
        config: { root: pathToFileURL(`${root}/`) },
        command: 'dev',
        updateConfig: (c) => updates.push(c),
        addMiddleware: () => {},
        injectScript: (stage, content) => injected.push({ stage, content }),
      });
    } finally {
      if (prev === undefined) delete process.env[MENO_PLAY_ENV];
      else process.env[MENO_PLAY_ENV] = prev;
    }
    // The patch bridge joins the other three play bridges (dev only).
    expect(injected).toHaveLength(4);
    expect(injected[3]).toEqual({ stage: 'head-inline', content: PLAY_PATCH_BRIDGE_SCRIPT });
    // The patch plugin is registered alongside the play plugins…
    const pluginNames = (updates[0] as any).vite.plugins.map((p: any) => p.name);
    expect(pluginNames).toContain('meno-astro:play-patch');
    // …and the utility-css plugin's own full reload is suppressed so it can't
    // defeat the patch (the patch plugin owns reload-vs-patch in play dev).
    const utility = (updates[0] as any).vite.plugins.find((p: any) => p.name === 'meno-astro:utility-css');
    const sends: unknown[] = [];
    const handlers: Record<string, (f: string) => void> = {};
    utility.configureServer({
      watcher: {
        on: (evt: string, cb: (f: string) => void) => {
          handlers[evt] = cb;
        },
      },
      moduleGraph: { getModuleById: () => null, invalidateModule: () => {} },
      ws: { send: (p: unknown) => sends.push(p) },
    });
    handlers.change!(join(root, 'src', 'pages', 'index.astro'));
    expect(sends).toEqual([]);
  });

  test("play mode WITHOUT command 'dev' (build/preview): no patch machinery", () => {
    const root = projectRootWith({ defaultLocale: 'en', locales: [] });
    const injected: { content: string }[] = [];
    const updates: Record<string, unknown>[] = [];
    const prev = process.env[MENO_PLAY_ENV];
    process.env[MENO_PLAY_ENV] = '1';
    try {
      menoBase().hooks['astro:config:setup']({
        config: { root: pathToFileURL(`${root}/`) },
        command: 'build',
        updateConfig: (c) => updates.push(c),
        addMiddleware: () => {},
        injectScript: (_stage, content) => injected.push({ content }),
      });
    } finally {
      if (prev === undefined) delete process.env[MENO_PLAY_ENV];
      else process.env[MENO_PLAY_ENV] = prev;
    }
    expect(injected).toHaveLength(3); // nav + xray + design only
    const pluginNames = (updates[0] as any).vite.plugins.map((p: any) => p.name);
    expect(pluginNames).not.toContain('meno-astro:play-patch');
  });

  test('non-play `astro dev`: utility-css plugin still full-reloads on .astro change', () => {
    const root = projectRootWith({ defaultLocale: 'en', locales: [] });
    const updates: Record<string, unknown>[] = [];
    const prev = process.env[MENO_PLAY_ENV];
    delete process.env[MENO_PLAY_ENV];
    try {
      menoBase().hooks['astro:config:setup']({
        config: { root: pathToFileURL(`${root}/`) },
        command: 'dev',
        updateConfig: (c) => updates.push(c),
        addMiddleware: () => {},
      });
    } finally {
      if (prev !== undefined) process.env[MENO_PLAY_ENV] = prev;
    }
    const utility = (updates[0] as any).vite.plugins.find((p: any) => p.name === 'meno-astro:utility-css');
    const sends: unknown[] = [];
    const handlers: Record<string, (f: string) => void> = {};
    utility.configureServer({
      watcher: {
        on: (evt: string, cb: (f: string) => void) => {
          handlers[evt] = cb;
        },
      },
      moduleGraph: { getModuleById: () => null, invalidateModule: () => {} },
      ws: { send: (p: unknown) => sends.push(p) },
    });
    handlers.change!(join(root, 'src', 'pages', 'index.astro'));
    expect(sends).toEqual([{ type: 'full-reload' }]);
  });

  test('without MENO_PLAY the bridge is NOT injected (deploy builds stay clean)', () => {
    const root = projectRootWith({ defaultLocale: 'en', locales: [] });
    const injected: unknown[] = [];
    const prev = process.env[MENO_PLAY_ENV];
    delete process.env[MENO_PLAY_ENV];
    try {
      menoBase().hooks['astro:config:setup']({
        config: { root: pathToFileURL(`${root}/`) },
        updateConfig: () => {},
        addMiddleware: () => {},
        injectScript: (...args) => injected.push(args),
      });
    } finally {
      if (prev !== undefined) process.env[MENO_PLAY_ENV] = prev;
    }
    expect(injected).toEqual([]);
  });

  test('config extras: non-play build applies the project devToolbar + prefetch settings', () => {
    const root = projectRootWithConfig({
      i18n: { defaultLocale: 'en', locales: [] },
      devToolbar: true,
      prefetch: { enabled: true, defaultStrategy: 'viewport' },
    });
    const update = runConfigSetup(root, 'build', false);
    expect(update.devToolbar).toEqual({ enabled: true });
    expect(update.prefetch).toEqual({ prefetchAll: true, defaultStrategy: 'viewport' });
  });

  test('config extras: play HONORS the devToolbar toggle (preview = the play iframe) but drops prefetch', () => {
    // The toolbar toggle is "show while previewing", so an enabled project shows it in play.
    // prefetchAll only floods the single play dev server, so it's dropped. image still applies.
    const root = projectRootWithConfig({
      i18n: { defaultLocale: 'en', locales: [] },
      devToolbar: true,
      prefetch: { enabled: true, defaultStrategy: 'viewport' },
      image: { domains: ['images.example.com'] },
    });
    const update = runConfigSetup(root, 'dev', true);
    expect(update.devToolbar).toEqual({ enabled: true });
    expect(update.prefetch).toBeUndefined();
    expect(update.image).toEqual({ domains: ['images.example.com'] });
  });

  test('config extras: toolbar stays OFF by default (overrides Astro dev default-on) when unset', () => {
    // No devToolbar key → explicit { enabled: false } so the toolbar never shows uninvited,
    // in play and standalone dev alike (Astro would otherwise default it ON in dev).
    const playUnset = runConfigSetup(projectRootWith({ defaultLocale: 'en', locales: [] }), 'dev', true);
    expect(playUnset.devToolbar).toEqual({ enabled: false });
    const devUnset = runConfigSetup(projectRootWith({ defaultLocale: 'en', locales: [] }), 'dev', false);
    expect(devUnset.devToolbar).toEqual({ enabled: false });
  });

  test('play mode (MENO_PLAY=1): registers the play-marker plugin that stamps every response', () => {
    const root = projectRootWith({ defaultLocale: 'en', locales: [] });
    const updates: Record<string, unknown>[] = [];
    const prev = process.env[MENO_PLAY_ENV];
    process.env[MENO_PLAY_ENV] = '1';
    try {
      menoBase().hooks['astro:config:setup']({
        config: { root: pathToFileURL(`${root}/`) },
        updateConfig: (c) => updates.push(c),
        addMiddleware: () => {},
        injectScript: () => {},
      });
    } finally {
      if (prev === undefined) delete process.env[MENO_PLAY_ENV];
      else process.env[MENO_PLAY_ENV] = prev;
    }

    const plugins = (updates[0] as any).vite.plugins;
    const marker = plugins.find((p: any) => p.name === 'meno-astro:play-marker');
    expect(marker).toBeDefined();

    // The dev-server middleware stamps PLAY_MARKER_HEADER on every response —
    // the Electron shell keys its CSP exemption on this header (it would
    // otherwise stamp a fail-closed CSP that blocks the page's inline
    // `define:vars` component scripts).
    const handlers: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    marker.configureServer({ middlewares: { use: (fn: any) => handlers.push(fn) } });
    expect(handlers).toHaveLength(1);

    const headers: Record<string, string> = {};
    let nextCalled = false;
    handlers[0]!(
      {},
      {
        setHeader: (name: string, value: string) => {
          headers[name] = value;
        },
      },
      () => {
        nextCalled = true;
      },
    );
    expect(headers).toEqual({ [PLAY_MARKER_HEADER]: '1' });
    expect(nextCalled).toBe(true);

    // The preview-server hook mirrors the dev one (best-effort coverage).
    const previewHandlers: unknown[] = [];
    marker.configurePreviewServer({ middlewares: { use: (fn: any) => previewHandlers.push(fn) } });
    expect(previewHandlers).toHaveLength(1);
  });

  test('without MENO_PLAY the play-marker plugin is NOT registered (deploy builds stay unmarked)', () => {
    const root = projectRootWith({ defaultLocale: 'en', locales: [] });
    const updates: Record<string, unknown>[] = [];
    const prev = process.env[MENO_PLAY_ENV];
    delete process.env[MENO_PLAY_ENV];
    try {
      menoBase().hooks['astro:config:setup']({
        config: { root: pathToFileURL(`${root}/`) },
        updateConfig: (c) => updates.push(c),
        addMiddleware: () => {},
      });
    } finally {
      if (prev !== undefined) process.env[MENO_PLAY_ENV] = prev;
    }
    const pluginNames = (updates[0] as any).vite.plugins.map((p: any) => p.name);
    expect(pluginNames).toEqual(['meno-astro:utility-css', 'meno-astro:static-assets']);
  });

  test('play mode without injectScript (older Astro slice) degrades gracefully', () => {
    const root = projectRootWith({ defaultLocale: 'en', locales: [] });
    const prev = process.env[MENO_PLAY_ENV];
    process.env[MENO_PLAY_ENV] = '1';
    try {
      expect(() =>
        menoBase().hooks['astro:config:setup']({
          config: { root: pathToFileURL(`${root}/`) },
          updateConfig: () => {},
          addMiddleware: () => {},
        }),
      ).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env[MENO_PLAY_ENV];
      else process.env[MENO_PLAY_ENV] = prev;
    }
  });

  test('astro:config:setup with a missing config.root degrades gracefully (no throw)', () => {
    const updates: Record<string, unknown>[] = [];
    const middlewares: unknown[] = [];
    expect(() =>
      menoBase().hooks['astro:config:setup']({
        config: {},
        updateConfig: (c) => updates.push(c),
        addMiddleware: (m) => middlewares.push(m),
      }),
    ).not.toThrow();
    // Still injects the middleware and writes some i18n config (defaults when no project found).
    expect(middlewares).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toHaveProperty('i18n');
  });
});

describe('collectUtilitySources', () => {
  test('reads every .astro under <root>/src, carrying its path; ignores non-.astro', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meno-util-'));
    tmps.push(dir);
    mkdirSync(join(dir, 'src', 'pages'), { recursive: true });
    mkdirSync(join(dir, 'src', 'components', 'ui'), { recursive: true });
    writeFileSync(join(dir, 'src', 'pages', 'index.astro'), 'PAGE', 'utf8');
    writeFileSync(join(dir, 'src', 'components', 'ui', 'Card.astro'), 'CARD', 'utf8');
    // non-.astro is ignored
    writeFileSync(join(dir, 'src', 'styles.css'), ':root{}', 'utf8');

    const sources = collectUtilitySources(dir);
    const byPath = Object.fromEntries(sources.map((s) => [s.path, s.src]));
    expect(sources).toHaveLength(2);
    expect(byPath[join(dir, 'src', 'pages', 'index.astro')]).toBe('PAGE');
    expect(byPath[join(dir, 'src', 'components', 'ui', 'Card.astro')]).toBe('CARD');
  });

  test('returns [] when src is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meno-util-'));
    tmps.push(dir);
    expect(collectUtilitySources(dir)).toEqual([]);
  });
});

describe('frameworkFsAllow (island hydration /@fs/ allow-list)', () => {
  test('always includes the project root (Vite root) and returns absolute dirs', () => {
    const allow = frameworkFsAllow('/tmp/some-project');
    // The Vite root is always allowed, so the list is never empty even with no framework
    // renderer installed — Astro concatenates this onto its own fs.allow.
    expect(allow).toContain('/tmp/some-project');
    expect(allow.every((p) => typeof p === 'string' && p.length > 0)).toBe(true);
    // No duplicates (Set-backed).
    expect(new Set(allow).size).toBe(allow.length);
  });

  test('adds the hoisting root (parent of node_modules) of any resolvable package', () => {
    // meno-astro resolves from this monorepo, so its hoisting root — the dir CONTAINING the
    // node_modules it lives in — is added alongside the project root. Every added entry must
    // therefore be a real ancestor dir, never a path that still contains `/node_modules/`.
    const allow = frameworkFsAllow('/tmp/some-project');
    for (const p of allow) {
      if (p === '/tmp/some-project') continue;
      expect(p.includes(`${sep}node_modules${sep}`)).toBe(false);
    }
  });
});

describe('utility-css vite plugin (query-aware virtual module)', () => {
  // A real styled component file the parser fully understands (frontmatter + body),
  // so buildStart() produces a non-empty sheet.
  const STYLED = emit({
    component: { structure: { type: 'node', tag: 'div', style: { base: { color: 'red' } }, children: 'hi' } },
  } as any);

  // Pull the registered plugin object out of the integration's updateConfig payload.
  function getPlugin(root: string): any {
    let captured: any;
    menoBase().hooks['astro:config:setup']({
      config: { root: pathToFileURL(`${root}/`) },
      updateConfig: (c: any) => {
        captured = c;
      },
      addMiddleware: () => {},
    });
    return captured.vite.plugins.find((p: any) => p.name === 'meno-astro:utility-css');
  }

  function rootWithStyle(): string {
    const dir = mkdtempSync(join(tmpdir(), 'meno-utilcss-'));
    tmps.push(dir);
    writeFileSync(join(dir, 'project.config.json'), JSON.stringify({ i18n: {} }), 'utf8');
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'index.astro'), STYLED, 'utf8');
    return dir;
  }

  const RESOLVED = `\0${UTILITY_CSS_MODULE}`;

  test('resolveId maps the bare id and preserves ?inline / ?direct queries', () => {
    const plugin = getPlugin(rootWithStyle());
    expect(plugin.resolveId(UTILITY_CSS_MODULE)).toBe(RESOLVED);
    // The ?inline variant astro re-imports in dev must resolve to the SAME module + query.
    expect(plugin.resolveId(`${UTILITY_CSS_MODULE}?inline`)).toBe(`${RESOLVED}?inline`);
    expect(plugin.resolveId(`${RESOLVED}?direct`)).toBe(`${RESOLVED}?direct`);
    // Unrelated ids are not claimed.
    expect(plugin.resolveId('some-other-module')).toBeNull();
    expect(plugin.resolveId('foo.css')).toBeNull();
  });

  test('load returns the built CSS for the resolved id AND its query variants', () => {
    const plugin = getPlugin(rootWithStyle());
    plugin.buildStart(); // builds the sheet from src/*.astro
    const bare = plugin.load(RESOLVED);
    expect(typeof bare).toBe('string');
    expect(bare).toContain('color: red'); // the utility class rule the component contributes
    // The dev re-import (?inline) must load the same content — this is the astro-dev fix.
    expect(plugin.load(`${RESOLVED}?inline`)).toBe(bare);
    // Non-matching ids return null.
    expect(plugin.load('\0something-else')).toBeNull();
  });

  test('dev change invalidates the bare module AND every resolved ?query variant', () => {
    // Regression: astro's dev style collection (getStylesForURL) re-imports the
    // sheet as a SEPARATE `?inline` module. Invalidating only the bare id left
    // that variant's SSR cache alive, so every post-edit render served the
    // STALE sheet — a style edit changed the element's class to one the stale
    // sheet didn't define, and nothing visibly updated (morph or full reload).
    const root = rootWithStyle();
    const plugin = getPlugin(root);
    plugin.buildStart();
    // Astro resolves the ?inline variant during dev rendering — simulate that
    // so the plugin has seen it before the change event.
    expect(plugin.resolveId(`${UTILITY_CSS_MODULE}?inline`)).toBe(`${RESOLVED}?inline`);

    const invalidated: string[] = [];
    const handlers: Record<string, (f: string) => void> = {};
    plugin.configureServer({
      watcher: {
        on: (evt: string, cb: (f: string) => void) => {
          handlers[evt] = cb;
        },
      },
      moduleGraph: {
        // Every id is "in the graph": return a token carrying the id…
        getModuleById: (id: string) => ({ id }),
        // …and record which ids actually get invalidated.
        invalidateModule: (m: unknown) => invalidated.push((m as { id: string }).id),
      },
      ws: { send: () => {} },
    });
    handlers.change!(join(root, 'src', 'index.astro'));
    expect(invalidated).toContain(RESOLVED);
    expect(invalidated).toContain(`${RESOLVED}?inline`);
  });
});

describe('static asset bridge', () => {
  function makeProject(): string {
    const dir = mkdtempSync(join(tmpdir(), 'meno-assets-'));
    tmps.push(dir);
    mkdirSync(join(dir, 'fonts'), { recursive: true });
    writeFileSync(join(dir, 'fonts', 'inter.woff2'), 'FONTDATA', 'utf8');
    mkdirSync(join(dir, 'images'), { recursive: true });
    writeFileSync(join(dir, 'images', 'hero.webp'), 'IMGDATA', 'utf8');
    return dir;
  }

  test('assetDirForPath identifies meno asset dirs only', () => {
    expect(assetDirForPath('/fonts/inter.woff2')).toBe('fonts');
    expect(assetDirForPath('/images/a/b.png')).toBe('images');
    expect(assetDirForPath('/about')).toBeNull();
    expect(assetDirForPath('/src/pages/index.astro')).toBeNull();
    // every advertised dir is recognized
    for (const d of MENO_ASSET_DIRS) expect(assetDirForPath(`/${d}/x`)).toBe(d);
  });

  test('resolveAssetFile resolves real files and blocks traversal', () => {
    const root = makeProject();
    expect(resolveAssetFile(root, '/fonts/inter.woff2')).toBe(join(root, 'fonts', 'inter.woff2'));
    // non-asset path
    expect(resolveAssetFile(root, '/about')).toBeNull();
    // missing file inside an asset dir
    expect(resolveAssetFile(root, '/fonts/missing.woff2')).toBeNull();
    // directory, not a file
    expect(resolveAssetFile(root, '/fonts')).toBeNull();
    // path traversal attempt escaping the asset dir
    expect(resolveAssetFile(root, '/fonts/../../etc/passwd')).toBeNull();
  });

  test('copyAssetDirsToOutput copies existing dirs into the output, skips absent', () => {
    const root = makeProject();
    const out = mkdtempSync(join(tmpdir(), 'meno-out-'));
    tmps.push(out);

    const copied = copyAssetDirsToOutput(root, out);
    expect(copied.sort()).toEqual(['fonts', 'images']);
    expect(readFileSync(join(out, 'fonts', 'inter.woff2'), 'utf8')).toBe('FONTDATA');
    expect(readFileSync(join(out, 'images', 'hero.webp'), 'utf8')).toBe('IMGDATA');
    // dirs the project doesn't have are not created in the output
    expect(existsSync(join(out, 'videos'))).toBe(false);
  });

  test('astro:build:done copies assets into the resolved output dir', () => {
    const root = makeProject();
    writeFileSync(join(root, 'project.config.json'), JSON.stringify({ i18n: {} }), 'utf8');
    const out = mkdtempSync(join(tmpdir(), 'meno-out-'));
    tmps.push(out);

    const integ = menoBase();
    // config:setup captures the project root from config.root…
    integ.hooks['astro:config:setup']({
      config: { root: pathToFileURL(`${root}/`) },
      updateConfig: () => {},
      addMiddleware: () => {},
    });
    // …then build:done copies root asset dirs into the output dir.
    integ.hooks['astro:build:done']({ dir: pathToFileURL(`${out}/`) });

    expect(readFileSync(join(out, 'fonts', 'inter.woff2'), 'utf8')).toBe('FONTDATA');
  });

  test('astro:build:done with no dir is a no-op (no throw)', () => {
    expect(() => menoBase().hooks['astro:build:done']({})).not.toThrow();
  });
});

describe('siteUrl → Astro `site` + sitemap.xml', () => {
  /** A scratch project with a config and (optionally) emitted-shape pages. */
  function makeProject(config: Record<string, unknown>, pages: Record<string, string> = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'meno-sitemap-'));
    tmps.push(dir);
    writeFileSync(join(dir, 'project.config.json'), JSON.stringify(config), 'utf8');
    for (const [rel, metaLiteral] of Object.entries(pages)) {
      const abs = join(dir, 'src', 'pages', rel);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, `---\nconst meta = ${metaLiteral};\n---\n<div />\n`, 'utf8');
    }
    return dir;
  }

  const I18N = {
    defaultLocale: 'en',
    locales: [
      { code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' },
      { code: 'pl', name: 'Polish', nativeName: 'Polski', langTag: 'pl-PL' },
    ],
  };

  /** Run config:setup (captures projectRoot) then build:done; returns the out dir. */
  function runBuild(
    root: string,
    pages: Array<{ pathname: string }> | undefined,
    onSetup?: (update: Record<string, unknown>) => void,
  ): string {
    const out = mkdtempSync(join(tmpdir(), 'meno-sitemap-out-'));
    tmps.push(out);
    const integ = menoBase();
    integ.hooks['astro:config:setup']({
      config: { root: pathToFileURL(`${root}/`) },
      updateConfig: (c) => onSetup?.(c),
      addMiddleware: () => {},
    });
    integ.hooks['astro:build:done']({ dir: pathToFileURL(`${out}/`), pages });
    return out;
  }

  test('astro:config:setup maps the project siteUrl onto Astro `site`', () => {
    const root = makeProject({ siteUrl: 'https://example.com/', i18n: I18N });
    const updates: Record<string, unknown>[] = [];
    menoBase().hooks['astro:config:setup']({
      config: { root: pathToFileURL(`${root}/`) },
      updateConfig: (c) => updates.push(c),
      addMiddleware: () => {},
    });
    // Trailing slash trimmed by loadSiteUrl; one updateConfig call carries everything.
    expect(updates).toHaveLength(1);
    expect(updates[0]!.site).toBe('https://example.com');
  });

  test('a user-configured `site` wins over the project siteUrl', () => {
    const root = makeProject({ siteUrl: 'https://example.com', i18n: I18N });
    const updates: Record<string, unknown>[] = [];
    menoBase().hooks['astro:config:setup']({
      config: { root: pathToFileURL(`${root}/`), site: 'https://user.dev' },
      updateConfig: (c) => updates.push(c),
      addMiddleware: () => {},
    });
    expect(updates[0]).not.toHaveProperty('site');
  });

  test('no project siteUrl → `site` not set at all', () => {
    const root = makeProject({ i18n: I18N });
    const updates: Record<string, unknown>[] = [];
    menoBase().hooks['astro:config:setup']({
      config: { root: pathToFileURL(`${root}/`) },
      updateConfig: (c) => updates.push(c),
      addMiddleware: () => {},
    });
    expect(updates[0]).not.toHaveProperty('site');
  });

  test('astro:build:done writes sitemap.xml with slug-translated alternates; 404 excluded', () => {
    const root = makeProject(
      { siteUrl: 'https://example.com', i18n: I18N },
      {
        'index.astro': '{ title: "Home" }',
        'about.astro': '{ slugs: { en: "about", pl: "o-nas" } }',
      },
    );
    const out = runBuild(root, [
      { pathname: '' },
      { pathname: 'about/' },
      { pathname: 'pl/o-nas/' },
      { pathname: 'pl/' },
      { pathname: '404/' },
      { pathname: 'blog/my-post/' }, // unroutable (CMS-item shape)
    ]);

    const xml = readFileSync(join(out, 'sitemap.xml'), 'utf8');
    expect(xml).toContain('<loc>https://example.com/about</loc>');
    expect(xml).toContain('<loc>https://example.com/pl/o-nas</loc>');
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="pl-PL" href="https://example.com/pl/o-nas"/>');
    expect(xml).toContain('<xhtml:link rel="alternate" hreflang="x-default" href="https://example.com/about"/>');
    // Unroutable page: listed, but plainly (no alternates pointing at 404s).
    expect(xml).toContain('<url><loc>https://example.com/blog/my-post</loc></url>');
    // Error route excluded outright.
    expect(xml).not.toContain('404');
  });

  test('no siteUrl → sitemap skipped with the one announce line (assets still copy)', () => {
    const root = makeProject({ i18n: I18N }, { 'index.astro': '{}' });
    mkdirSync(join(root, 'fonts'), { recursive: true });
    writeFileSync(join(root, 'fonts', 'x.woff2'), 'F', 'utf8');

    const logs: unknown[][] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => logs.push(args);
    let out: string;
    try {
      out = runBuild(root, [{ pathname: '' }]);
    } finally {
      console.log = orig;
    }
    expect(existsSync(join(out, 'sitemap.xml'))).toBe(false);
    expect(existsSync(join(out, 'fonts', 'x.woff2'))).toBe(true); // ran before the skip
    expect(logs).toEqual([['[meno-astro] sitemap skipped: no siteUrl in project.config.json']]);
  });

  test('pages omitted (older Astro slice) or empty → no sitemap file, no throw', () => {
    const root = makeProject({ siteUrl: 'https://example.com', i18n: I18N });
    expect(existsSync(join(runBuild(root, undefined), 'sitemap.xml'))).toBe(false);
    expect(existsSync(join(runBuild(root, []), 'sitemap.xml'))).toBe(false);
  });
});

describe('adapterFactoryOptions (per-adapter factory args)', () => {
  test('node carries a mode (default standalone; explicit honored)', () => {
    expect(adapterFactoryOptions({ name: 'node' })).toEqual({ mode: 'standalone' });
    expect(adapterFactoryOptions({ name: 'node', mode: 'middleware' })).toEqual({ mode: 'middleware' });
  });
  test('vercel/netlify/cloudflare take no options', () => {
    for (const name of ['vercel', 'netlify', 'cloudflare']) {
      expect(adapterFactoryOptions({ name })).toBeUndefined();
    }
  });
});
