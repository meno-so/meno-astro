/**
 * Runtime helper for Sanity-backed list nodes (`sourceType: 'sanity'`) in the meno-astro
 * dialect — the GROQ sibling of `getRemoteData` (`./remoteData.ts`). The emitter generates:
 *
 *   const postList = await getSanityData("post", { sort, filter, limit, … }, Astro);
 *   postList.map((item, itemIndex) => ( … ))
 *
 * The Sanity connection (projectId/dataset/apiVersion/useCdn) is NOT baked into the call —
 * it is read at build/SSR from the project's `project.config.json` via `loadSanityConfig`
 * (`process.cwd()`, the same contract as `getCollectionList`'s `resolveCmsItemUrls`). This
 * keeps the emitted `.astro` portable (no project id committed into the page) and lets the
 * user change datasets in settings without re-converting.
 *
 * Read-only, PUBLIC datasets only: an anonymous `fetch` of Sanity's query API
 * (`*[_type == "<documentType>"]`), no auth header. Sanity wraps the rows in `{ result: [] }`,
 * so items are read from `payload.result` (unlike `getRemoteData`'s top-level array).
 * Each row is run through `resolveScalars` (`./sanityResolve`) so real schemas render instead of
 * `[object Object]`: slug → string, image/file asset → cdn URL, Portable Text → HTML; references
 * are then inlined one level by `dereference` (a single batched join). Sanity's native `_id` is
 * kept; query semantics (filter/sort/limit/offset) reuse the shared `queryItems`. Mirrors
 * `getRemoteData`'s graceful failure: any missing config / fetch / parse error → `[]`.
 */

import { queryItems, type CollectionListQuery } from './collectionList';
import { loadSanityConfig, type SanityRuntimeConfig } from '../server/loadSanityConfig';
import { resolveScalars, dereference } from './sanityResolve';

type Item = Record<string, unknown>;

/** A Sanity list query — the shared collection-list semantics; no `path` (Sanity is always `.result`). */
export type SanityDataQuery = CollectionListQuery;

interface AstroLike {
  props?: { cms?: { _id?: string } | undefined } & Record<string, unknown>;
}

/**
 * Build a Sanity query-API URL from the resolved connection + a GROQ query string. Uses the
 * cached `apicdn` host when `useCdn` (default), else the fresh `api` host. The whole GROQ
 * query is URL-encoded (it contains `*`, `[`, `]`, `==`, `"`). Exported so the editor's
 * discovery routes build the SAME URL as the build, keeping preview and output in lockstep.
 */
export function buildSanityQueryUrl(cfg: SanityRuntimeConfig, groqQuery: string): string {
  const host = cfg.useCdn ? 'apicdn' : 'api';
  const version = cfg.apiVersion.replace(/^v/, '');
  return `https://${cfg.projectId}.${host}.sanity.io/v${version}/data/query/${cfg.dataset}?query=${encodeURIComponent(groqQuery)}`;
}

/** Fetch a GROQ query and return its `.result` array (or null on any error). Shared with `dereference`. */
export async function fetchSanityResult(cfg: SanityRuntimeConfig, groqQuery: string): Promise<unknown> {
  try {
    const res = await fetch(buildSanityQueryUrl(cfg, groqQuery), { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    return ((await res.json()) as { result?: unknown } | null)?.result ?? null;
  } catch {
    return null;
  }
}

/**
 * Fetch a public Sanity document type and resolve it to a queried item array. The connection
 * is read from `project.config.json` (`loadSanityConfig`); a missing/invalid config returns
 * `[]`. filter/sort/limit/offset are applied by the shared `queryItems`. Returns `[]` on any
 * network/parse error or a non-array `result`.
 */
export async function getSanityData(
  documentType: string,
  query: SanityDataQuery = {},
  astro?: AstroLike,
): Promise<Item[]> {
  if (!documentType || typeof documentType !== 'string') return [];
  const cfg = loadSanityConfig(process.cwd());
  if (!cfg) return [];

  // GROQ string literal via JSON.stringify (correct quoting/escaping of the type name).
  const raw = await fetchSanityResult(cfg, `*[_type == ${JSON.stringify(documentType)}]`);
  if (!Array.isArray(raw)) return [];

  // Keep Sanity's native `_id`; resolveScalars flattens slug / turns image+file assets into cdn
  // URLs / serializes Portable Text — BEFORE queryItems so filter/sort see scalar values.
  const items: Item[] = raw.map((it, i) => {
    if (it && typeof it === 'object' && !Array.isArray(it)) {
      const rec = resolveScalars(cfg, it) as Item;
      return { ...rec, _id: String(rec._id ?? i) };
    }
    return { _id: String(i), value: it };
  });

  // dereference (the reference→document join) runs AFTER queryItems so only the rendered subset
  // pays for the extra batched fetch.
  const queried = queryItems(items, query, astro);
  return dereference(cfg, queried, (q) => fetchSanityResult(cfg, q));
}
