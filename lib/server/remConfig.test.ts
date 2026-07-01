import { test, expect, describe } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readRemConfigSync } from './remConfig';

describe('readRemConfigSync', () => {
  test('reads remConversion from project.config.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meno-rem-'));
    try {
      writeFileSync(
        join(dir, 'project.config.json'),
        JSON.stringify({ remConversion: { enabled: true, baseFontSize: 10 } }),
      );
      const rem = readRemConfigSync(dir);
      expect(rem.enabled).toBe(true);
      expect(rem.baseFontSize).toBe(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an absent remConversion block → disabled default (base 16)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meno-rem-'));
    try {
      writeFileSync(join(dir, 'project.config.json'), JSON.stringify({ responsiveScales: { enabled: true } }));
      const rem = readRemConfigSync(dir);
      expect(rem.enabled).toBe(false);
      expect(rem.baseFontSize).toBe(16);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a partial remConversion fills missing fields from defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'meno-rem-'));
    try {
      writeFileSync(join(dir, 'project.config.json'), JSON.stringify({ remConversion: { enabled: true } }));
      const rem = readRemConfigSync(dir);
      expect(rem.enabled).toBe(true);
      expect(rem.baseFontSize).toBe(16); // default fallback
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing/unreadable config → disabled default, never throws', () => {
    const rem = readRemConfigSync(join(tmpdir(), 'meno-rem-does-not-exist-xyz'));
    expect(rem.enabled).toBe(false);
    expect(rem.baseFontSize).toBe(16);
  });
});
