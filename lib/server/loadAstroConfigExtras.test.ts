import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAstroConfigExtras } from './loadAstroConfigExtras';

const tmps: string[] = [];
function projectWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'load-extras-'));
  tmps.push(dir);
  if (config !== undefined) {
    writeFileSync(join(dir, 'project.config.json'), JSON.stringify(config), 'utf8');
  }
  return dir;
}

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe('loadAstroConfigExtras', () => {
  test('missing config → {}', () => {
    expect(loadAstroConfigExtras(mkdtempSync(join(tmpdir(), 'load-extras-empty-')))).toEqual({});
  });

  test('redirects: [{from,to}] → Astro map; non-301 status → object form', () => {
    const extras = loadAstroConfigExtras(
      projectWith({
        redirects: [
          { from: '/old', to: '/new' },
          { from: '/blog/x', to: '/articles/x', status: 302 },
          { from: '/perm', to: '/p', status: 301 },
          { from: '', to: '/skip' }, // empty from → dropped
        ],
      }),
    );
    expect(extras.redirects).toEqual({
      '/old': '/new',
      '/blog/x': { status: 302, destination: '/articles/x' },
      '/perm': '/p',
    });
  });

  test('image domains: filters empties, drops when none', () => {
    expect(loadAstroConfigExtras(projectWith({ image: { domains: ['a.com', '', 'b.com'] } })).image).toEqual({
      domains: ['a.com', 'b.com'],
    });
    expect(loadAstroConfigExtras(projectWith({ image: { domains: [] } })).image).toBeUndefined();
  });

  test('prefetch: Meno PrefetchConfig (enabled) → Astro prefetch; disabled → absent', () => {
    expect(
      loadAstroConfigExtras(projectWith({ prefetch: { enabled: true, defaultStrategy: 'viewport' } })).prefetch,
    ).toEqual({
      prefetchAll: true,
      defaultStrategy: 'viewport',
    });
    // enabled but unknown strategy → defaults to 'hover'.
    expect(loadAstroConfigExtras(projectWith({ prefetch: { enabled: true } })).prefetch).toEqual({
      prefetchAll: true,
      defaultStrategy: 'hover',
    });
    expect(loadAstroConfigExtras(projectWith({ prefetch: { enabled: false } })).prefetch).toBeUndefined();
  });

  test('devToolbar: boolean or {enabled} → {enabled}', () => {
    expect(loadAstroConfigExtras(projectWith({ devToolbar: true })).devToolbar).toEqual({ enabled: true });
    expect(loadAstroConfigExtras(projectWith({ devToolbar: false })).devToolbar).toEqual({ enabled: false });
    expect(loadAstroConfigExtras(projectWith({ devToolbar: { enabled: true } })).devToolbar).toEqual({ enabled: true });
    expect(loadAstroConfigExtras(projectWith({})).devToolbar).toBeUndefined();
  });
});
