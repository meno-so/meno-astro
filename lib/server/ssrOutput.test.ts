import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAstroConfigExtras } from './loadAstroConfigExtras';
import { adapterDeps, isAstroAdapter, ASTRO_ADAPTER_SPECS, ALL_ADAPTER_PACKAGES, ASTRO_ADAPTERS } from './adapters';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write a project.config.json into a fresh temp dir; return the dir. */
function projectWith(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'meno-ssr-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'project.config.json'), JSON.stringify(config));
  return dir;
}

describe('adapters registry', () => {
  test('isAstroAdapter recognizes the four supported adapters', () => {
    for (const a of ['node', 'netlify', 'vercel', 'cloudflare']) expect(isAstroAdapter(a)).toBe(true);
    expect(isAstroAdapter('deno')).toBe(false);
    expect(isAstroAdapter('')).toBe(false);
  });

  test('adapterDeps returns the @astrojs/<name> package for a known adapter, {} otherwise', () => {
    expect(adapterDeps('node')).toEqual({ '@astrojs/node': expect.any(String) });
    expect(adapterDeps('vercel')).toEqual({ '@astrojs/vercel': expect.any(String) });
    expect(adapterDeps('unknown')).toEqual({});
    expect(adapterDeps(undefined)).toEqual({});
    expect(adapterDeps(null)).toEqual({});
  });

  test('ALL_ADAPTER_PACKAGES covers every adapter package (reserved-deps source)', () => {
    expect(ALL_ADAPTER_PACKAGES.length).toBe(ASTRO_ADAPTERS.length);
    for (const a of ASTRO_ADAPTERS) expect(ALL_ADAPTER_PACKAGES).toContain(ASTRO_ADAPTER_SPECS[a].package);
  });
});

describe('loadAstroConfigExtras — output + adapter', () => {
  test('static (or unset) output yields no output/adapter', () => {
    expect(loadAstroConfigExtras(projectWith({})).output).toBeUndefined();
    expect(loadAstroConfigExtras(projectWith({ output: 'static' })).output).toBeUndefined();
  });

  test('server output with a valid adapter is surfaced', () => {
    const extras = loadAstroConfigExtras(projectWith({ output: 'server', adapter: { name: 'node' } }));
    expect(extras.output).toBe('server');
    expect(extras.adapter).toEqual({ name: 'node' });
  });

  test('node adapter carries a valid mode; an invalid mode is dropped', () => {
    expect(
      loadAstroConfigExtras(projectWith({ output: 'server', adapter: { name: 'node', mode: 'middleware' } })).adapter,
    ).toEqual({ name: 'node', mode: 'middleware' });
    expect(
      loadAstroConfigExtras(projectWith({ output: 'server', adapter: { name: 'node', mode: 'bogus' } })).adapter,
    ).toEqual({ name: 'node' });
  });

  test('a bare string adapter is accepted', () => {
    const extras = loadAstroConfigExtras(projectWith({ output: 'server', adapter: 'vercel' }));
    expect(extras.adapter).toEqual({ name: 'vercel' });
  });

  test('server output WITHOUT a (valid) adapter stays static — never a hard-fail build', () => {
    expect(loadAstroConfigExtras(projectWith({ output: 'server' })).output).toBeUndefined();
    expect(loadAstroConfigExtras(projectWith({ output: 'server', adapter: { name: 'deno' } })).output).toBeUndefined();
  });

  test("legacy 'hybrid' maps to server", () => {
    const extras = loadAstroConfigExtras(projectWith({ output: 'hybrid', adapter: { name: 'netlify' } }));
    expect(extras.output).toBe('server');
    expect(extras.adapter).toEqual({ name: 'netlify' });
  });

  test('the other Astro config extras are untouched by the SSR additions', () => {
    const extras = loadAstroConfigExtras(
      projectWith({
        output: 'server',
        adapter: { name: 'node' },
        devToolbar: true,
        image: { domains: ['cdn.example.com'] },
      }),
    );
    expect(extras.devToolbar).toEqual({ enabled: true });
    expect(extras.image).toEqual({ domains: ['cdn.example.com'] });
  });
});
