/**
 * Per-file parsed-model cache for the dev/play server's whole-project scans.
 *
 * Two hot paths re-parse EVERY `.astro` under `<root>/src` through the dialect codec:
 * the utility-sheet `rebuild()` (runs on every `.astro` edit, awaited BEFORE the play
 * patch is broadcast) and the play patch's class-vocabulary scan (recomputed after any
 * structural/style edit). On a mid-sized project (~130 files) that is tens of
 * milliseconds of parsing per edit, on the same event loop the SSR render the play
 * bridge immediately re-fetches runs on — the parse storm is what inflated post-edit
 * renders ~10× (45ms → ~550ms measured). Both paths now share this cache, so an edit
 * re-parses exactly the changed file(s).
 *
 * Invalidation is by CONTENT comparison: every sweep re-reads each file and re-parses
 * only when the source string differs from the cached one. Reading beats stat-based
 * invalidation here for two reasons: mtime+size misses a same-length value tweak
 * (`40px` → `23px`) written within one mtime tick — exactly the shape of rapid editor
 * saves — and coarse-mtime filesystems (FAT, some network mounts) would widen that
 * hole further. The read sweep is ~2ms for a 130-file project vs ~40ms of parsing,
 * so the dominant cost still disappears, exactly, on every filesystem.
 *
 * An unparseable file caches its failure (model `null`) and emits the standard skip
 * warning ONCE per file version instead of on every rebuild — same signal, no spam.
 * Deleted files drop out of the walk and are pruned from the cache each sweep.
 *
 * Memory: sources + models for every project `.astro` stay resident (roughly a few ×
 * total source size; the play patch's own sourceCache already retains the sources).
 * This is a dev-server-only module — the one-shot `astro build` path populates it
 * once and exits — so the trade is deliberate.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../dialect';
import { collectModelClassTokens, walkAstroFiles, warnUnparseableUtilitySource } from './utilityCss';

interface CacheEntry {
  /** The exact source the entry was parsed from — the invalidation key. */
  src: string;
  /** Parsed model, or `null` when this file version failed to parse (already warned). */
  model: unknown | null;
  /** Lazily computed {@link collectModelClassTokens} of `model`; invalidated with the entry. */
  tokens?: Set<string>;
}

/** projectRoot → (absolute file path → entry). */
const caches = new Map<string, Map<string, CacheEntry>>();

/** Drop cached models — for one project root, or all (tests). */
export function clearModelCache(projectRoot?: string): void {
  if (projectRoot === undefined) caches.clear();
  else caches.delete(projectRoot);
}

/**
 * Sweep `<projectRoot>/src` and return the up-to-date cache: read every `.astro`,
 * (re)parse only new/changed sources, prune deleted files. Unparseable files stay
 * in the map with `model: null` so they aren't re-parsed (and re-warned) every
 * sweep. A missing/unreadable `src` yields an empty map — same as the old full scan.
 */
function sweep(projectRoot: string): Map<string, CacheEntry> {
  let cache = caches.get(projectRoot);
  if (!cache) {
    cache = new Map();
    caches.set(projectRoot, cache);
  }
  const seen = new Set<string>();
  try {
    walkAstroFiles(join(projectRoot, 'src'), (path) => {
      seen.add(path);
      let src: string;
      try {
        src = readFileSync(path, 'utf8');
      } catch {
        return; // vanished mid-walk → treat as absent this sweep
      }
      const prev = cache.get(path);
      if (prev && prev.src === src) return;
      let model: unknown | null = null;
      try {
        model = parse(src).model;
      } catch (err) {
        warnUnparseableUtilitySource(path, err);
      }
      cache.set(path, { src, model });
    });
  } catch {
    /* no src dir → empty result */
  }
  for (const path of cache.keys()) {
    if (!seen.has(path)) cache.delete(path);
  }
  return cache;
}

/** Every parseable project `.astro`'s model, freshly synced with the file system. */
export function getProjectModels(projectRoot: string): unknown[] {
  const models: unknown[] = [];
  for (const entry of sweep(projectRoot).values()) {
    if (entry.model !== null) models.push(entry.model);
  }
  return models;
}

/**
 * The project-wide class vocabulary — {@link collectModelClassTokens} unioned over
 * every parseable file, with the per-file token sets cached alongside the models
 * (a file's tokens only recompute when the file itself re-parses).
 */
export function getProjectClassTokens(projectRoot: string): Set<string> {
  const out = new Set<string>();
  for (const entry of sweep(projectRoot).values()) {
    if (entry.model === null) continue;
    if (!entry.tokens) entry.tokens = collectModelClassTokens(entry.model);
    for (const t of entry.tokens) out.add(t);
  }
  return out;
}
