import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFontCss } from './loadFontCss';

const tmps: string[] = [];
function projectWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'load-font-'));
  tmps.push(dir);
  if (config !== undefined) {
    writeFileSync(join(dir, 'project.config.json'), JSON.stringify(config), 'utf8');
  }
  return dir;
}

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe('loadFontCss', () => {
  test('builds @font-face CSS + preload tags from the fonts array', () => {
    const root = projectWith({
      fonts: [{ path: '/fonts/Inter-VariableFont.ttf', family: 'Inter', weight: 400, fontDisplay: 'swap' }],
    });
    const { css, preloads } = loadFontCss(root);

    expect(css).toContain("font-family: 'Inter';");
    expect(css).toContain("src: url('/fonts/Inter-VariableFont.ttf') format('truetype');");
    expect(css).toContain('font-weight: 400;');
    expect(css).toContain('font-display: swap;');

    expect(preloads).toContain('rel="preload"');
    expect(preloads).toContain('href="/fonts/Inter-VariableFont.ttf"');
    expect(preloads).toContain('type="font/ttf"');
    expect(preloads).toContain('crossorigin');
  });

  test('emits a block per configured font', () => {
    const root = projectWith({
      fonts: [
        { path: '/fonts/a.woff2', family: 'A' },
        { path: '/fonts/b.otf', family: 'B' },
      ],
    });
    const { css, preloads } = loadFontCss(root);
    expect(css.match(/@font-face/g)).toHaveLength(2);
    expect(css).toContain("format('woff2')");
    expect(css).toContain("format('opentype')");
    expect(preloads.match(/rel="preload"/g)).toHaveLength(2);
  });

  test('missing project.config.json -> empty strings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-font-empty-'));
    tmps.push(dir);
    expect(loadFontCss(dir)).toEqual({ css: '', preloads: '' });
  });

  test('config present but no fonts key -> empty strings', () => {
    const root = projectWith({ siteUrl: 'https://x' });
    expect(loadFontCss(root)).toEqual({ css: '', preloads: '' });
  });

  test('empty fonts array -> empty strings', () => {
    const root = projectWith({ fonts: [] });
    expect(loadFontCss(root)).toEqual({ css: '', preloads: '' });
  });

  test('unparseable JSON -> empty strings (never throws)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-font-bad-'));
    tmps.push(dir);
    writeFileSync(join(dir, 'project.config.json'), '{ not json', 'utf8');
    expect(loadFontCss(dir)).toEqual({ css: '', preloads: '' });
  });
});
