import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectIslandFrameworks,
  islandFrameworkDeps,
  parseFrameworkList,
  ISLAND_FRAMEWORK_SPECS,
} from './islandFrameworks';

function scratchProject(islandFiles: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'meno-islands-'));
  if (islandFiles.length) {
    const dir = join(root, 'src', 'islands');
    for (const f of islandFiles) {
      const abs = join(dir, f);
      mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
      writeFileSync(abs, '// island');
    }
  }
  return root;
}

const created: string[] = [];
function project(files: string[]): string {
  const root = scratchProject(files);
  created.push(root);
  return root;
}

afterEach(() => {
  delete process.env.MENO_ISLAND_FRAMEWORKS;
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe('detectIslandFrameworks', () => {
  test('maps extensions to frameworks (.tsx/.jsx → react)', () => {
    const root = project(['Counter.tsx', 'Legacy.jsx']);
    expect([...detectIslandFrameworks(root)]).toEqual(['react']);
  });

  test('detects vue + svelte, recursing into subdirectories', () => {
    const root = project(['widgets/Chart.vue', 'Toggle.svelte']);
    expect(new Set(detectIslandFrameworks(root))).toEqual(new Set(['vue', 'svelte']));
  });

  test('a project with no src/islands/ detects nothing', () => {
    const root = project([]);
    expect(detectIslandFrameworks(root).size).toBe(0);
  });

  test('MENO_ISLAND_FRAMEWORKS overrides the filesystem scan (selects Preact)', () => {
    const root = project(['Counter.tsx']); // would scan as react…
    process.env.MENO_ISLAND_FRAMEWORKS = 'preact';
    expect([...detectIslandFrameworks(root)]).toEqual(['preact']); // …but the override wins
  });

  test('the override ignores unknown tokens', () => {
    const root = project([]);
    process.env.MENO_ISLAND_FRAMEWORKS = 'vue, bogus , svelte';
    expect(new Set(detectIslandFrameworks(root))).toEqual(new Set(['vue', 'svelte']));
  });
});

describe('islandFrameworkDeps', () => {
  test('merges the integration + runtime deps for the chosen frameworks', () => {
    const deps = islandFrameworkDeps(['react', 'vue']);
    expect(deps['@astrojs/react']).toBe(ISLAND_FRAMEWORK_SPECS.react.deps['@astrojs/react']);
    expect(deps.react).toBeDefined();
    expect(deps['react-dom']).toBeDefined();
    expect(deps['@astrojs/vue']).toBeDefined();
    expect(deps.vue).toBeDefined();
    // Frameworks not requested are absent.
    expect(deps['@astrojs/svelte']).toBeUndefined();
  });
});

describe('parseFrameworkList', () => {
  test('parses comma lists, trims, drops blanks/unknowns', () => {
    expect(new Set(parseFrameworkList(' react , svelte ,, nope'))).toEqual(new Set(['react', 'svelte']));
    expect(parseFrameworkList(undefined).size).toBe(0);
  });
});
