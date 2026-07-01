/**
 * Runtime helper for SSR pages (`meta.source === 'ssr'`) — the page-scope sibling of
 * `getRemoteData` (`./remoteData.ts`). The emitter generates one call per SSR page:
 *
 *   const { repo, user } = await loadPageData(meta.data, Astro);
 *
 * For each named source in `config.sources` it interpolates request inputs into the URL +
 * headers, fetches the endpoint at request time, navigates `path` into the payload, and
 * resolves the source to either:
 *   - an OBJECT (default) augmented with control fields `_ok` / `_error` (so the body's
 *     conditional nodes `{repo._ok && (…)}` / `{repo._error && (…)}` work), or
 *   - a LIST (`cardinality: 'list'`) — the queried item array (delegates to getRemoteData).
 *
 * Never throws: any network/parse failure resolves to `{ _ok: false, _error }` (object) or
 * `[]` (list), so a failed fetch renders the modeled fallback instead of breaking the page.
 *
 * Request-input interpolation (v1): `{{query.<name>}}` (from `Astro.url.searchParams`) and
 * `{{params.<name>}}` (dynamic-route segments). Values are URL-encoded when interpolated into
 * a URL and CR/LF-stripped when interpolated into a header (injection guards). `{{env.<name>}}`
 * secret resolution is a follow-up (see docs/meno-astro-ssr-page-type.md §8/§9).
 */

import { getRemoteData } from './remoteData';

/** Minimal shape of a single declarative data source (mirrors meno-core's PageDataSource). */
export interface PageDataSourceLike {
  type?: 'fetch';
  url: string;
  method?: 'GET';
  headers?: Record<string, string>;
  path?: string;
  cardinality?: 'object' | 'list';
}

export interface PageDataConfigLike {
  sources?: Record<string, PageDataSourceLike>;
}

interface AstroLike {
  params?: Record<string, string | undefined>;
  url?: URL;
  request?: Request;
}

type Resolved = Record<string, unknown> | unknown[];

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

const TEMPLATE_RE = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Read a server env var host-agnostically (Node/Bun, and Cloudflare under nodejs_compat). */
function readEnv(key: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.[key];
}

/**
 * Resolve a `<scope>.<key>` reference to its string value, or undefined when unresolved.
 * `env.*` resolves to a server secret and ALWAYS yields a string (missing → '') so a header
 * never ships the literal `{{env.X}}`; `params`/`query` yield undefined when absent (the
 * `{{…}}` is left intact in a URL — a fixed segment the author can still see).
 */
function lookupRequestInput(ref: string, astro: AstroLike): string | undefined {
  const dot = ref.indexOf('.');
  if (dot < 0) return undefined;
  const scope = ref.slice(0, dot);
  const key = ref.slice(dot + 1);
  if (scope === 'params') return astro.params?.[key] ?? undefined;
  if (scope === 'query') return astro.url?.searchParams.get(key) ?? undefined;
  if (scope === 'env') return readEnv(key) ?? '';
  return undefined; // unknown scope left intact
}

/**
 * The author-fixed origin of a source URL — the origin of everything before the first `{{…}}`
 * placeholder. `null` when there is no parseable static origin (a relative or fully-templated
 * URL), in which case the origin-lock is skipped (the author opted into a dynamic origin).
 */
function staticOrigin(template: string): string | null {
  const idx = template.indexOf('{{');
  const prefix = idx < 0 ? template : template.slice(0, idx);
  try {
    return new URL(prefix).origin;
  } catch {
    return null;
  }
}

/** Interpolate `{{query.q}}`/`{{params.x}}` into a URL, URL-encoding each value. */
function interpolateUrl(template: string, astro: AstroLike): string {
  return template.replace(TEMPLATE_RE, (whole, ref: string) => {
    const v = lookupRequestInput(ref, astro);
    return v === undefined ? whole : encodeURIComponent(v);
  });
}

/** Interpolate into a header value, stripping CR/LF (header-injection guard). */
function interpolateHeader(template: string, astro: AstroLike): string {
  return template.replace(TEMPLATE_RE, (whole, ref: string) => {
    const v = lookupRequestInput(ref, astro);
    return v === undefined ? whole : v.replace(/[\r\n]/g, '');
  });
}

function interpolateHeaders(headers: Record<string, string> | undefined, astro: AstroLike): Record<string, string> {
  const out: Record<string, string> = { accept: 'application/json' };
  if (headers) for (const [k, v] of Object.entries(headers)) out[k] = interpolateHeader(String(v), astro);
  return out;
}

/** Resolve one source to an object (`_ok`/`_error`) or a list (`cardinality: 'list'`). */
async function loadOne(src: PageDataSourceLike, astro: AstroLike): Promise<Resolved> {
  const url = interpolateUrl(src.url ?? '', astro);
  const isList = src.cardinality === 'list';

  // SSRF origin-lock: a request input must never change the URL's origin. URL-encoding already
  // prevents it (an injected `://`/`/` is escaped), but assert it explicitly as defense in depth.
  // Skipped when the author wrote a fully-dynamic/relative URL (no static origin).
  const lockedOrigin = staticOrigin(src.url ?? '');
  if (lockedOrigin) {
    let finalOrigin: string | null = null;
    try {
      finalOrigin = new URL(url).origin;
    } catch {
      /* unparseable final URL */
    }
    if (finalOrigin !== lockedOrigin) {
      return isList ? [] : { _ok: false, _error: 'blocked: data source URL origin changed' };
    }
  }

  if (isList) {
    // The item array; query semantics (path/filter/sort/limit) handled by getRemoteData. No
    // `astro` arg — its only use is excludeCurrentItem (`astro.props.cms`), N/A at page level.
    return getRemoteData(url, { path: src.path });
  }

  if (!url) return { _ok: false, _error: 'missing url' };
  try {
    const res = await fetch(url, { headers: interpolateHeaders(src.headers, astro) });
    if (!res.ok) return { _ok: false, _error: `HTTP ${res.status} ${res.statusText}`.trim() };
    const payload = navigatePath(await res.json(), src.path);
    if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) {
      return { _ok: false, _error: 'response is not an object' };
    }
    return { ...(payload as Record<string, unknown>), _ok: true, _error: null };
  } catch (e) {
    return { _ok: false, _error: e instanceof Error ? e.message : 'fetch failed' };
  }
}

/**
 * Resolve every source in `config.sources` (concurrently) to a name→value map the emitted
 * `const { … } = await loadPageData(meta.data, Astro)` destructures. Tolerates a missing/empty
 * config (returns `{}`), so a malformed model degrades to an empty scope rather than throwing.
 */
export async function loadPageData(
  config: PageDataConfigLike | null | undefined,
  astro?: AstroLike,
): Promise<Record<string, Resolved>> {
  const sources = config?.sources;
  if (!sources || typeof sources !== 'object') return {};
  const ctx: AstroLike = astro ?? {};
  const entries = Object.entries(sources);
  const resolved = await Promise.all(entries.map(([, src]) => loadOne(src, ctx)));
  const out: Record<string, Resolved> = {};
  entries.forEach(([name], i) => {
    const value = resolved[i];
    if (value === undefined) return;
    out[name] = value;
  });
  return out;
}
