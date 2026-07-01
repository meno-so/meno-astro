/**
 * Runtime helper for remote-data list nodes (`sourceType: 'remote'`) in the meno-astro
 * dialect — the HTTP-endpoint sibling of `getCollectionList`. The emitter generates:
 *
 *   const marketsList = await getRemoteData("https://api.example.com/markets", { path, sort, limit, … }, Astro);
 *   marketsList.map((item, itemIndex) => ( … ))
 *
 * It fetches the endpoint at build/SSR time, navigates `query.path` to the items array,
 * synthesizes an `_id` per item, then applies the SAME query semantics (filter/sort/limit/
 * offset) as collection lists via the shared `queryItems`. Mirrors `getCollectionList`'s
 * graceful failure: any fetch/parse error → `[]` (the list renders empty rather than
 * breaking the build).
 *
 * Like collection items, each returned item is a plain object whose fields sit at the top
 * level, so the emitted child template binds them directly (`item.name`, `item._id`, …).
 * Unlike collections there is no `urlPattern`, so no `_url` is synthesized — a remote item
 * typically carries its own link field.
 */

import { queryItems, type CollectionListQuery } from './collectionList';

type Item = Record<string, unknown>;

export interface RemoteDataQuery extends CollectionListQuery {
  /** Dot-path into the JSON response to the items array (e.g. "data.items"); empty = the response is the array. */
  path?: string;
}

interface AstroLike {
  props?: { cms?: { _id?: string } | undefined } & Record<string, unknown>;
}

/** Follow a dot-path (`"data.items"`) into a parsed JSON value; `''`/absent returns it unchanged. */
function navigatePath(value: unknown, path?: string): unknown {
  if (!path) return value;
  let cur = value;
  for (const seg of path.split('.')) {
    if (cur && typeof cur === 'object') cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  return cur;
}

/**
 * Fetch a public HTTP/JSON endpoint and resolve it to a queried item array. `query.path`
 * locates the items array in the response; filter/sort/limit/offset are applied by the shared
 * `queryItems`. Returns `[]` on any network/parse error or a non-array result.
 */
export async function getRemoteData(url: string, query: RemoteDataQuery = {}, astro?: AstroLike): Promise<Item[]> {
  if (!url || typeof url !== 'string') return [];
  let payload: unknown;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) return [];
    payload = await res.json();
  } catch {
    return [];
  }

  const raw = navigatePath(payload, query.path);
  if (!Array.isArray(raw)) return [];

  // Synthesize a stable `_id` (item's own id/_id, else the index) so cards binding `{{item._id}}`
  // and the client filter's data-id keying resolve. Primitive items are wrapped as `{ _id, value }`.
  const items: Item[] = raw.map((it, i) => {
    if (it && typeof it === 'object' && !Array.isArray(it)) {
      const rec = it as Item;
      const id = rec._id ?? rec.id ?? i;
      return { ...rec, _id: String(id) };
    }
    return { _id: String(i), value: it };
  });

  return queryItems(items, query, astro);
}
