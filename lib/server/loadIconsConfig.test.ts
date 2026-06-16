import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadIconsConfig } from './loadIconsConfig';

const tmps: string[] = [];
function projectWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'load-icons-'));
  tmps.push(dir);
  if (config !== undefined) {
    writeFileSync(join(dir, 'project.config.json'), JSON.stringify(config), 'utf8');
  }
  return dir;
}

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe('loadIconsConfig', () => {
  test('reads the configured icon hrefs', () => {
    expect(
      loadIconsConfig(
        projectWith({
          icons: {
            favicon: '/icons/favicon.svg',
            faviconDark: '/icons/favicon-dark.svg',
            appleTouchIcon: '/icons/apple-touch-icon.png',
          },
        }),
      ),
    ).toEqual({
      favicon: '/icons/favicon.svg',
      faviconDark: '/icons/favicon-dark.svg',
      appleTouchIcon: '/icons/apple-touch-icon.png',
    });
  });

  test('keeps only the configured subset (favicon-only project)', () => {
    expect(loadIconsConfig(projectWith({ icons: { favicon: '/icons/favicon.ico' } }))).toEqual({
      favicon: '/icons/favicon.ico',
    });
  });

  test('drops non-string / empty / unknown keys', () => {
    expect(
      loadIconsConfig(
        projectWith({
          icons: { favicon: '', faviconDark: 42, appleTouchIcon: null, custom: '/x.png' },
        }),
      ),
    ).toEqual({});
  });

  test('returns {} when `icons` is absent', () => {
    expect(loadIconsConfig(projectWith({ siteUrl: 'https://example.com' }))).toEqual({});
  });

  test('returns {} when `icons` is not an object', () => {
    expect(loadIconsConfig(projectWith({ icons: 'nope' }))).toEqual({});
  });

  test('returns {} when project.config.json is missing', () => {
    expect(loadIconsConfig(projectWith(undefined))).toEqual({});
  });

  test('returns {} on unparseable JSON (never throws)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-icons-bad-'));
    tmps.push(dir);
    writeFileSync(join(dir, 'project.config.json'), '{ not json', 'utf8');
    expect(loadIconsConfig(dir)).toEqual({});
  });
});
