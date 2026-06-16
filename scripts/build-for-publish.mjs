#!/usr/bin/env node
/**
 * Build script for npm publishing (mirrors meno-core/scripts/build-for-publish.mjs).
 *
 * Compiles the RUNTIME surface of meno-astro (the exports a deployed Astro project
 * actually loads) TypeScript → JavaScript, so Node/Astro consumers run without Bun.
 * `meno-core` and `astro` stay EXTERNAL — meno-core is a real dependency (its
 * `./shared` barrel is the only subpath the runtime touches), astro is a peer the
 * host project provides. `.astro` component files ship as source (Astro compiles
 * them in the consuming project).
 *
 * The `./server` and other build-time-only entry points are intentionally NOT
 * published — Meno Studio/CLI use those from the workspace source, never from the
 * installed package, and they import meno-core subpaths that published meno-core
 * doesn't emit.
 *
 * Also rewrites package.json so the published tarball points at dist/ and pins the
 * meno-core dependency to a real version (replacing `workspace:*`). The pristine
 * package.json is saved to package.json.bak and restored by restore-package.mjs
 * (the postpublish hook) — packages/astro is untracked, so we can't `git checkout`.
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync, readdirSync, copyFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgJsonPath = join(pkgRoot, 'package.json');
const backupPath = join(pkgRoot, 'package.json.bak');

// 1. Back up the pristine package.json (only on the first run — re-runs must not
//    clobber the pristine copy with an already-rewritten one).
if (!existsSync(backupPath)) {
  copyFileSync(pkgJsonPath, backupPath);
}

// 2. Clean previous build.
rmSync(join(pkgRoot, 'dist'), { recursive: true, force: true });

// 3. Bundle the runtime entry points. meno-core / astro / astro:* stay external;
//    `*.astro` relative imports stay external (copied verbatim below).
await build({
  absWorkingDir: pkgRoot,
  entryPoints: [
    'lib/index.ts',
    'lib/dialect/index.ts',
    'lib/integration/index.ts',
    'lib/components/index.ts',
    'lib/runtime/localeMiddleware.ts',
  ],
  outdir: 'dist',
  outbase: '.',
  format: 'esm',
  platform: 'node',
  target: 'node18',
  bundle: true,
  packages: 'external', // meno-core, astro, astro:content, … all external
  external: ['*.astro'], // Astro components ship as source (copied below)
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  sourcemap: true,
});

console.log('meno-astro: build complete → dist/');

// 4. Copy the .astro component sources next to the compiled components index so the
//    external `./X.astro` imports resolve in the consuming project.
const compSrc = join(pkgRoot, 'lib', 'components');
const compDest = join(pkgRoot, 'dist', 'lib', 'components');
mkdirSync(compDest, { recursive: true });
for (const f of readdirSync(compSrc)) {
  if (f.endsWith('.astro')) copyFileSync(join(compSrc, f), join(compDest, f));
}
console.log('meno-astro: copied .astro components → dist/lib/components/');

// 5. Pin the meno-core dependency to a real published version (replace workspace:*).
// Standalone mirror: pin from this package's own meno-core dependency (no sibling core/).
const coreVersion = JSON.parse(readFileSync(pkgJsonPath, 'utf8')).dependencies['meno-core'].replace(/^[\^~]/, '');

// 6. Rewrite package.json so the published tarball uses compiled dist/ paths and the
//    runtime-only export surface.
const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
pkg.exports = {
  '.': './dist/lib/index.js',
  './dialect': './dist/lib/dialect/index.js',
  './integration': './dist/lib/integration/index.js',
  './components': './dist/lib/components/index.js',
  // The injected locale route's entrypoint — resolved by Astro as a file specifier
  // (injectRoute), not through the components barrel. Copied by step 4 above.
  './components/LocaleRoute.astro': './dist/lib/components/LocaleRoute.astro',
  './runtime/localeMiddleware': './dist/lib/runtime/localeMiddleware.js',
};
delete pkg.publishConfig;
pkg.dependencies = { ...pkg.dependencies, 'meno-core': `^${coreVersion}` };

writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');
console.log(`meno-astro: package.json rewritten for publish (meno-core ^${coreVersion})`);
