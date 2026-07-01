import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSiteUrl } from './loadSiteUrl';

const tmps: string[] = [];
function projectWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'load-siteurl-'));
  tmps.push(dir);
  if (config !== undefined) {
    writeFileSync(join(dir, 'project.config.json'), JSON.stringify(config), 'utf8');
  }
  return dir;
}

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe('loadSiteUrl', () => {
  test('reads a configured siteUrl', () => {
    expect(loadSiteUrl(projectWith({ siteUrl: 'https://example.com' }))).toBe('https://example.com');
  });

  test('trims trailing slashes (callers do `${siteUrl}${path}`)', () => {
    expect(loadSiteUrl(projectWith({ siteUrl: 'https://example.com/' }))).toBe('https://example.com');
    expect(loadSiteUrl(projectWith({ siteUrl: 'https://example.com//' }))).toBe('https://example.com');
  });

  test('trims surrounding whitespace', () => {
    expect(loadSiteUrl(projectWith({ siteUrl: '  https://example.com/  ' }))).toBe('https://example.com');
  });

  test('missing project.config.json -> null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-siteurl-empty-'));
    tmps.push(dir);
    expect(loadSiteUrl(dir)).toBeNull();
  });

  test('config present but no siteUrl key -> null', () => {
    expect(loadSiteUrl(projectWith({ i18n: {} }))).toBeNull();
  });

  test('empty / whitespace-only / slash-only siteUrl -> null', () => {
    expect(loadSiteUrl(projectWith({ siteUrl: '' }))).toBeNull();
    expect(loadSiteUrl(projectWith({ siteUrl: '   ' }))).toBeNull();
    expect(loadSiteUrl(projectWith({ siteUrl: '/' }))).toBeNull();
  });

  test('non-string siteUrl -> null', () => {
    expect(loadSiteUrl(projectWith({ siteUrl: 42 }))).toBeNull();
    expect(loadSiteUrl(projectWith({ siteUrl: { url: 'https://x' } }))).toBeNull();
  });

  test('unparseable JSON -> null (never throws)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-siteurl-bad-'));
    tmps.push(dir);
    writeFileSync(join(dir, 'project.config.json'), '{ this is not json', 'utf8');
    expect(loadSiteUrl(dir)).toBeNull();
  });
});
