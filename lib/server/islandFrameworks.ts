/**
 * Island framework registry — the single source of truth mapping a BYO framework
 * component file (under `src/islands/`) to the Astro renderer integration + npm deps it
 * needs. Used by:
 *   - the `meno()` integration (`astro:config:setup`) to auto-register `@astrojs/<fw>`
 *     for the frameworks a project actually uses (so dropping a `.tsx` in `src/islands/`
 *     "just works" with no astro.config edit);
 *   - `convertProject` to add those deps to a converted project's `package.json`;
 *   - the play-runtime provisioner (via `MENO_ASTRO_FRAMEWORKS`) to install only the
 *     integration packages a project needs.
 *
 * We never install all four into every project — only the ones detected (or explicitly
 * requested via `MENO_ISLAND_FRAMEWORKS`).
 */

import { existsSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

export type IslandFramework = 'react' | 'preact' | 'vue' | 'svelte';

export const ISLAND_FRAMEWORKS: readonly IslandFramework[] = ['react', 'preact', 'vue', 'svelte'];

export function isIslandFramework(value: string): value is IslandFramework {
  return (ISLAND_FRAMEWORKS as readonly string[]).includes(value);
}

/**
 * File extensions that mark an island, mapped to a framework. NOTE: `.jsx`/`.tsx` are
 * shared by React and Preact — extension scan can't tell them apart, so it defaults to
 * React. A Preact project opts in via the `MENO_ISLAND_FRAMEWORKS` override.
 */
export const ISLAND_EXTENSION_FRAMEWORK: Record<string, IslandFramework> = {
  '.tsx': 'react',
  '.jsx': 'react',
  '.vue': 'vue',
  '.svelte': 'svelte',
};

/** Astro renderer integration package + the runtime deps each framework needs (Astro 6). */
export const ISLAND_FRAMEWORK_SPECS: Record<IslandFramework, { integration: string; deps: Record<string, string> }> = {
  react: { integration: '@astrojs/react', deps: { '@astrojs/react': '^5', react: '^19', 'react-dom': '^19' } },
  preact: { integration: '@astrojs/preact', deps: { '@astrojs/preact': '^5', preact: '^10' } },
  vue: { integration: '@astrojs/vue', deps: { '@astrojs/vue': '^6', vue: '^3.5' } },
  svelte: { integration: '@astrojs/svelte', deps: { '@astrojs/svelte': '^8', svelte: '^5' } },
};

/** Merge the npm deps for a set of frameworks into one `{ name: range }` record. */
export function islandFrameworkDeps(frameworks: Iterable<IslandFramework>): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const fw of frameworks) Object.assign(deps, ISLAND_FRAMEWORK_SPECS[fw].deps);
  return deps;
}

/** Parse a comma-separated framework list (e.g. the `MENO_*_FRAMEWORKS` env) into a set. */
export function parseFrameworkList(value: string | undefined): Set<IslandFramework> {
  const out = new Set<IslandFramework>();
  for (const raw of (value ?? '').split(',')) {
    const fw = raw.trim();
    if (fw && isIslandFramework(fw)) out.add(fw);
  }
  return out;
}

/** Recursively collect island framework tokens from the extensions found under a dir. */
function scanFrameworks(dir: string, out: Set<IslandFramework>): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanFrameworks(abs, out);
    } else if (entry.isFile()) {
      const fw = ISLAND_EXTENSION_FRAMEWORK[extname(entry.name).toLowerCase()];
      if (fw) out.add(fw);
    }
  }
}

/**
 * Detect which island frameworks a project uses. An explicit `MENO_ISLAND_FRAMEWORKS`
 * override (comma-separated tokens) wins over the filesystem scan — the way to select
 * Preact (which shares `.jsx`/`.tsx` with React) or to pre-declare frameworks before any
 * island file exists. Otherwise scans `src/islands/` by extension.
 */
export function detectIslandFrameworks(projectRoot: string): Set<IslandFramework> {
  const override = parseFrameworkList(process.env.MENO_ISLAND_FRAMEWORKS);
  if (override.size) return override;
  const out = new Set<IslandFramework>();
  scanFrameworks(join(projectRoot, 'src', 'islands'), out);
  return out;
}
