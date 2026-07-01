import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSocial } from './loadSocial';

const tmps: string[] = [];
function projectWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'load-social-'));
  tmps.push(dir);
  if (config !== undefined) {
    writeFileSync(join(dir, 'project.config.json'), JSON.stringify(config), 'utf8');
  }
  return dir;
}

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe('loadSocial', () => {
  test('reads twitterHandle from social config', () => {
    const dir = projectWith({ social: { twitterHandle: '@meno' } });
    expect(loadSocial(dir)).toEqual({ twitterHandle: '@meno' });
  });

  test('trims whitespace on twitterHandle', () => {
    const dir = projectWith({ social: { twitterHandle: '  meno  ' } });
    expect(loadSocial(dir)).toEqual({ twitterHandle: 'meno' });
  });

  test('empty / whitespace handle drops to {}', () => {
    expect(loadSocial(projectWith({ social: { twitterHandle: '   ' } }))).toEqual({});
    expect(loadSocial(projectWith({ social: { twitterHandle: '' } }))).toEqual({});
  });

  test('non-string handle ignored', () => {
    expect(loadSocial(projectWith({ social: { twitterHandle: 123 } }))).toEqual({});
  });

  test('missing social key → {}', () => {
    expect(loadSocial(projectWith({ siteUrl: 'https://x.com' }))).toEqual({});
  });

  test('non-object social → {}', () => {
    expect(loadSocial(projectWith({ social: 'nope' }))).toEqual({});
  });

  test('missing config file → {}', () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-social-empty-'));
    tmps.push(dir);
    expect(loadSocial(dir)).toEqual({});
  });

  test('unparseable JSON → {} (never throws)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-social-bad-'));
    tmps.push(dir);
    writeFileSync(join(dir, 'project.config.json'), '{ not json', 'utf8');
    expect(loadSocial(dir)).toEqual({});
  });
});
