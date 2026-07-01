import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLibraries, collectAstroComponentLibraries } from './loadLibraries';

const tmps: string[] = [];
function projectWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'load-libs-'));
  tmps.push(dir);
  if (config !== undefined) {
    writeFileSync(join(dir, 'project.config.json'), JSON.stringify(config), 'utf8');
  }
  return dir;
}

/** Write an emitted-shape component (`const __meno = {…}`) under src/components. */
function writeComponent(root: string, relName: string, librariesLiteral: string): string {
  const abs = join(root, 'src', 'components', relName);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(
    abs,
    `---\nconst __meno = { category: "ui", libraries: ${librariesLiteral} };\nconst { title } = resolveProps(Astro, { title: { type: "string", default: "" } });\n---\n<div>{title}</div>\n`,
    'utf8',
  );
  return abs;
}

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe('loadLibraries', () => {
  test('external CSS -> <link> in headCSS', () => {
    const root = projectWith({ libraries: { css: [{ url: 'https://cdn.example.com/x.css' }] } });
    const { headCSS } = loadLibraries(root);
    expect(headCSS).toBe('<link rel="stylesheet" href="https://cdn.example.com/x.css">');
  });

  test('CSS media query is preserved on the <link>', () => {
    const root = projectWith({ libraries: { css: [{ url: 'https://cdn/x.css', media: 'print' }] } });
    expect(loadLibraries(root).headCSS).toContain('media="print"');
  });

  test('default classic JS -> BLOCKING <head> script (load-order fix); explicit position:head still deferred', () => {
    // A default classic library (no mode/position) is the auto-provisioned UMD-global case
    // (embla, swiper, …) — it must define its global before the inline component init scripts
    // emitted mid-body run, so it renders as a blocking <head> script (no defer). An author who
    // explicitly set position:head kept their deferred head script (intent honored).
    const root = projectWith({
      libraries: {
        js: [{ url: 'https://cdn/body.js' }, { url: 'https://cdn/head.js', position: 'head' }],
      },
    });
    const { headJS, bodyEndJS } = loadLibraries(root);
    expect(bodyEndJS).toBe('');
    expect(headJS).toBe(
      '<script src="https://cdn/body.js"></script>\n  <script src="https://cdn/head.js" defer></script>',
    );
  });

  test('an EXPLICIT mode/position on a classic script is honored (not force-blocked into <head>)', () => {
    // Only DEFAULT classic scripts move to a blocking <head> tag. An author who explicitly
    // opted into defer (or body-end) keeps that load strategy — we never override intent.
    const root = projectWith({
      libraries: {
        js: [
          { url: 'https://cdn/explicit-defer.js', mode: 'defer' },
          { url: 'https://cdn/explicit-body.js', position: 'body-end' },
        ],
      },
    });
    const { headJS, bodyEndJS } = loadLibraries(root);
    expect(headJS).toBe('');
    expect(bodyEndJS).toBe(
      '<script src="https://cdn/explicit-defer.js" defer></script>\n  <script src="https://cdn/explicit-body.js" defer></script>',
    );
  });

  test('module type and async mode render on the <script>', () => {
    const root = projectWith({
      libraries: {
        js: [
          { url: 'https://cdn/m.js', type: 'module' },
          { url: 'https://cdn/a.js', mode: 'async' },
        ],
      },
    });
    const { bodyEndJS } = loadLibraries(root);
    expect(bodyEndJS).toContain('<script src="https://cdn/m.js" type="module"></script>');
    expect(bodyEndJS).toContain('<script src="https://cdn/a.js" async></script>');
  });

  test('string-URL shorthand is normalized to object form', () => {
    const root = projectWith({
      libraries: { css: ['https://cdn/s.css'], js: ['https://cdn/s.js'] },
    });
    const { headCSS, headJS } = loadLibraries(root);
    expect(headCSS).toContain('href="https://cdn/s.css"');
    expect(headJS).toContain('src="https://cdn/s.js"');
  });

  test('local CSS is inlined into a <style> tag (byte-parity with SSR)', () => {
    const root = projectWith({ libraries: { css: [{ url: '/libraries/local.css' }] } });
    mkdirSync(join(root, 'libraries'), { recursive: true });
    writeFileSync(join(root, 'libraries', 'local.css'), '.brand{color:red}', 'utf8');
    const { headCSS } = loadLibraries(root);
    expect(headCSS).toBe('<style>.brand{color:red}</style>');
  });

  test('local CSS with inline:false stays a <link>', () => {
    const root = projectWith({ libraries: { css: [{ url: '/libraries/local.css', inline: false }] } });
    mkdirSync(join(root, 'libraries'), { recursive: true });
    writeFileSync(join(root, 'libraries', 'local.css'), '.x{}', 'utf8');
    expect(loadLibraries(root).headCSS).toBe('<link rel="stylesheet" href="/libraries/local.css">');
  });

  test('missing local CSS file falls back to a <link> (never throws)', () => {
    const root = projectWith({ libraries: { css: [{ url: '/libraries/nope.css' }] } });
    expect(loadLibraries(root).headCSS).toBe('<link rel="stylesheet" href="/libraries/nope.css">');
  });

  test('merge order global -> component -> page; deduped by URL', () => {
    const root = projectWith({
      libraries: { js: [{ url: 'https://cdn/g.js' }, { url: 'https://cdn/dup.js' }] },
      __componentLibraries: { js: [{ url: 'https://cdn/c.js' }, { url: 'https://cdn/dup.js' }] },
    });
    const { headJS } = loadLibraries(root, { libraries: { js: [{ url: 'https://cdn/p.js' }] } });
    const urls = [...headJS.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
    expect(urls).toEqual(['https://cdn/g.js', 'https://cdn/dup.js', 'https://cdn/c.js', 'https://cdn/p.js']);
  });

  test("page mode:'replace' drops global + component libraries", () => {
    const root = projectWith({
      libraries: { js: [{ url: 'https://cdn/g.js' }] },
      __componentLibraries: { js: [{ url: 'https://cdn/c.js' }] },
    });
    const { headJS } = loadLibraries(root, {
      libraries: { mode: 'replace', js: [{ url: 'https://cdn/only.js' }] },
    });
    expect(headJS).toBe('<script src="https://cdn/only.js"></script>');
  });

  test('page-tier local CSS is NOT rendered as a tag (it loads via the page import)', () => {
    const root = projectWith({});
    const { headCSS } = loadLibraries(root, { libraries: { css: [{ url: '/libraries/page.css' }] } });
    expect(headCSS).toBe('');
  });

  test('page-tier local module JS is dropped (imported), but local CLASSIC JS stays a tag', () => {
    const root = projectWith({});
    const { headJS } = loadLibraries(root, {
      libraries: {
        js: [
          { url: '/libraries/mod.js', type: 'module' }, // imported by the page → no tag
          { url: '/libraries/legacy.js' }, // classic → blocking <head> script (load-order fix)
        ],
      },
    });
    expect(headJS).toBe('<script src="/libraries/legacy.js"></script>');
  });

  test('global-tier local CSS is still inlined (no per-page import exists for it)', () => {
    const root = projectWith({ libraries: { css: [{ url: '/libraries/global.css' }] } });
    mkdirSync(join(root, 'libraries'), { recursive: true });
    writeFileSync(join(root, 'libraries', 'global.css'), '.g{}', 'utf8');
    expect(loadLibraries(root).headCSS).toBe('<style>.g{}</style>');
  });

  test('build context: disableBuild dropped, disableEditor kept', () => {
    const root = projectWith({
      libraries: {
        css: [
          { url: 'https://cdn/build-off.css', disableBuild: true },
          { url: 'https://cdn/editor-off.css', disableEditor: true },
        ],
      },
    });
    const { headCSS } = loadLibraries(root);
    expect(headCSS).not.toContain('build-off.css');
    expect(headCSS).toContain('editor-off.css');
  });

  test('missing project.config.json -> empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-libs-empty-'));
    tmps.push(dir);
    expect(loadLibraries(dir)).toEqual({ headCSS: '', headJS: '', bodyEndJS: '' });
  });

  test('config present but no libraries -> empty', () => {
    const root = projectWith({ siteUrl: 'https://x' });
    expect(loadLibraries(root)).toEqual({ headCSS: '', headJS: '', bodyEndJS: '' });
  });

  test('unparseable JSON -> empty (never throws)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-libs-bad-'));
    tmps.push(dir);
    writeFileSync(join(dir, 'project.config.json'), '{ not json', 'utf8');
    expect(loadLibraries(dir)).toEqual({ headCSS: '', headJS: '', bodyEndJS: '' });
  });
});

