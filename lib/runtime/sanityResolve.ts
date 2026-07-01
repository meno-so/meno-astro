/**
 * Sanity value resolution — turns the RAW shapes a `*[_type=="x"]` query returns into values a
 * Meno binding can actually render. Without this, real Sanity schemas show `[object Object]`:
 *
 *   - slug   `{ _type:'slug', current }`                 → the `current` string
 *   - image  `{ _type:'image', asset:{ _ref } }`         → the cdn.sanity.io URL (deterministic
 *            file `{ _type:'file', asset:{ _ref } }`        from the ref + projectId/dataset, no fetch)
 *   - Portable Text  `[{ _type:'block', … }, …]`         → an HTML string (@portabletext/to-html)
 *   - reference `{ _ref, _type:'reference' }`            → the referenced document, inlined ONE
 *            level deep via a single batched `*[_id in [...]]` query (author/category joins)
 *
 * Split into a SYNC `resolveScalars` (slug/image/file/Portable Text — runs before queryItems so
 * filter/sort see flattened scalars) and an ASYNC `dereference` (the reference round-trip — runs
 * AFTER queryItems so only rendered items pay for it). Both are deep + tolerant: anything they
 * can't resolve (an unknown ref id behind RLS, a malformed asset) is left as-is, never thrown.
 */

import { toHTML } from '@portabletext/to-html';

type Item = Record<string, unknown>;
interface Conn {
  projectId: string;
  dataset: string;
}

/**
 * A Sanity asset `_ref` → its cdn.sanity.io URL (deterministic; no API call needed):
 *   `image-<id>-<w>x<h>-<ext>` → `…/images/<pid>/<ds>/<id>-<w>x<h>.<ext>`
 *   `file-<id>-<ext>`          → `…/files/<pid>/<ds>/<id>.<ext>`
 * Returns null for an unrecognized ref shape.
 */
export function assetRefToUrl(projectId: string, dataset: string, ref: string): string | null {
  const m = /^(image|file)-(.+)-([a-z0-9]+)$/i.exec(ref);
  if (!m) return null;
  const [, kind, idAndDims, ext] = m;
  const base = kind === 'image' ? 'images' : 'files';
  return `https://cdn.sanity.io/${base}/${projectId}/${dataset}/${idAndDims}.${ext}`;
}

/** A value is Portable Text when it's an array carrying at least one `_type:'block'` item. */
function isPortableText(v: unknown): v is unknown[] {
  return (
    Array.isArray(v) &&
    v.some((b) => b !== null && typeof b === 'object' && (b as { _type?: unknown })._type === 'block')
  );
}

function portableTextToHtml(blocks: unknown[]): string {
  try {
    return toHTML(blocks as Parameters<typeof toHTML>[0]);
  } catch {
    return '';
  }
}

/**
 * Recursively resolve slug/image/file/Portable Text in a value. Reference objects are LEFT intact
 * (handled by `dereference`). Pure + synchronous.
 */
export function resolveScalars(conn: Conn, value: unknown): unknown {
  if (Array.isArray(value)) {
    if (isPortableText(value)) return portableTextToHtml(value);
    return value.map((v) => resolveScalars(conn, v));
  }
  if (value !== null && typeof value === 'object') {
    const o = value as Item;
    if (o._type === 'slug' && typeof o.current === 'string') return o.current;
    if (o._type === 'reference') return o; // deferred to dereference()
    if ((o._type === 'image' || o._type === 'file') && o.asset && typeof o.asset === 'object') {
      const ref = (o.asset as { _ref?: unknown })._ref;
      const url = typeof ref === 'string' ? assetRefToUrl(conn.projectId, conn.dataset, ref) : null;
      if (url) return url;
    }
    const out: Item = {};
    for (const [k, v] of Object.entries(o)) out[k] = resolveScalars(conn, v);
    return out;
  }
  return value;
}

/** Collect every `{ _type:'reference', _ref }` id reachable in a value. */
function collectRefIds(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) collectRefIds(v, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    const o = value as Item;
    if (o._type === 'reference' && typeof o._ref === 'string') {
      out.add(o._ref);
      return;
    }
    for (const v of Object.values(o)) collectRefIds(v, out);
  }
}

/** Replace each reference object with its resolved doc from `byId` (left intact when unresolved). */
function applyRefs(value: unknown, byId: Map<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((v) => applyRefs(v, byId));
  if (value !== null && typeof value === 'object') {
    const o = value as Item;
    if (o._type === 'reference' && typeof o._ref === 'string') {
      return byId.has(o._ref) ? byId.get(o._ref) : value;
    }
    const out: Item = {};
    for (const [k, v] of Object.entries(o)) out[k] = applyRefs(v, byId);
    return out;
  }
  return value;
}

/**
 * Inline referenced documents ONE level deep. Collects every `_ref` across `items`, fetches them
 * in a single `*[_id in [...]]` query via `fetchResult` (returns the `.result` array, or null),
 * scalar-resolves each, and substitutes them in. Items with no refs (or when the fetch fails) pass
 * through unchanged. The resolved docs are NOT themselves dereferenced (one level — avoids cycles).
 */
export async function dereference<T extends Item>(
  conn: Conn,
  items: T[],
  fetchResult: (groqQuery: string) => Promise<unknown>,
): Promise<T[]> {
  const ids = new Set<string>();
  for (const it of items) collectRefIds(it, ids);
  if (ids.size === 0) return items;

  const byId = new Map<string, unknown>();
  const list = [...ids].map((id) => JSON.stringify(id)).join(',');
  const docs = await fetchResult(`*[_id in [${list}]]`);
  if (Array.isArray(docs)) {
    for (const d of docs) {
      if (d !== null && typeof d === 'object' && typeof (d as Item)._id === 'string') {
        byId.set((d as Item)._id as string, resolveScalars(conn, d));
      }
    }
  }
  if (byId.size === 0) return items;
  return items.map((it) => applyRefs(it, byId) as T);
}
