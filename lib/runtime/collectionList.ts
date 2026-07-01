/**
 * Runtime helper for CMS list nodes (`sourceType: 'collection'`) in the meno-astro
 * dialect. The emitter generates:
 *
 *   const blogList = await getCollectionList("blog", { sort, filter, limit, … }, Astro);
 *   blogList.map((blog, blogIndex) => ( … ))
 *
 * It pulls the collection's items from Astro's content layer (`astro:content`
 * `getCollection`) and applies the same query semantics as the JSON runtime's
 * `CMSService.queryItems` / `getItemsByIds` (mirrored here so both render the same
 * lists). Each returned item is the raw stored JSON (`entry.data`) — the converter
 * writes items with a permissive `z.record(z.string(), z.any())` schema, so `_id`,
 * `_createdAt`, and all fields sit at the top level, exactly as the emitted child
 * template expects (`blog.title`, `blog._createdAt`, …).
 *
 * `astro:content`'s `getCollection` is passed IN by the calling page (which lives in
 * the host Astro project where the virtual module resolves natively). meno-astro never
 * imports `astro:content` itself — doing so from inside node_modules both breaks
 * non-Astro loaders (tooling/tests) and corrupts Astro's generated content module.
 *
 * Each returned item also gets the computed `_url`/`_id` system fields a list card binds to
 * (`{{item._url}}`) synthesized by `resolveCmsItemUrls` — meno-core's renderer added these
 * (`addItemUrls`) before rendering, so the astro runtime mirrors it or every card link
 * collapses to its component default.
 */

import { resolveCmsItemUrls } from '../server/loadCmsSlugMappings';

type GetCollection = (name: string) => Promise<Array<{ id?: string; data: Record<string, unknown> }>>;

type Item = Record<string, unknown>;
type SortConfig = { field: string; order?: 'asc' | 'desc' };
type FilterCondition = { field: string; operator?: string; value?: unknown };

export interface CollectionListQuery {
  filter?: FilterCondition | FilterCondition[] | Record<string, unknown>;
  sort?: SortConfig | SortConfig[];
  limit?: number;
  offset?: number;
  /** Explicit id/filename list (reference fields) — preserves the given order. */
  items?: string[] | string;
  /** Drop the current page's CMS item (for related-item lists on template routes). */
  excludeCurrentItem?: boolean;
  /** Emit-only hint; unused at runtime. */
  emitTemplate?: unknown;
}

interface AstroLike {
  props?: { cms?: { _id?: string } | undefined } & Record<string, unknown>;
}

/**
 * Resolve a CMS collection list to its items, applying the node's query. `getCollection`
 * is the host project's `astro:content` export, passed by the emitted page.
 */
export async function getCollectionList(
  source: string,
  query: CollectionListQuery = {},
  astro?: AstroLike,
  getCollection?: GetCollection,
): Promise<Item[]> {
  if (typeof getCollection !== 'function') return [];
  let entries: Array<{ id?: string; data: Item }>;
  try {
    entries = await getCollection(source);
  } catch {
    // No such collection → empty list (matches the SSR fallback).
    return [];
  }

  // Attach the computed `_url`/`_id` a card binds to (`{{item._url}}`); filter/sort below
  // still operate on the stored fields. cwd = the host project root during astro dev/build.
  const items: Item[] = resolveCmsItemUrls(process.cwd(), source, entries);

  return queryItems(items, query, astro);
}

/**
 * Apply a collection query (filter/sort/offset/limit, or an explicit `items` id list, plus
 * `excludeCurrentItem`) to an ALREADY-FETCHED item array. Shared by `getCollectionList`
 * (post-fetch) and `queryList` (below). `items` are expected to already carry the computed
 * `_url`/`_id` system fields (synthesized by `getCollectionList`).
 */
export function queryItems(items: Item[], query: CollectionListQuery = {}, astro?: AstroLike): Item[] {
  let out = items;

  if (query.items !== undefined) {
    // Reference-field path: fetch specific ids in order (match _id or _filename),
    // skipping missing — mirrors CMSService.getItemsByIds.
    const ids = (Array.isArray(query.items) ? query.items : [query.items]).filter(Boolean).map(String);
    const byId = new Map(out.map((i) => [i._id, i]));
    const byFilename = new Map(out.filter((i) => i._filename).map((i) => [i._filename, i]));
    out = ids.map((id) => byId.get(id) ?? byFilename.get(id)).filter((i): i is Item => i !== undefined);
  } else {
    if (query.filter) out = applyFilters(out, query.filter);
    if (query.sort) out = applySorting(out, query.sort);
    if (query.offset !== undefined && query.offset > 0) out = out.slice(query.offset);
    if (query.limit !== undefined && query.limit > 0) out = out.slice(0, query.limit);
  }

  // Exclude the current CMS item (template [slug] pages pass it on Astro.props.cms).
  if (query.excludeCurrentItem) {
    const currentId = astro?.props?.cms?._id;
    if (currentId) out = out.filter((i) => i._id !== currentId);
  }

  return out;
}