describe('component tier — live collection from src/components (play-mode parity)', () => {
  test('external JS in a component __meno is injected with NO __componentLibraries snapshot', () => {
    const root = projectWith({});
    writeComponent(root, 'Slider.astro', `{ js: [{ url: "https://cdn/swiper.js" }] }`);
    expect(loadLibraries(root).headJS).toBe('<script src="https://cdn/swiper.js"></script>');
  });

  test('live collection supersedes a STALE __componentLibraries snapshot', () => {
    const root = projectWith({
      __componentLibraries: { js: [{ url: 'https://cdn/removed-long-ago.js' }] },
    });
    writeComponent(root, 'Slider.astro', `{ js: [{ url: "https://cdn/current.js" }] }`);
    const { headJS } = loadLibraries(root);
    expect(headJS).toBe('<script src="https://cdn/current.js"></script>');
    expect(headJS).not.toContain('removed-long-ago');
  });

  test('snapshot is still the fallback when the project has no src/components dir', () => {
    const root = projectWith({
      __componentLibraries: { js: [{ url: 'https://cdn/snapshot.js' }] },
    });
    expect(loadLibraries(root).headJS).toContain('https://cdn/snapshot.js');
  });

  test('component local CSS + module JS are stripped (they load via the component import); classic local JS stays', () => {
    const root = projectWith({});
    writeComponent(
      root,
      'Card.astro',
      `{ css: [{ url: "/libraries/card.css" }], js: [{ url: "/libraries/card.js", type: "module" }, { url: "/libraries/legacy.js" }] }`,
    );
    const { headCSS, headJS } = loadLibraries(root);
    expect(headCSS).toBe('');
    expect(headJS).toBe('<script src="/libraries/legacy.js"></script>');
  });

  test('walks category subfolders and dedupes by URL across components and vs global', () => {
    const root = projectWith({ libraries: { js: [{ url: 'https://cdn/shared.js' }] } });
    writeComponent(root, 'A.astro', `{ js: [{ url: "https://cdn/shared.js" }, { url: "https://cdn/a.js" }] }`);
    writeComponent(root, join('ui', 'B.astro'), `{ js: [{ url: "https://cdn/a.js" }, { url: "https://cdn/b.js" }] }`);
    const urls = [...loadLibraries(root).headJS.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
    expect(urls).toEqual(['https://cdn/shared.js', 'https://cdn/a.js', 'https://cdn/b.js']);
  });

  test('a component without __meno libraries contributes nothing (never throws)', () => {
    const root = projectWith({});
    mkdirSync(join(root, 'src', 'components'), { recursive: true });
    writeFileSync(join(root, 'src', 'components', 'Plain.astro'), '---\n---\n<div></div>\n', 'utf8');
    expect(loadLibraries(root)).toEqual({ headCSS: '', headJS: '', bodyEndJS: '' });
  });

  test('an edited component (new mtime) is re-read — editor saves stay fresh', () => {
    const root = projectWith({});
    const file = writeComponent(root, 'Live.astro', `{ js: [{ url: "https://cdn/v1.js" }] }`);
    expect(loadLibraries(root).headJS).toContain('v1.js');

    writeComponent(root, 'Live.astro', `{ js: [{ url: "https://cdn/v2.js" }] }`);
    // Force a distinct mtime — same-millisecond rewrites would otherwise hit the cache.
    const future = new Date(Date.now() + 5000);
    utimesSync(file, future, future);

    const { headJS } = loadLibraries(root);
    expect(headJS).toContain('v2.js');
    expect(headJS).not.toContain('v1.js');
  });

  test('collectAstroComponentLibraries: null without dir, empty config with empty dir', () => {
    const root = projectWith({});
    expect(collectAstroComponentLibraries(root)).toBeNull();
    mkdirSync(join(root, 'src', 'components'), { recursive: true });
    expect(collectAstroComponentLibraries(root)).toEqual({ js: [], css: [] });
  });
});
