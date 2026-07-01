#!/usr/bin/env node
/**
 * Restore the pristine package.json after publish (postpublish hook).
 * build-for-publish.mjs saved it to package.json.bak before rewriting for the
 * tarball; packages/astro is untracked so we can't `git checkout` it back.
 */
import { existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const backupPath = join(pkgRoot, 'package.json.bak');
const pkgJsonPath = join(pkgRoot, 'package.json');

if (existsSync(backupPath)) {
  renameSync(backupPath, pkgJsonPath);
  console.log('meno-astro: restored pristine package.json');
} else {
  console.log('meno-astro: no package.json.bak to restore (nothing to do)');
}
