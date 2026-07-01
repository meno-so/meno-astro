/**
 * meno-astro/server — `loadAstroConfigExtras`.
 *
 * Reads a converted project's `project.config.json` and maps a handful of Meno settings
 * onto the corresponding **Astro config** options, which the `meno()` integration applies
 * via `updateConfig` in `astro:config:setup`:
 *
 *   - `redirects`     — a Meno `[{ from, to, status? }]` table → Astro's `redirects` map
 *                       (`{ '/old': '/new' }` or `{ '/old': { status, destination } }`).
 *   - `image.domains` — allowed remote image hosts → Astro's `image.domains`, which is what
 *                       makes the optimizing `<Image>` (our `<MenoImage>` wrapper) actually
 *                       process a remote `https://…` source instead of passing it through.
 *   - `prefetch`      — Meno's existing `PrefetchConfig` (`{ enabled, defaultStrategy }`) →
 *                       Astro's native `prefetch` (`{ prefetchAll, defaultStrategy }`); the
 *                       strategy names line up 1:1 (hover/tap/viewport/load).
 *   - `devToolbar`    — a boolean → Astro's `devToolbar: { enabled }`.
 *
 * Only keys actually present in the config are returned, so the integration never clobbers
 * an option the project didn't set. Missing file / bad JSON degrade to `{}` (the
 * `loadIconsConfig`/`loadSiteUrl` convention — a project must always build). Mtime-memoized;
 * read once at `astro:config:setup` (the config is frozen for the dev session, re-read on the
 * project.config.json watch-file restart).
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isAstroAdapter, type AstroAdapter } from './adapters';

type PrefetchStrategy = 'hover' | 'tap' | 'viewport' | 'load';

export interface AstroConfigExtras {
  redirects?: Record<string, string | { status: number; destination: string }>;
  image?: { domains: string[] };
  prefetch?: { prefetchAll?: boolean; defaultStrategy?: PrefetchStrategy };
  devToolbar?: { enabled: boolean };
  /**
   * Astro output mode. `'server'` opts the project into SSR (an adapter is then required);
   * `'static'` (the default — omitted here) keeps the fully-prerendered build. Astro 5+
   * merged the old `'hybrid'` into `'server'` + per-route `export const prerender`, so a
   * legacy `'hybrid'` is mapped to `'server'`.
   */
  output?: 'static' | 'server';
  /**
   * The SSR adapter the project deploys with (only meaningful when `output: 'server'`). The
   * `meno()` integration resolves `@astrojs/<name>` from the provisioned store and registers
   * it; the project's astro.config never imports it. `node` carries a `mode`.
   */
  adapter?: { name: AstroAdapter; mode?: 'standalone' | 'middleware' };
}

const cache = new Map<string, { mtimeMs: number; extras: AstroConfigExtras }>();
const STRATEGIES = new Set<PrefetchStrategy>(['hover', 'tap', 'viewport', 'load']);

/** Map a Meno `[{ from, to, status? }]` redirect table → Astro's `redirects` config map. */
function pickRedirects(raw: unknown): AstroConfigExtras['redirects'] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const map: Record<string, string | { status: number; destination: string }> = {};
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const { from, to, status } = r as { from?: unknown; to?: unknown; status?: unknown };
    if (typeof from !== 'string' || typeof to !== 'string' || from.trim() === '' || to.trim() === '') continue;
    // A non-permanent status carries the object form; a plain 301 is the bare string.
    map[from] = typeof status === 'number' && status !== 301 ? { status, destination: to } : to;
  }
  return Object.keys(map).length ? map : undefined;
}

/** Allowed remote image hosts (`image.domains`) — drops empties. */
function pickImageDomains(raw: unknown): string[] | undefined {
  const domains = (raw as { domains?: unknown } | undefined)?.domains;
  if (!Array.isArray(domains)) return undefined;
  const hosts = domains.filter((d): d is string => typeof d === 'string' && d.trim() !== '');
  return hosts.length ? hosts : undefined;
}

/** Meno PrefetchConfig → Astro `prefetch` (names align; only when enabled). */
function pickPrefetch(raw: unknown): AstroConfigExtras['prefetch'] | undefined {
  const p = raw as { enabled?: unknown; defaultStrategy?: unknown } | undefined;
  if (p?.enabled !== true) return undefined;
  const s = p.defaultStrategy;
  const defaultStrategy =
    typeof s === 'string' && STRATEGIES.has(s as PrefetchStrategy) ? (s as PrefetchStrategy) : 'hover';
  return { prefetchAll: true, defaultStrategy };
}

/** `devToolbar` boolean (or `{ enabled }`) → Astro's `devToolbar: { enabled }`. */
function pickDevToolbar(raw: unknown): AstroConfigExtras['devToolbar'] | undefined {
  if (raw === true) return { enabled: true };
  if (raw === false) return { enabled: false };
  if (raw && typeof raw === 'object' && typeof (raw as { enabled?: unknown }).enabled === 'boolean') {
    return { enabled: (raw as { enabled: boolean }).enabled };
  }
  return undefined;
}

/** `output` mode — `'server'`/`'hybrid'` ⇒ SSR; anything else stays static (undefined). */
function pickOutput(raw: unknown): 'static' | 'server' | undefined {
  if (raw === 'server' || raw === 'hybrid') return 'server'; // Astro 5+ folds hybrid into server
  if (raw === 'static') return 'static';
  return undefined;
}

/** Adapter selection — a bare `"node"` string or `{ name, mode }`; unknown names drop. */
function pickAdapter(raw: unknown): AstroConfigExtras['adapter'] | undefined {
  const name =
    typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? (raw as { name?: unknown }).name : undefined;
  if (typeof name !== 'string' || !isAstroAdapter(name)) return undefined;
  const adapter: NonNullable<AstroConfigExtras['adapter']> = { name };
  const mode = (raw as { mode?: unknown })?.mode;
  if (name === 'node' && (mode === 'standalone' || mode === 'middleware')) adapter.mode = mode;
  return adapter;
}

function pickExtras(cfg: Record<string, unknown>): AstroConfigExtras {
  const out: AstroConfigExtras = {};
  const redirects = pickRedirects(cfg.redirects);
  if (redirects) out.redirects = redirects;
  const domains = pickImageDomains(cfg.image);
  if (domains) out.image = { domains };
  const prefetch = pickPrefetch(cfg.prefetch);
  if (prefetch) out.prefetch = prefetch;
  const devToolbar = pickDevToolbar(cfg.devToolbar);
  if (devToolbar) out.devToolbar = devToolbar;
  // SSR opt-in: only surface `output: 'server'` together with a resolvable adapter — server
  // output with no adapter would hard-fail `astro build`, so we keep it static instead.
  const output = pickOutput(cfg.output);
  const adapter = pickAdapter(cfg.adapter);
  if (output === 'server' && adapter) {
    out.output = 'server';
    out.adapter = adapter;
  }
  return out;
}

/**
 * Load the Astro-config extras for the project rooted at `projectRoot`. Never throws —
 * a missing/unreadable config returns `{}` (the integration then applies nothing).
 */
export function loadAstroConfigExtras(projectRoot: string): AstroConfigExtras {
  try {
    const cfgPath = join(projectRoot, 'project.config.json');
    const { mtimeMs } = statSync(cfgPath); // throws when missing → {} below
    const cached = cache.get(projectRoot);
    if (cached && cached.mtimeMs === mtimeMs) return cached.extras;
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>;
    const extras = pickExtras(parsed);
    cache.set(projectRoot, { mtimeMs, extras });
    return extras;
  } catch {
    return {};
  }
}