/**
 * Query an already-fetched collection array. The emitter generates this for a nested
 * collection list whose query references the OUTER loop variable — e.g. a docs sidebar
 * where each category lists its own docs:
 *
 *   docs_categoriesList.map((category, …) => (
 *     … queryList(docsList, { filter: { field: "category", operator: "eq",
 *                                       value: category._id }, sort: … }).map((doc, …) => …)
 *   ))
 *
 * `docsList` is fetched ONCE in frontmatter (`getCollectionList("docs", Astro, getCollection)`
 * — the whole collection); a hoisted query can't see `category`, so the per-iteration query
 * runs here, where the loop var is in scope. The parser reverses `queryList(<binding>, <query>)`
 * back to the nested collection-list node, so it round-trips.
 */
export function queryList(
  items: Item[] | null | undefined,
  query: CollectionListQuery = {},
  astro?: AstroLike,
): Item[] {
  return queryItems(Array.isArray(items) ? items : [], query, astro);
}

/**
 * Serialize a CMS collection list as the JSON payload for an inline
 * `<script type="application/json" id="meno-cms-<collection>">` block — the data the
 * client-side MenoFilter runtime reads to filter/sort/search/paginate the real items
 * (and to drive facet/total counts), reusing the SSR cards by `data-id`.
 *
 * The emitter wires this into a filter-wired collection list (a list with
 * `emitTemplate: true`): `set:html={serializeClientCmsData(<binding>)}` where `<binding>`
 * is the same `getCollectionList(...)` frontmatter const the SSR cards map over — so the
 * payload carries every item with its synthesized `_url`/`_id` system fields.
 *
 * Every `<` is escaped to `<` (a no-op for JSON.parse, which decodes it back to `<`)
 * so a field value containing the literal text `</script>` can't break out of the inline
 * script tag. Tolerant of a null/non-array binding (renders `[]`).
 */
export function serializeClientCmsData(items: Item[] | null | undefined): string {
  return JSON.stringify(Array.isArray(items) ? items : []).replace(/</g, '\\u003c');
}

// --- filter/sort, ported verbatim from CMSService for identical semantics ---

function isFilterCondition(obj: unknown): obj is FilterCondition {
  return typeof obj === 'object' && obj !== null && 'field' in obj;
}

function applyFilters(items: Item[], filter: FilterCondition | FilterCondition[] | Record<string, unknown>): Item[] {
  // Simple object filter: { featured: true } → equality on every key.
  if (!Array.isArray(filter) && !isFilterCondition(filter)) {
    const entries = Object.entries(filter);
    return items.filter((item) => entries.every(([key, value]) => item[key] === value));
  }
  const conditions = Array.isArray(filter) ? filter : [filter as FilterCondition];
  return items.filter((item) => conditions.every((cond) => matchCondition(item, cond)));
}

function matchCondition(item: Item, condition: FilterCondition): boolean {
  const value = item[condition.field];
  switch (condition.operator || 'eq') {
    case 'eq':
      return value === condition.value;
    case 'neq':
      return value !== condition.value;
    case 'gt':
      return (value as number) > (condition.value as number);
    case 'gte':
      return (value as number) >= (condition.value as number);
    case 'lt':
      return (value as number) < (condition.value as number);
    case 'lte':
      return (value as number) <= (condition.value as number);
    case 'contains':
      return String(value).includes(String(condition.value));
    case 'in':
      return Array.isArray(condition.value) && condition.value.includes(value);
    default:
      return false;
  }
}

function applySorting(items: Item[], sort: SortConfig | SortConfig[]): Item[] {
  const sorts = Array.isArray(sort) ? sort : [sort];
  return [...items].sort((a, b) => {
    for (const s of sorts) {
      const aVal = a[s.field];
      const bVal = b[s.field];
      const isDesc = s.order === 'desc';
      if (typeof aVal === 'boolean' && typeof bVal === 'boolean') {
        if (aVal === bVal) continue;
        return isDesc ? (aVal ? -1 : 1) : aVal ? 1 : -1;
      }
      let result = 0;
      if ((aVal as string | number) < (bVal as string | number)) result = -1;
      else if ((aVal as string | number) > (bVal as string | number)) result = 1;
      if (result !== 0) return isDesc ? -result : result;
    }
    return 0;
  });
}
