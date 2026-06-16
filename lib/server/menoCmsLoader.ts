/**
 * menoCmsLoader — the Astro content-collection loader the generated `content.config.ts`
 * uses for a Meno CMS collection (replaces the bare `glob` loader).
 *
 * It exists to make ONE behaviour possible that `glob` can't: **show unpublished DRAFT
 * edits in dev, but never in production.**
 *   - Published items (`<id>.json`) are always loaded.
 *   - In DEV (`astro dev` / localhost / Meno play) Astro provides a file `watcher`; only
 *     then are DRAFT sidecars (`<id>.draft.json`) merged OVER their published sibling, and
 *     draft-only items (new, never-published) included too. So localhost previews the
 *     unpublished edit the editor just saved, without publishing it.
 *   - In a production `astro build` there is NO watcher → drafts are skipped → only
 *     published content ships. (Astro `preview` serves the built output and never re-runs
 *     loaders, so it inherits the build's published-only set.)
 *
 * Mirrors meno-core CMSService previewMode merge semantics: draft wins by filename stem
 * (`<stem>.draft.json` overrides `<stem>.json`). The collection `schema` still runs via
 * `parseData`, so the same `resolveCmsEntrySlug` transform the generated config declares
 * applies to drafts too.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Loader } from 'astro/loaders';

type LoaderContext = Parameters<Loader['load']>[0];

const DRAFT_SUFFIX = '.draft.json';

export interface MenoCmsLoaderOptions {
  /** Project-root-relative path to the collection's content dir (e.g. `./src/content/posts`). */
  base: string;
}

/** Dirs already wired to the dev watcher, so re-running `load()` doesn't stack listeners. */
const watchedDirs = new Set<string>();

export function menoCmsLoader(options: MenoCmsLoaderOptions): Loader {
  return {
    name: 'meno-cms-loader',
    load: async (ctx: LoaderContext) => {
      const dir = resolveDir(ctx, options.base);
      // Astro only provides a `watcher` while running `astro dev` — never during
      // `astro build`. That is exactly the dev⇔prod line we want drafts gated on.
      const includeDrafts = Boolean(ctx.watcher);
      await syncCollection(ctx, dir, includeDrafts);

      if (ctx.watcher && !watchedDirs.has(dir)) {
        watchedDirs.add(dir);
        const dirPrefix = dir.endsWith(sep) ? dir : dir + sep;
        const reload = (changed: string) => {
          // Re-sync ONLY when a `.json` file inside THIS collection's own dir
          // changes. `ctx.watcher` is the global dev watcher, so it also fires
          // for unrelated writes — crucially Astro's own content-store
          // persistence (`.astro/data-store.json`), which this loader's
          // store.set()/clear() triggers on every sync. Without the dir scope
          // that store write re-enters syncCollection (its filename ends
          // `.json`), which writes the store again → an unbounded content-sync
          // loop: ~96% CPU, constant page reloads, and `.astro/content-assets`
          // rename races from the re-entrant saves. Scoping to `dirPrefix`
          // keeps draft/published edits hot while ignoring the store's own dir.
          const norm = resolve(changed);
          if (norm.endsWith('.json') && norm.startsWith(dirPrefix)) {
            void syncCollection(ctx, dir, true).catch(() => {});
          }
        };
        ctx.watcher.add(dir);
        ctx.watcher.on('add', reload);
        ctx.watcher.on('change', reload);
        ctx.watcher.on('unlink', reload);
      }
    },
  };
}

function resolveDir(ctx: LoaderContext, base: string): string {
  try {
    return resolve(fileURLToPath(ctx.config.root), base);
  } catch {
    return resolve(process.cwd(), base);
  }
}

async function syncCollection(ctx: LoaderContext, dir: string, includeDrafts: boolean): Promise<void> {
  const { store, parseData, generateDigest } = ctx;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    store.clear();
    return;
  }

  // Build a filename-stem → file map: published first, then (dev only) let each draft
  // override its stem and add draft-only stems. Mirrors CMSService previewMode merge.
  const byStem = new Map<string, string>();
  for (const f of files) {
    if (f.endsWith('.json') && !f.endsWith(DRAFT_SUFFIX)) byStem.set(f.slice(0, -'.json'.length), f);
  }
  if (includeDrafts) {
    for (const f of files) {
      if (f.endsWith(DRAFT_SUFFIX)) byStem.set(f.slice(0, -DRAFT_SUFFIX.length), f);
    }
  }

  store.clear();
  for (const [id, file] of byStem) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch {
      continue; // skip a malformed item; keep the rest of the collection
    }
    if (!raw || typeof raw !== 'object') continue;
    const data = (await parseData({ id, data: raw as Record<string, unknown> })) as Record<string, unknown>;
    store.set({ id, data, digest: generateDigest(data) });
  }
}
