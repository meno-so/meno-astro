/**
 * menoCmsLoader — published always; drafts merged over published ONLY in dev (watcher present).
 */
import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { menoCmsLoader } from './menoCmsLoader';

const tmpRoots: string[] = [];
afterEach(() => {
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Build a project root with `src/content/posts/<files>` and return the root + a loader ctx. */
function setup(files: Record<string, unknown>, opts: { dev: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'meno-cms-loader-'));
  tmpRoots.push(root);
  const dir = join(root, 'src', 'content', 'posts');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  }
  const store = new Map<string, Record<string, unknown>>();
  // Record what the loader wires onto the dev watcher so a test can replay
  // change events with arbitrary paths.
  const watch: { added: string[]; handlers: Record<string, (p: string) => void> } = { added: [], handlers: {} };
  const ctx = {
    store: {
      set: ({ id, data }: { id: string; data: Record<string, unknown> }) => (store.set(id, data), true),
      clear: () => store.clear(),
    },
    parseData: async ({ data }: { id: string; data: Record<string, unknown> }) => data,
    generateDigest: (d: unknown) => JSON.stringify(d),
    config: { root: pathToFileURL(root + '/') },
    watcher: opts.dev
      ? {
          add: (p: string) => watch.added.push(p),
          on: (ev: string, cb: (p: string) => void) => {
            watch.handlers[ev] = cb;
          },
        }
      : undefined,
  } as unknown as Parameters<ReturnType<typeof menoCmsLoader>['load']>[0];
  return { store, ctx, root, dir, watch };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe('menoCmsLoader', () => {
  const loader = menoCmsLoader({ base: './src/content/posts' });

  test('production (no watcher): loads published only, ignores drafts', async () => {
    const { store, ctx } = setup(
      {
        'a.json': { _id: 'a', title: 'A published', slug: 'a' },
        'a.draft.json': { _id: 'a', title: 'A DRAFT', slug: 'a' },
        'b.draft.json': { _id: 'b', title: 'B draft-only', slug: 'b' },
      },
      { dev: false },
    );
    await loader.load(ctx);
    expect([...store.keys()].sort()).toEqual(['a']);
    expect(store.get('a')?.title).toBe('A published'); // NOT the draft
  });

  test('dev (watcher present): draft overrides published by stem + draft-only items appear', async () => {
    const { store, ctx } = setup(
      {
        'a.json': { _id: 'a', title: 'A published', slug: 'a' },
        'a.draft.json': { _id: 'a', title: 'A DRAFT', slug: 'a' },
        'b.json': { _id: 'b', title: 'B published', slug: 'b' }, // no draft → stays published
        'c.draft.json': { _id: 'c', title: 'C draft-only', slug: 'c' }, // new unpublished item
      },
      { dev: true },
    );
    await loader.load(ctx);
    expect([...store.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(store.get('a')?.title).toBe('A DRAFT'); // draft wins
    expect(store.get('b')?.title).toBe('B published');
    expect(store.get('c')?.title).toBe('C draft-only');
  });

  test('ids are the filename stem (the Meno CMS item key)', async () => {
    const { store, ctx } = setup({ 'hello-world.json': { _id: 'hello-world', slug: 'hi' } }, { dev: false });
    await loader.load(ctx);
    expect([...store.keys()]).toEqual(['hello-world']);
  });

  test('a malformed item is skipped; the rest of the collection still loads', async () => {
    const { store, ctx } = setup(
      { 'ok.json': { _id: 'ok', slug: 'ok' }, 'bad.json': '{ not valid json' },
      { dev: false },
    );
    await loader.load(ctx);
    expect([...store.keys()]).toEqual(['ok']);
  });

  test("dev watcher re-syncs ONLY for in-dir .json — ignores the store's own .astro writes (infinite-loop regression)", async () => {
    const { store, ctx, root, dir, watch } = setup({ 'a.json': { _id: 'a', slug: 'a' } }, { dev: true });
    await loader.load(ctx);
    expect(store.size).toBe(1); // initial sync
    const reload = watch.handlers.change;
    expect(typeof reload).toBe('function');
    expect(watch.added).toContain(dir);

    // Astro persists the content store to `.astro/data-store.json` after every
    // sync. That path ends in `.json` but is OUTSIDE the collection dir — it
    // must NOT re-trigger a sync, or store.set() → data-store.json write →
    // reload → sync … loops forever (the bug). Cleared store stays cleared.
    store.clear();
    reload(join(root, '.astro', 'data-store.json'));
    await flush();
    expect(store.size).toBe(0);

    // A real edit inside the collection dir DOES re-sync (drafts/published stay hot).
    reload(join(dir, 'a.json'));
    await flush();
    expect(store.size).toBe(1);

    // A non-JSON change inside the dir is ignored too (matches prior behavior).
    store.clear();
    reload(join(dir, 'a.txt'));
    await flush();
    expect(store.size).toBe(0);
  });

  test('missing content dir → empty collection (no throw)', async () => {
    const { store, ctx } = setup({}, { dev: false });
    rmSync(join((ctx as { config: { root: URL } }).config.root.pathname, 'src'), { recursive: true, force: true });
    await loader.load(ctx);
    expect([...store.keys()]).toEqual([]);
  });
});
