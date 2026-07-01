import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readKnownTokensSync } from './tokenConfig';

const tmps: string[] = [];
function projectWith(files: { theme?: string; colors?: unknown; variables?: unknown }): string {
  const dir = mkdtempSync(join(tmpdir(), 'token-config-'));
  tmps.push(dir);
  if (files.theme !== undefined) {
    mkdirSync(join(dir, 'src', 'styles'), { recursive: true });
    writeFileSync(join(dir, 'src', 'styles', 'theme.css'), files.theme, 'utf8');
  }
  if (files.colors !== undefined) writeFileSync(join(dir, 'colors.json'), JSON.stringify(files.colors), 'utf8');
  if (files.variables !== undefined)
    writeFileSync(join(dir, 'variables.json'), JSON.stringify(files.variables), 'utf8');
  return dir;
}

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe('readKnownTokensSync', () => {
  test('collects every --name declared in theme.css (colors + variables), so bare color tokens resolve', () => {
    // Regression: theme.css is the source of truth; the retired colors.json/variables.json
    // are gone, so reading them returned an empty set and `bg-bg`/`text-text` lost their CSS.
    const dir = projectWith({
      theme: `/*
 * Banner prose mentioning --not-a-token: should be ignored (it's a comment).
 */
:root {
  /* Colors: light */
  --text: #030712;
  --bg: #f9fafb;
  --bg-100: #f3f4f6;

  /* Font Size */
  --h-fs: 76px;
  /* a value referencing another var must NOT leak the ref as a token */
  --b-p: calc(var(--bg-100) + 2px);
}

[theme="dark"] {
  --text: #f9fafb;
  --bg: #030712;
  --accent: #0f0;
}`,
    });
    const tokens = readKnownTokensSync(dir);
    // bg + bg-100 present → `bg-bg`, `bg-bg-100` get their rules
    expect(tokens.has('bg')).toBe(true);
    expect(tokens.has('bg-100')).toBe(true);
    expect(tokens.has('text')).toBe(true);
    expect(tokens.has('h-fs')).toBe(true);
    expect(tokens.has('accent')).toBe(true); // unique to the dark theme block
    expect(tokens.has('b-p')).toBe(true);
    expect(tokens.has('not-a-token')).toBe(false); // comment prose ignored
  });

  test('theme.css wins over legacy JSON when both exist', () => {
    const dir = projectWith({
      theme: ':root { --bg: #fff; }',
      colors: { themes: { light: { colors: { stale: '#000' } } } },
    });
    const tokens = readKnownTokensSync(dir);
    expect(tokens.has('bg')).toBe(true);
    expect(tokens.has('stale')).toBe(false);
  });

  test('falls back to colors.json + variables.json when theme.css is absent (legacy project)', () => {
    const dir = projectWith({
      colors: {
        themes: {
          light: { colors: { text: '#000', primary: '#f00' } },
          dark: { colors: { text: '#fff', accent: '#0f0' } },
        },
      },
      variables: {
        variables: [
          { cssVar: '--h1-fs', value: '48px' },
          { cssVar: '--brand', value: '#00f' },
        ],
      },
    });
    const tokens = readKnownTokensSync(dir);
    expect([...tokens].sort()).toEqual(['accent', 'brand', 'h1-fs', 'primary', 'text']);
  });

  test('missing/invalid files contribute nothing and never throw', () => {
    expect(readKnownTokensSync(projectWith({})).size).toBe(0);
    expect(readKnownTokensSync(projectWith({ colors: 'not json shape' })).size).toBe(0);
    const bad = mkdtempSync(join(tmpdir(), 'token-config-'));
    tmps.push(bad);
    writeFileSync(join(bad, 'colors.json'), '{ not valid json', 'utf8');
    expect(readKnownTokensSync(bad).size).toBe(0);
  });
});
