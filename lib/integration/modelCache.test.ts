import { test, expect, describe, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectModels, getProjectClassTokens, clearModelCache } from './modelCache';
import { emit } from '../dialect';

// Real dialect sources the parser fully understands (same fixture recipe as utilityCss.test.ts).
const RED = emit({
  component: { structure: { type: 'node', tag: 'div', style: { base: { color: 'red' } }, children: 'hi' } },
} as any);
const BLUE = emit({
  component: { structure: { type: 'node', tag: 'div', style: { base: { color: 'blue' } }, children: 'hi' } },
} as any);
// Truncated mid-expression so parse() throws — the version-skew stand-in.
const BAD = RED.slice(0, RED.indexOf('class={cx(') + 'class={cx('.length);

const tmps: string[] = [];
afterEach(() => {
  clearModelCache();
  for (const dir of tmps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'meno-modelcache-'));
  tmps.push(dir);
  for (const [rel, src] of Object.entries(files)) {
    const path = join(dir, 'src', rel);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, src, 'utf8');
  }
  return dir;
}

/** Pin two writes to the SAME mtime so only content comparison can tell them apart. */
function pinMtime(path: string, t: Date): void {
  utimesSync(path, t, t);
}

describe('getProjectModels', () => {
  test('returns a model per parseable .astro; missing src yields []', () => {
    const dir = project({ 'A.astro': RED, 'nested/B.astro': BLUE });
    expect(getProjectModels(dir)).toHaveLength(2);
    const empty = mkdtempSync(join(tmpdir(), 'meno-modelcache-'));
    tmps.push(empty);
    expect(getProjectModels(empty)).toEqual([]);
  });

  test('unchanged files are served from cache — an unparseable file warns once, not per sweep', () => {
    const dir = project({ 'A.astro': RED, 'BAD.astro': BAD });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(getProjectModels(dir)).toHaveLength(1);
      const warnsAfterFirst = warn.mock.calls.length;
      expect(warnsAfterFirst).toBe(1);
      // Second and third sweeps: nothing changed → no re-parse → no re-warn.
      getProjectModels(dir);
      getProjectModels(dir);
      expect(warn.mock.calls.length).toBe(warnsAfterFirst);
    } finally {
      warn.mockRestore();
    }
  });

  test('a changed file re-parses; a fixed file joins the models', () => {
    const dir = project({ 'A.astro': RED, 'BAD.astro': BAD });
    expect(getProjectModels(dir)).toHaveLength(1);
    writeFileSync(join(dir, 'src', 'BAD.astro'), BLUE, 'utf8');
    expect(getProjectModels(dir)).toHaveLength(2);
  });

  test('a SAME-LENGTH rewrite within one mtime tick still invalidates (content comparison, not stat)', () => {
    // The classic stat-cache hole: `red` → `tan` keeps the byte length, and pinning
    // the mtime simulates two saves inside one tick (or a coarse-mtime filesystem).
    const dir = project({ 'A.astro': RED });
    const file = join(dir, 'src', 'A.astro');
    const pinned = new Date(Date.now() - 60_000);
    pinMtime(file, pinned);
    const before = getProjectClassTokens(dir);
    expect([...before].some((t) => t.includes('red'))).toBe(true);
    writeFileSync(file, RED.replace(/red/g, 'tan'), 'utf8');
    pinMtime(file, pinned); // same mtime, same size — only the bytes differ
    const after = getProjectClassTokens(dir);
    expect([...after].some((t) => t.includes('tan'))).toBe(true);
    expect([...after].some((t) => t.includes('red'))).toBe(false);
  });

  test('a deleted file is pruned from the models', () => {
    const dir = project({ 'A.astro': RED, 'B.astro': BLUE });
    expect(getProjectModels(dir)).toHaveLength(2);
    rmSync(join(dir, 'src', 'B.astro'));
    expect(getProjectModels(dir)).toHaveLength(1);
  });

  test('a new file appears on the next sweep', () => {
    const dir = project({ 'A.astro': RED });
    expect(getProjectModels(dir)).toHaveLength(1);
    writeFileSync(join(dir, 'src', 'C.astro'), BLUE, 'utf8');
    expect(getProjectModels(dir)).toHaveLength(2);
  });
});

describe('getProjectClassTokens', () => {
  test('unions per-file tokens and tracks edits', () => {
    const dir = project({ 'A.astro': RED });
    const before = getProjectClassTokens(dir);
    expect([...before].some((t) => t.includes('red'))).toBe(true);
    writeFileSync(join(dir, 'src', 'A.astro'), BLUE, 'utf8');
    const after = getProjectClassTokens(dir);
    expect([...after].some((t) => t.includes('blue'))).toBe(true);
    expect([...after].some((t) => t.includes('red'))).toBe(false);
  });
});
