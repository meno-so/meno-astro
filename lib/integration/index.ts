/**
 * meno-astro/integration — the `meno()` Astro integration.
 *
 * A converted Meno project's `astro.config.mjs` adds `integrations: [meno()]`. On the
 * `astro:config:setup` hook this integration:
 *   1. maps the project's Meno {@link I18nConfig} (read from `project.config.json`) onto
 *      Astro's native `i18n` routing option via `updateConfig` (`toAstroI18nOptions`), and
 *   2. injects the locale middleware (`addMiddleware`, `order: 'pre'`) that wraps every
 *      page render in `runWithLocale(...)` so `i18n()` calls resolve per locale.
 *
 * The locale → Astro-options **mapping is a pure function** (`toAstroI18nOptions`),
 * unit-tested in isolation. The hook wiring itself (calling `updateConfig` /
 * `addMiddleware`) is thin glue that a real `astro build` validates.
 *
 * ── Typing without the `astro` dependency ──────────────────────────────────────
 * `meno-astro` does not depend on `astro` and no Astro toolchain runs in this package's
 * type-check, so we do not import `AstroIntegration` / `AstroUserConfig` from `astro`
 * (they would not resolve). Instead we type against a **minimal structural slice** of
 * Astro's documented `astro:config:setup` API — `updateConfig`, `addMiddleware`, plus the
 * `i18n` option shape. Astro's real types are assignable to these, so `meno()` is
 * correct-by-design against the documented integration API.
 */

import { readFileSync, writeFileSync, existsSync, statSync, createReadStream, cpSync } from 'node:fs';
import { join, extname, sep, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadI18nConfig } from '../server/loadI18nConfig';
import { loadSiteUrl } from '../server/loadSiteUrl';
import { loadSlugMappings } from '../server/loadSlugMappings';
import { loadAstroConfigExtras } from '../server/loadAstroConfigExtras';
import { loadEnvConfig, buildEnvSchema } from '../server/loadEnvConfig';
import { envField } from 'astro/config';
import { loadSitemapMeta } from '../server/loadSitemapMeta';
import { readScaleConfigSync } from '../server/scaleConfig';
import { readKnownTokensSync } from '../server/tokenConfig';
import { readRemConfigSync } from '../server/remConfig';
import { createRequire } from 'node:module';
import { ISLAND_FRAMEWORK_SPECS } from '../server/islandFrameworks';
import { ASTRO_ADAPTER_SPECS } from '../server/adapters';
import { buildSitemapXml } from './sitemap';
import { buildUtilityStylesheet, walkAstroFiles, type UtilitySource } from './utilityCss';
import { xrayVitePlugin, PLAY_XRAY_BRIDGE_SCRIPT } from './xray';
import { rewriteViewportUnitsInStylesheet } from './viewportUnits';
import { PLAY_DESIGN_BRIDGE_SCRIPT } from './designBridge';
import { playPatchVitePlugin, PLAY_PATCH_BRIDGE_SCRIPT } from './playPatch';
import type { I18nConfig } from 'meno-core/shared';

// ---------------------------------------------------------------------------
// Pure mapping: Meno I18nConfig -> Astro `i18n` routing options.
// ---------------------------------------------------------------------------

/**
 * Astro's `i18n` config option (the slice we set). Mirrors Astro's documented
 * `i18n: { defaultLocale, locales, routing }` shape.
 * @see https://docs.astro.build/en/guides/internationalization/
 */
export interface AstroI18nOptions {
  defaultLocale: string;
  locales: string[];
  routing: {
    /**
     * `false` (our default): the default locale is served *without* a `/<locale>/` prefix
     * (so `/about` is the default-locale page and `/pl/about` is the Polish one). This
     * matches Meno's `buildLocalizedPath`/`extractLocaleFromPath` convention, where the
     * default locale lives at the un-prefixed path.
     */
    prefixDefaultLocale: boolean;
  };
}

/**
 * Map a Meno {@link I18nConfig} to Astro's `i18n` routing options.
 *
 * - `defaultLocale` carries straight through.
 * - `locales` becomes the bare list of locale *codes* (Astro's `i18n.locales` is a
 *   `string[]` of codes; Meno's richer `LocaleConfig` metadata stays in
 *   `project.config.json` for the editor/`LocaleList`).
 * - `routing.prefixDefaultLocale: false` — default locale served un-prefixed (Meno's
 *   path convention). De-duplicates locale codes defensively (Astro rejects duplicates).
 *
 * Pure (no I/O); unit-tested directly.
 */
export function toAstroI18nOptions(config: I18nConfig): AstroI18nOptions {
  const seen = new Set<string>();
  const locales: string[] = [];
  for (const loc of config.locales ?? []) {
    if (loc?.code && !seen.has(loc.code)) {
      seen.add(loc.code);
      locales.push(loc.code);
    }
  }
  // Astro requires defaultLocale to be present in locales; ensure it is even if the
  // project config somehow omitted it from the list.
  if (config.defaultLocale && !seen.has(config.defaultLocale)) {
    locales.unshift(config.defaultLocale);
  }
  return {
    defaultLocale: config.defaultLocale,
    locales,
    routing: { prefixDefaultLocale: false },
  };
}

// ---------------------------------------------------------------------------
// The integration.
// ---------------------------------------------------------------------------

/** The slice of Astro's `astro:config:setup` hook params `meno()` uses. */
interface ConfigSetupParams {
  /**
   * The resolved user config. `root` (a file:// URL) locates project.config.json;
   * `site` tells us whether the user already configured a site origin (we only fill
   * it from the project's `siteUrl` when they haven't — user config wins).
   */
  config?: { root?: URL | string; site?: string };
  /**
   * The Astro CLI command running ('dev' | 'build' | 'preview'). Optional in the
   * slice (older Astro slices in tests may omit it); Astro 5 always provides it.
   * Gates the dev-only morph machinery — a play-mode `astro build` ('preview'
   * play servers) has no HMR socket to morph through.
   */
  command?: 'dev' | 'build' | 'preview';
  /** Shallow-merge a partial config into the user's Astro config. */
  updateConfig: (config: Record<string, unknown>) => void;
  /** Register a middleware module by entrypoint, ordered `pre`/`post` vs user middleware. */
  addMiddleware: (params: { entrypoint: string | URL; order: 'pre' | 'post' }) => void;
  /**
   * Inject a client script into every page (`stage: 'head-inline'`). Optional in the
   * slice (older Astro slices in tests may omit it); Astro 5 always provides it. Typed
   * with the narrowed `'head-inline'` stage — Astro's broader-union function is
   * assignable.
   */
  injectScript?: (stage: 'head-inline', content: string) => void;
  /**
   * Register an extra route by pattern + entrypoint. Optional in the slice (older Astro
   * slices in tests may omit it); Astro 5 always provides it. Used for the locale route
   * (`/[locale]/[...path]`) that serves every page under its non-default-locale URLs.
   */
  injectRoute?: (route: { pattern: string; entrypoint: string | URL; prerender?: boolean }) => void;
  /**
   * Register a file whose changes restart the dev server (Astro re-runs config setup,
   * including this hook). Optional in the slice (older Astro slices in tests may omit
   * it); Astro 5 always provides it. Used for `project.config.json`: everything this
   * hook derives from it — Astro's `i18n` routing options, the `site` origin, and
   * WHETHER the locale route is injected at all — is frozen at setup time, so a config
   * edit (e.g. adding a locale in the editor) would otherwise 404 every new-locale URL
   * until a manual stop/start.
   */
  addWatchFile?: (path: URL | string) => void;
}

/** The slice of Astro's `astro:build:done` hook params `meno()` uses. */
interface BuildDoneParams {
  /** Final build output dir (Astro passes a file:// URL). */
  dir?: URL | string;
  /** Every built page (Astro's documented `{ pathname }[]` shape). Drives sitemap.xml. */
  pages?: Array<{ pathname: string }>;
}

/** The minimal `AstroIntegration` shape `meno()` satisfies (assignable from Astro's type). */
export interface MenoIntegration {
  name: string;
  hooks: {
    'astro:config:setup': (params: ConfigSetupParams) => void;
    'astro:build:done': (params: BuildDoneParams) => void;
  };
}

/** The entrypoint specifier Astro resolves to load the injected locale middleware. */
export const LOCALE_MIDDLEWARE_ENTRYPOINT = 'meno-astro/runtime/localeMiddleware';

/**
 * The injected locale route: serves every regular page AND every published CMS item
 * under its non-default-locale URLs (`/pl/o-nas` → about.astro; `/pl/blog/moj-post` →
 * the `blog/[slug].astro` template with `cms` props — both rendered in the `pl` locale
 * context). The pattern's paths are enumerated by the entrypoint's `getStaticPaths`
 * from each page's `meta.slugs` plus each CMS item's per-locale slugs (see
 * `runtime/localeRoutes.ts` + `server/loadSlugMappings.ts` /
 * `server/loadCmsSlugMappings.ts`); static file routes outrank this dynamic route, so
 * real pages and the CMS templates' own default-locale URLs always win. Injected only
 * for multi-locale projects.
 */
export const LOCALE_ROUTE_PATTERN = '/[locale]/[...path]';
export const LOCALE_ROUTE_ENTRYPOINT = 'meno-astro/components/LocaleRoute.astro';

/**
 * Resolve a project root from the integration's `config.root` (a file:// URL or a path
 * string), falling back to `process.cwd()`. Kept tiny + defensive: any oddity degrades to
 * cwd, which is the Astro project dir during build.
 *
 * Uses `fileURLToPath` (NOT `url.pathname`): pathname is percent-encoded, so a project
 * under a path with spaces (e.g. macOS `~/Library/Application Support/…`) would come back
 * with `%20`, and `<root>/src` then fails `existsSync` — silently emitting NO utility CSS.
 */
function resolveProjectRoot(root: URL | string | undefined): string {
  if (!root) return process.cwd();
  try {
    if (root instanceof URL) return fileURLToPath(root);
    if (typeof root === 'string') {
      return root.startsWith('file:') ? fileURLToPath(root) : root;
    }
  } catch {
    /* fall through */
  }
  return process.cwd();
}

/** The virtual CSS module BaseLayout imports; the plugin resolves it to the built sheet. */
export const UTILITY_CSS_MODULE = 'virtual:meno-utilities.css';

/**
 * Read every `.astro` under `<root>/src` into a {@link UtilitySource} list (each entry
 * carries its path so `buildUtilityStylesheet` can name a file in its skip warning).
 * Pure-ish (filesystem read only); shared by the plugin's `astro build` start and its
 * dev rebuild, and unit-tested directly. A missing/unreadable `src` yields `[]`.
 */
export function collectUtilitySources(projectRoot: string): UtilitySource[] {
  const sources: UtilitySource[] = [];
  const srcDir = join(projectRoot, 'src');
  try {
    if (existsSync(srcDir)) {
      walkAstroFiles(srcDir, (p) => {
        try {
          sources.push({ src: readFileSync(p, 'utf8'), path: p });
        } catch {
          /* skip unreadable */
        }
      });
    }
  } catch {
    /* no src → empty sheet */
  }
  return sources;
}

/**
 * Vite plugin (typed structurally — meno-astro doesn't depend on vite) that builds the
 * project's global utility stylesheet and serves it as a virtual CSS module
 * (`virtual:meno-utilities.css`, imported by BaseLayout). Scans every `.astro` under
 * `<root>/src`, so all components' utility classes + prop-mapping variants are covered
 * (see utilityCss.ts).
 *
 * ── Why this is query-aware (the `astro dev` fix) ─────────────────────────────────
 * In `astro build` the sheet is built once at `buildStart` and bundled. In `astro dev`,
 * Astro collects a page's CSS by crawling the SSR module graph and re-importing each CSS
 * module with an appended `?inline` (sometimes `?direct`/`?used`) query to get its source
 * (see astro's vite-plugin-astro-server `getStylesForURL`). A virtual module whose
 * `resolveId`/`load` only matched the BARE id therefore failed that `?inline` re-import,
 * so the utility sheet was silently dropped and dev pages rendered UNSTYLED. We fix that
 * by (a) resolving the bare id AND any `?query` variant to the same `\0`-prefixed module
 * (preserving the query so Vite's CSS pipeline still recognizes it), and (b) loading by
 * the query-stripped id. This makes `astro dev` serve the same utility CSS as the build.
 *
 * ── Dev hot-reload ────────────────────────────────────────────────────────────────
 * The sheet is derived from every `.astro` source, so when one changes the sheet may
 * change too. `configureServer` watches the `.astro` files under `<root>/src`: on
 * add/change/unlink it re-runs the scan, invalidates the virtual module, and triggers a
 * full page reload so the browser picks up the new utility classes. (A full reload, not a
 * CSS-only HMR patch, because an `.astro` edit also changes the page's own markup — the
 * SSR output must be regenerated, which `astro dev` does on the next request.)
 *
 * In play-mode dev (`sendFullReload: false`) the rebuild + invalidation still run, but
 * the reload notification belongs to the play-patch plugin (./playPatch), which either
 * patches the page in place or lets the stock full reload through — a reload sent from
 * here would defeat every patch.
 */
/** Structural slice of a Vite module graph (mixed on ≤5, per-environment on 6+). */
type ModGraph = { getModuleById: (id: string) => unknown; invalidateModule: (m: unknown) => void };

/** Server shape {@link UtilityCssController.invalidate} reads (Vite ≤5 mixed / 6+ per-env). */
type InvalidatableServer = {
  moduleGraph?: ModGraph;
  environments?: { client?: { moduleGraph?: ModGraph }; ssr?: { moduleGraph?: ModGraph } };
};

/**
 * Controls the project's utility stylesheet (the `virtual:meno-utilities.css` module).
 * Shared between {@link utilityCssVitePlugin} (which serves + dev-watches the sheet) and
 * the play-patch plugin, which needs to (a) ship the freshly rebuilt CSS *inside* its patch
 * payload — in Astro 6 dev the SSR HTML carries this sheet as an EMPTY `<style>` placeholder
 * (Vite injects the real CSS client-side), so the play bridge can never recover it from the
 * re-fetched page and must receive it authoritatively — and (b) invalidate the module in-band
 * before any full-reload fallback, so a reloaded iframe's Vite-injected CSS is fresh too
 * (Astro's own `astro:hmr-reload` skips style modules, so nothing else invalidates it).
 */
export interface UtilityCssController {
  /** Re-scan `<root>/src`, recompute the sheet, and return the new CSS. */
  rebuild(): string;
  /** Invalidate the virtual module — bare id + every `?query` variant — across all graphs. */
  invalidate(server: InvalidatableServer): void;
}

function utilityCssVitePlugin(
  projectRoot: string,
  { sendFullReload = true }: { sendFullReload?: boolean } = {},
): { plugin: Record<string, unknown>; controller: UtilityCssController } {
  const RESOLVED = `\0${UTILITY_CSS_MODULE}`;
  let css = '';
  const rebuild = (): string => {
    // Read scaling config fresh each rebuild (cheap single-file read) so the per-class
    // sheet carries the same responsive `@media`/`clamp()` scaling meno-core's SSR/canvas
    // emit — without it, token vars scale but literal class properties don't, so play-mode
    // sizes diverge from select mode. A later config edit is picked up on the next rebuild.
    const { breakpoints, responsiveScales } = readScaleConfigSync(projectRoot);
    // Defined token names (colors + variables) so the bare color-token class form
    // (`bg-primary`) resolves to its rule, while foreign/authored classes don't.
    const knownTokens = readKnownTokensSync(projectRoot);
    // px→rem conversion ("Convert px to rem" project setting) so class-string utility CSS
    // (`p-[24px]`) ships in rem when enabled — matching meno-core's render path. Read fresh
    // each rebuild (cheap single-file read); a later config edit is picked up next rebuild.
    const remConfig = readRemConfigSync(projectRoot);
    css = buildUtilityStylesheet(
      collectUtilitySources(projectRoot),
      breakpoints,
      responsiveScales,
      knownTokens,
      remConfig,
    );
    // Editor play/design server only (MENO_PLAY=1): pin viewport units in the
    // GLOBAL utility sheet too, so the design canvas's `--design-vh/svh/…`
    // pinning takes hold on class-driven `min-height:100svh` etc. — xray's
    // transform only reaches per-component `<style>` blocks, never this sheet,
    // so without this an `svh`/`dvh`/arbitrary-`vh` class couples to the (tall)
    // design-iframe viewport and a hero fills the whole frame. The var()
    // fallback makes it a no-op when unpinned; deploy builds (no MENO_PLAY)
    // keep the literal units. Mirrors core's render-time rewrite.
    if (process.env[MENO_PLAY_ENV] === '1') css = rewriteViewportUnitsInStylesheet(css);
    return css;
  };
  /** Strip any `?query`/`#hash` suffix so `resolveId`/`load` match every variant. */
  const baseId = (id: string) => id.replace(/[?#].*$/, '');
  /**
   * Every module id this plugin has resolved — the bare id plus each `?query`
   * variant (`?inline`/`?direct` etc.). The dev watcher must invalidate ALL of them:
   * Vite tracks the bare and query variants as separate module nodes, and a variant's
   * cached transform survives a bare-id invalidation — so a stale variant keeps a
   * reloaded page on the old sheet. (Belt-and-suspenders: the play bridge no longer
   * depends on this — it gets the sheet from the patch payload — but a full-reload
   * fallback re-imports the module client-side and must see the rebuilt CSS.)
   */
  const resolvedIds = new Set<string>([RESOLVED]);
  // Invalidate the bare module AND every `?query` variant across every present graph
  // (Vite 6+ splits client/ssr; Vite ≤5 has one mixed graph).
  const invalidate = (server: InvalidatableServer): void => {
    const graphs: ModGraph[] = server.environments
      ? ([server.environments.client?.moduleGraph, server.environments.ssr?.moduleGraph].filter(Boolean) as ModGraph[])
      : server.moduleGraph
        ? [server.moduleGraph]
        : [];
    for (const g of graphs) {
      for (const rid of resolvedIds) {
        const mod = g.getModuleById(rid);
        if (mod) g.invalidateModule(mod);
      }
    }
  };
  const controller: UtilityCssController = { rebuild, invalidate };
  const plugin = {
    name: 'meno-astro:utility-css',
    enforce: 'pre',
    buildStart() {
      rebuild();
    },
    resolveId(id: string) {
      const base = baseId(id);
      if (base !== UTILITY_CSS_MODULE && base !== RESOLVED) return null;
      // Preserve the query (e.g. ?inline) so Vite's CSS transform still applies it.
      const query = id.slice(base.length);
      const resolved = RESOLVED + query;
      resolvedIds.add(resolved);
      return resolved;
    },
    load(id: string) {
      return baseId(id) === RESOLVED ? css : null;
    },
    // Dev only: keep the virtual sheet in sync with `.astro` edits and reload the page.
    configureServer(
      server: {
        watcher: { on: (evt: string, cb: (file: string) => void) => void };
        // Vite ≤5: a single mixed graph. Vite 6+: per-environment graphs (the mixed
        // `server.moduleGraph` is deprecated and may miss the client `?inline` sheet).
        ws?: { send: (payload: { type: string }) => void };
        hot?: { send: (payload: { type: string }) => void };
      } & InvalidatableServer,
    ) {
      const srcDir = join(projectRoot, 'src');
      // `project.config.json` carries the responsive-scaling inputs the sheet is built
      // from (breakpoints + responsiveScales), so a save there must rebuild it too — an
      // `.astro`-only filter would leave the sheet on stale scaling until the next markup
      // edit. (theme.css — the design-token vars — is regenerated/patched separately by
      // the studio on the same save; this keeps the per-class layer in sync.)
      const configFile = join(projectRoot, 'project.config.json');
      const onChange = (file: string) => {
        const isAstro = file.endsWith('.astro') && file.startsWith(srcDir);
        if (!isAstro && file !== configFile) return;
        rebuild();
        invalidate(server);
        // `.astro` edits change page markup too, so regenerate the whole page
        // (unless the play-patch plugin owns the notification — see doc above).
        // `server.ws` (Vite ≤5/6) falls back to `server.hot` (Vite 6+).
        if (sendFullReload) (server.ws ?? server.hot)?.send({ type: 'full-reload' });
      };
      server.watcher.on('add', onChange);
      server.watcher.on('change', onChange);
      server.watcher.on('unlink', onChange);
    },
  };
  return { plugin, controller };
}

// ---------------------------------------------------------------------------
// Static assets — bridge a Meno project's root-level asset dirs into Astro.
//
// A Meno project keeps its uploaded assets at the *root* (`fonts/`, `images/`, …) —
// the layout the editor's static handler (`meno-core` `routes/static.ts`) and the
// JSON→Astro export both use. But Astro only serves `public/` at root URLs, so a plain
// `astro build`/`astro dev` of the dialect project never exposes `/fonts/…`, and any
// `@font-face` `url('/fonts/x.woff2')` (or `<img src="/images/…">`) 404s. This
// integration bridges that gap: it serves these dirs in `astro dev` and copies them
// into the build output (`dist/`, which `astro preview` and the deploy host serve).
// ---------------------------------------------------------------------------

/** Root-level asset dirs to bridge — mirrors `meno-core` `routes/static.ts`. */
export const MENO_ASSET_DIRS = ['fonts', 'images', 'icons', 'videos', 'assets', 'libraries'] as const;

/** Content-Type by extension for the dev middleware (octet-stream fallback). */
const ASSET_MIME: Record<string, string> = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

/** The asset dir a request path belongs to (`/fonts/x.woff2` → `fonts`), or null. */
export function assetDirForPath(urlPath: string): string | null {
  const seg = urlPath.replace(/^\/+/, '').split('/')[0] ?? '';
  return (MENO_ASSET_DIRS as readonly string[]).includes(seg) ? seg : null;
}

/**
 * Resolve a request URL path to an absolute file inside one of the project's asset
 * dirs, or null if it isn't an asset request / would escape its dir (traversal guard).
 */
export function resolveAssetFile(projectRoot: string, urlPath: string): string | null {
  const dir = assetDirForPath(urlPath);
  if (!dir) return null;
  // decodeURIComponent throws URIError on a malformed escape (e.g. `/fonts/%`).
  // A bad encoding isn't a valid asset path -> null (the function's not-an-asset contract).
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const rel = normalize(decoded).replace(/^[/\\]+/, '');
  const filePath = join(projectRoot, rel);
  const baseDir = join(projectRoot, dir);
  // Must stay within <root>/<dir> (block ../ traversal).
  if (filePath !== baseDir && !filePath.startsWith(baseDir + sep)) return null;
  try {
    if (!statSync(filePath).isFile()) return null;
  } catch {
    return null;
  }
  return filePath;
}

/**
 * Copy each existing `<projectRoot>/<dir>` into `<outDir>/<dir>` (recursive merge).
 * Best-effort: a dir that's absent is skipped, one that fails to copy is swallowed.
 * Returns the dirs actually copied. Used by the `astro:build:done` hook.
 */
export function copyAssetDirsToOutput(projectRoot: string, outDir: string): string[] {
  const copied: string[] = [];
  for (const dir of MENO_ASSET_DIRS) {
    const src = join(projectRoot, dir);
    if (!existsSync(src)) continue;
    try {
      cpSync(src, join(outDir, dir), { recursive: true });
      copied.push(dir);
    } catch {
      /* best-effort: skip a dir that fails to copy */
    }
  }
  return copied;
}

/**
 * Vite plugin (typed structurally — meno-astro doesn't depend on vite) that serves the
 * project's root-level asset dirs in `astro dev`. Registered as a *post* middleware so
 * it only handles requests Vite's own static serving didn't (i.e. real `public/`
 * assets still win). Build output is handled separately by `astro:build:done`.
 */
function menoAssetsVitePlugin(projectRoot: string): Record<string, unknown> {
  return {
    name: 'meno-astro:static-assets',
    configureServer(server: { middlewares: { use: (fn: unknown) => void } }) {
      // Return a post hook so we run after Vite's internal middlewares (publicDir etc).
      return () => {
        server.middlewares.use((req: any, res: any, next: () => void) => {
          if (!req.url) return next();
          const filePath = resolveAssetFile(projectRoot, req.url.split('?')[0]);
          if (!filePath) return next();
          res.setHeader('Content-Type', ASSET_MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream');
          // Guard the long-lived dev server: a stream 'error' (file deleted/locked
          // after statSync — TOCTOU) must not crash it, and a client disconnect must
          // not leak the fd.
          const stream = createReadStream(filePath);
          stream.on('error', () => {
            if (!res.headersSent) res.statusCode = 404;
            res.end();
          });
          res.on('close', () => stream.destroy());
          stream.pipe(res);
        });
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Play-mode navigation bridge — sync preview navigation back to the editor.
//
// In the editor's play mode the preview iframe points at the REAL Astro dev
// server (cross-origin to the editor), so the editor cannot read the iframe's
// location the way it does for its same-origin SSR preview. Instead, when the
// server is launched by the editor (MENO_PLAY=1 in the spawn env), this
// integration injects a tiny inline head script that postMessages the current
// pathname to the embedding window on every page load — including soft
// `astro:page-load` navigations under Astro's client router. The editor
// validates the message origin against the dev-server port and feeds the path
// into its existing static-navigate page-sync handler.
//
// Stage `head-inline`: the script is inlined verbatim into <head> with zero
// module-graph participation — no extra Vite entry, no dep-optimizer work, and
// identical delivery in `astro dev` and built output. For a few lines of
// dependency-free bridge code that's the simplest correct stage; `page` (a
// bundled module) buys nothing here.
//
// Deploy builds (Netlify, `meno build`) never set MENO_PLAY, so shipped sites
// carry no bridge.
// ---------------------------------------------------------------------------

/** Env var the editor sets when spawning `astro dev`/`build`/`preview` for play mode. */
export const MENO_PLAY_ENV = 'MENO_PLAY';

/** `message` event `data.type` the bridge posts — the editor matches on this. */
export const PLAY_NAVIGATE_MESSAGE_TYPE = 'meno:astro:navigate';

/**
 * The injected head script. Posts `{ type, path }` to the parent frame on each
 * page load, deduped per pathname (a full load runs the script fresh; under the
 * client router the initial load also fires `astro:page-load`, and the listener
 * registered here persists across soft navigations since the document does).
 * `targetOrigin: '*'` is deliberate: only the pathname (non-sensitive) is sent,
 * the editor's own origin varies (web/Electron), and the EDITOR validates
 * `event.origin` against the dev-server port before acting.
 */
export const PLAY_NAVIGATION_BRIDGE_SCRIPT = `
if (window.self !== window.top) {
  let lastPath = null;
  const post = () => {
    const path = window.location.pathname;
    if (path === lastPath) return;
    lastPath = path;
    try {
      window.parent.postMessage({ type: '${PLAY_NAVIGATE_MESSAGE_TYPE}', path }, '*');
    } catch {}
  };
  post();
  document.addEventListener('astro:page-load', post);
}
`;

/**
 * Response-header marker for editor play mode: every response from a MENO_PLAY
 * server carries `x-meno-astro-play: 1` so the Electron shell can recognize the
 * play preview and exempt it from its localhost CSP injection.
 *
 * Why: the Electron app stamps a fail-closed CSP onto every localhost response
 * (electron-app/main/window.js, setupContentSecurityPolicy) whose inline-script
 * allowance is driven by Meno SSR's per-request `x-meno-csp-nonce` contract. An
 * Astro dev server knows nothing about that contract, so its pages — whose
 * component behavior ships as inline `define:vars` scripts — render with EVERY
 * inline script blocked: the play preview paints and animates (external
 * libraries still run) but all interactivity is dead. The marker lets the shell
 * pass play responses through untouched — the same trust level as opening the
 * local project in a regular browser, which is exactly what play mode is.
 *
 * Same design as `x-meno-csp-nonce`: a header contract between a local server
 * and the Electron shell — no IPC, no port bookkeeping, works for any number of
 * concurrently open projects. Deploy builds never set MENO_PLAY, so shipped
 * sites never carry the marker (and it would be inert if they did).
 */
export const PLAY_MARKER_HEADER = 'x-meno-astro-play';

/** Structural slice of the vite dev/preview server we stamp the marker on. */
interface MarkableServer {
  middlewares: {
    use: (
      fn: (req: unknown, res: { setHeader: (name: string, value: string) => void }, next: () => void) => void,
    ) => void;
  };
}

/**
 * Vite plugin (registered in play mode only) that stamps {@link PLAY_MARKER_HEADER}
 * onto every `astro dev` response. `configurePreviewServer` is wired too for
 * completeness, though the editor's play mode always runs `astro dev` (the
 * studio's 'preview' mode serves a static build through Astro's own preview
 * server, which doesn't run vite middlewares).
 */
function playMarkerVitePlugin(): Record<string, unknown> {
  const stamp = (server: MarkableServer) => {
    server.middlewares.use((_req, res, next) => {
      res.setHeader(PLAY_MARKER_HEADER, '1');
      next();
    });
  };
  return {
    name: 'meno-astro:play-marker',
    configureServer: stamp,
    configurePreviewServer: stamp,
  };
}

/** Loose Astro-integration shape — `meno()` returns its own plus framework renderers. */
type IntegrationLike = { name: string; hooks?: Record<string, unknown> };

/**
 * Synchronously load the Astro renderer integration for every island framework whose
 * `@astrojs/<fw>` package is INSTALLED (resolvable from meno-astro). These are returned
 * as TOP-LEVEL integrations from `meno()` (Astro flattens nested integration arrays), so
 * each goes through Astro's normal integration phase — its Vite plugin (e.g. the
 * `astro:react:opts` virtual module the React SSR renderer imports) and `addRenderer`
 * apply correctly. Registering a renderer integration mid-`config:setup` via
 * `updateConfig` is too late: Vite is already configured, so the renderer's virtual
 * modules go unresolved and SSR crashes (`Cannot find package 'astro:react:opts'`).
 *
 * Detection is by INSTALLATION, not by scanning `src/islands/`: provisioning installs
 * only the frameworks a project uses (see `islandFrameworks` / `MENO_ASTRO_FRAMEWORKS`),
 * so "every installed renderer" == "every framework this project uses". A renderer with
 * no island is harmless (unused). Sync `require` keeps `meno()` a synchronous factory
 * (existing configs call `meno()`, not `await meno()`); the runtime — bun (play) or
 * node ≥22.12 (build) — supports `require()` of these ESM integration packages.
 */
/** Island-framework integration packages (`@astrojs/react`, …) resolvable from meno-astro. */
function installedFrameworkPackages(): string[] {
  const req = createRequire(import.meta.url);
  const packages = [...new Set(Object.values(ISLAND_FRAMEWORK_SPECS).map((s) => s.integration))];
  return packages.filter((pkg) => {
    try {
      req.resolve(pkg);
      return true;
    } catch {
      return false; // not installed — this project doesn't use this framework
    }
  });
}

function loadInstalledFrameworkIntegrations(): IntegrationLike[] {
  const req = createRequire(import.meta.url);
  const integrations: IntegrationLike[] = [];
  for (const pkg of installedFrameworkPackages()) {
    try {
      const mod = req(req.resolve(pkg));
      const factory = mod?.default || mod;
      if (typeof factory === 'function') integrations.push(factory() as IntegrationLike);
    } catch (err) {
      console.warn(`[meno-astro] island renderer ${pkg} is installed but failed to load: ${(err as Error).message}`);
    }
  }
  return integrations;
}

/**
 * Resolve the SSR adapter integration object when the project opted into `output: 'server'`
 * (read from `project.config.json` via `loadAstroConfigExtras`). We instantiate
 * `@astrojs/<name>(opts)` (its default export returns the adapter integration). `meno()` then
 * registers it TWO ways, both required (verified by the SSR e2e):
 *   1. `updateConfig({ output: 'server', adapter })` in `astro:config:setup` — sets
 *      `config.adapter` so the build doesn't fail `NoAdapterInstalled`; and
 *   2. returning it in the integrations array so its OWN hooks run — its `astro:config:done`
 *      registers the real `serverEntrypoint`/adapter features (without which the build fails
 *      to resolve `virtual:astro:legacy-ssr-entry`).
 * This keeps the project's astro.config exactly `integrations: [meno()]` — it never imports
 * the adapter (which would trip the play runtime's `ALLOWED_CONFIG_IMPORTS` guard). Returns
 * `null` (→ static output) when the project is static or the adapter package isn't installed
 * in the runtime store. `node` carries a `mode` (default `standalone`); others take no options.
 */
/**
 * The options object passed to an adapter factory (`@astrojs/<name>(opts)`). Only `node`
 * takes options (a `mode`, default `standalone`); the others are called with no args. Pure +
 * exported so the per-adapter contract is unit-tested without resolving a real package.
 */
export function adapterFactoryOptions(adapter: { name: string; mode?: string }): { mode: string } | undefined {
  return adapter.name === 'node' ? { mode: adapter.mode ?? 'standalone' } : undefined;
}

function loadAdapterIntegration(projectRoot: string): IntegrationLike | null {
  const extras = loadAstroConfigExtras(projectRoot);
  if (extras.output !== 'server' || !extras.adapter) return null;
  const { name } = extras.adapter;
  const pkg = ASTRO_ADAPTER_SPECS[name]?.package ?? `@astrojs/${name}`;
  const req = createRequire(import.meta.url);
  try {
    const mod = req(req.resolve(pkg));
    const factory = mod?.default || mod;
    if (typeof factory !== 'function') return null;
    return factory(adapterFactoryOptions(extras.adapter)) as IntegrationLike;
  } catch (err) {
    console.warn(
      `[meno-astro] SSR adapter ${pkg} requested (output: 'server') but not loadable: ${(err as Error).message}. ` +
        `Falling back to static output.`,
    );
    return null;
  }
}

/**
 * Build the `vite.server.fs.allow` list so Astro's dev server can serve island hydration
 * chunks over `/@fs/…`.
 *
 * SSR resolves the island framework renderers fine (Node resolution + `ssr.noExternal`
 * reach the hoisted deps), but CLIENT hydration fetches e.g. `@astrojs/react/dist/client.js`
 * over HTTP as `/@fs/<abs>/node_modules/@astrojs/react/dist/client.js`. In the Meno play
 * runtime those framework deps are HOISTED to the shared workspace `node_modules`, one level
 * ABOVE the Vite root (the synced project copy) — outside Vite's default fs allow-list — so
 * the fetch returns `403 Restricted ("outside of Vite serving allow list")` and the island
 * never hydrates. The nested-copy + hoisted-deps layout also defeats Vite's automatic
 * workspace-root detection, so we add it explicitly: for each installed renderer (plus
 * meno-astro's own package, hoisted the same way) we resolve the package and add the parent
 * of the `node_modules` it resolves from — i.e. the dir that hoists the dep. Astro MERGES
 * (concatenates) this onto its existing `fs.allow`, so the project copy + Vite client stay
 * allowed; we only widen it to reach the hoisted chunks.
 *
 * Harmless in a real `astro build`/deploy: deps are project-local there and nothing is served
 * over `/@fs/`, so the extra allow entries are simply never consulted.
 */
export function frameworkFsAllow(projectRoot: string): string[] {
  const req = createRequire(import.meta.url);
  // The Vite root (project copy) is always allowed; listing it keeps a non-empty allow-list
  // sane even if every resolve below fails (e.g. nothing installed).
  const allow = new Set<string>([projectRoot]);
  const marker = `${sep}node_modules${sep}`;
  for (const pkg of [...installedFrameworkPackages(), 'meno-astro']) {
    try {
      const resolved = req.resolve(pkg); // …/node_modules/<pkg>/dist/…
      const idx = resolved.lastIndexOf(marker);
      if (idx !== -1) allow.add(resolved.slice(0, idx)); // parent of node_modules = hoisting root
    } catch {
      /* not installed / unresolvable from here — skip */
    }
  }
  return [...allow];
}

/**
 * The `meno()` Astro integration. Add to a converted project's `astro.config.mjs`:
 *
 * ```js
 * import meno from 'meno-astro/integration';
 * export default defineConfig({ integrations: [meno()] });
 * ```
 *
 * On `astro:config:setup` it (a) configures Astro's native i18n routing from the
 * project's `project.config.json` and maps its `siteUrl` onto Astro's `site` option,
 * (b) registers the utility-CSS + static-asset vite plugins, (c) injects the
 * per-render locale middleware plus — for multi-locale projects — the
 * `/[locale]/[...path]` locale route, and (d, play mode only) injects the navigation
 * bridge. On `astro:build:done` it copies the project's root-level asset dirs into
 * the build output and writes `sitemap.xml` (when the project has a `siteUrl`).
 */
export default function meno(): IntegrationLike[] {
  // Captured in `astro:config:setup` and reused in `astro:build:done` (Astro runs the
  // former first). Defaults to cwd so the build hook is safe even if setup didn't run.
  let projectRoot = process.cwd();
  // Resolve the SSR adapter up front (Astro runs `meno()` in the project dir, so cwd is the
  // project root): registering it as a top-level integration is the only place its
  // `astro:config:done`/`setAdapter` applies. `null` ⇒ static output (the default). The
  // matching `output: 'server'` is set in `astro:config:setup` below, gated on this resolving.
  const adapterIntegration = loadAdapterIntegration(projectRoot);
  const base: MenoIntegration = {
    name: 'meno-astro',
    hooks: {
      'astro:config:setup': ({
        config,
        command,
        updateConfig,
        addMiddleware,
        injectScript,
        injectRoute,
        addWatchFile,
      }) => {
        projectRoot = resolveProjectRoot(config?.root);
        const i18nConfig = loadI18nConfig(projectRoot);
        const isPlayMode = process.env[MENO_PLAY_ENV] === '1';
        // Patching needs a live HMR socket — play mode's `astro dev` only.
        const isPlayDev = isPlayMode && command === 'dev';

        // Everything below derives from project.config.json and is frozen at setup
        // time — Astro's i18n routing options, the `site` origin, and whether the
        // locale route is injected at all. Watching the file makes `astro dev`
        // restart (re-running this hook) on every config save, so adding a locale
        // takes effect live instead of 404ing until a manual stop/start.
        // (The per-render loaders — loadI18nConfig/loadSiteUrl/slug maps — are
        // mtime-fresh on their own; this covers the setup-frozen half.)
        //
        // BUT NOT in play mode: the editor writes project.config.json on every
        // settings tweak (devToolbar, prefetch, SEO, custom code, …), and a config
        // watch-file turns EACH of those saves into a full dev-server restart. In the
        // embedded play iframe that blanket restart drops the HMR socket and blanks the
        // preview — the "I changed a setting and play died" symptom. Play instead gets a
        // SURGICAL restart from the studio host: its play-workdir mirror watcher diffs the
        // config:setup-frozen subset (i18n routing/locales, site, redirects, image,
        // prefetch, devToolbar) and restarts the server ONLY when one of those actually
        // changes (see studio astro-dev-server serve.ts scheduleConfigSetupRestart), while
        // the frequent non-frozen saves leave the server up (per-render loaders reflect
        // them live). So play keeps an always-on server AND still applies frozen changes.
        if (!isPlayMode) addWatchFile?.(join(projectRoot, 'project.config.json'));

        // (a)+(b) Configure Astro's native i18n routing from the Meno project config,
        //     and register the build-time utility-CSS vite plugin (serves the global
        //     stylesheet BaseLayout imports as `virtual:meno-utilities.css`) plus the
        //     static-asset plugin that serves root-level asset dirs in `astro dev`.
        //
        //     meno-astro ships `.astro` components (BaseLayout etc.) and MUST stay
        //     out of Vite's dependency pre-bundle: the optimizer's plain esbuild
        //     pass can't parse `.astro` (raw files → 'Unexpected "export"', TS
        //     frontmatter → 'Expected ";"', `virtual:meno-utilities.css` →
        //     unresolvable) and poisons `astro dev` with nondeterministic 500s.
        //     Astro auto-excludes packages with the `astro-component` keyword only
        //     when the project's package.json DECLARES the dependency — the
        //     editor's preview workdir resolves meno-astro upward from a shared
        //     store without declaring it, so exclude explicitly here.
        const utilityCss = utilityCssVitePlugin(projectRoot, { sendFullReload: !isPlayDev });
        const vitePlugins = [utilityCss.plugin, menoAssetsVitePlugin(projectRoot)];
        // Play mode only: mark every response so the Electron shell exempts the
        // play preview from its localhost CSP injection (see PLAY_MARKER_HEADER),
        // and stamp serve-time element-path attributes so the editor's X-Ray
        // bridge can locate selected nodes in the preview DOM (see ./xray).
        if (isPlayMode) vitePlugins.push(playMarkerVitePlugin(), xrayVitePlugin(projectRoot));
        // Play dev only: patch style/text-only edits in place instead of
        // full-reloading the play iframe; everything else reloads (see ./playPatch).
        if (isPlayDev) vitePlugins.push(playPatchVitePlugin(projectRoot, utilityCss.controller));

        // Map the project's `siteUrl` (project.config.json) onto Astro's `site` option:
        // it powers `Astro.site` and every absolute-URL feature (canonical URLs, RSS,
        // og:url, redirects on hosts that read it). Only when the user's own Astro
        // config didn't already set one — explicit user config always wins.
        const siteUrl = loadSiteUrl(projectRoot);

        // Island framework renderers (`@astrojs/react`, …) live in the shared play-runtime
        // store, OUTSIDE the project workdir — so Vite would externalize them in SSR and
        // node would load e.g. `@astrojs/react/dist/server.js` directly, failing to resolve
        // its `astro:react:opts` virtual module (a Vite-plugin-provided id). Force Vite to
        // process them (same `noExternal` trick meno-astro uses for its own `.astro`
        // components) so their renderer's virtual modules resolve. No-op when no island
        // framework is installed.
        const noExternal = ['meno-astro', ...installedFrameworkPackages()];

        // Visually-configured Astro options mapped from project.config.json (Studio settings):
        // `redirects` (the Redirects table), `image.domains` (remote hosts the optimizing
        // <Image> may process), `prefetch` (Meno's PrefetchConfig → Astro's native prefetch),
        // and `devToolbar`. Only keys the project actually set are present, so an unset option
        // keeps Astro's default. See loadAstroConfigExtras.
        const extras = loadAstroConfigExtras(projectRoot);

        // Two of the extras get special handling so they behave sanely:
        //   - `devToolbar`: the editor's "Show the Astro dev toolbar while previewing" toggle.
        //     Astro DEFAULTS the toolbar ON in dev, so we ALWAYS pass an explicit `enabled` —
        //     `true` only when the user actually ticked it — to make "off by default to keep the
        //     preview clean" real (otherwise play/dev would show it uninvited). It IS honored in
        //     play: that's the whole point of the toggle (preview = the play iframe).
        //   - `prefetch`: the project's PrefetchConfig maps to `prefetchAll`, which on first
        //     paint fires a prefetch for every same-origin link. In the embedded play iframe
        //     that's a flood of parallel route compiles against the single dev server (stalls
        //     first paint) with no benefit — a production / standalone-dev concern only — so it
        //     is dropped in play and applied everywhere else.
        // `redirects` and `image.domains` are correctness features (real navigation + MenoImage
        // remote-source optimization) and apply everywhere.
        const behavioralExtras = {
          devToolbar: { enabled: extras.devToolbar?.enabled === true },
          ...(!isPlayMode && extras.prefetch ? { prefetch: extras.prefetch } : {}),
        };

        // Typed env vars (astro:env): map the project's `env` schema to Astro's `env.schema`.
        // Opt-in — projects without an `env` array get nothing, so existing builds are unchanged.
        const envVars = loadEnvConfig(projectRoot);
        const envSchema = envVars.length ? buildEnvSchema(envVars, envField) : undefined;

        updateConfig({
          ...(siteUrl && !config?.site ? { site: siteUrl } : {}),
          ...(extras.redirects ? { redirects: extras.redirects } : {}),
          ...(extras.image ? { image: extras.image } : {}),
          // SSR opt-in: set `output: 'server'` + the resolved adapter ONLY when the adapter
          // actually loaded (a requested-but-missing adapter degrades to a clean static build,
          // not a hard fail). The adapter is set via the `adapter` CONFIG field — the canonical
          // registration (same as `defineConfig({ adapter: node() })`); returning it as a plain
          // integration runs its hooks but never marks it as THE adapter (→ NoAdapterInstalled).
          ...(adapterIntegration ? { output: 'server' as const, adapter: adapterIntegration } : {}),
          ...(envSchema ? { env: { schema: envSchema } } : {}),
          ...behavioralExtras,
          i18n: toAstroI18nOptions(i18nConfig),
          vite: {
            plugins: vitePlugins,
            optimizeDeps: { exclude: ['meno-astro'] },
            ssr: { noExternal },
            // Let `astro dev` serve island hydration chunks (`@astrojs/<fw>/dist/client.js`)
            // that live in the play runtime's HOISTED workspace node_modules, outside the
            // Vite root — otherwise the `/@fs/…` fetch 403s and the island never hydrates.
            // Astro concatenates this onto its own fs.allow; inert in a real build (no /@fs/).
            server: { fs: { allow: frameworkFsAllow(projectRoot) } },
          },
        });

        // (c) Inject the locale middleware that opens the runWithLocale() context.
        //     `order: 'pre'` so the locale context is established before any
        //     user-authored middleware runs.
        addMiddleware({ entrypoint: LOCALE_MIDDLEWARE_ENTRYPOINT, order: 'pre' });

        //     Multi-locale projects also get the locale route — the `/[locale]/[...path]`
        //     dynamic route that serves every page at its non-default-locale URLs
        //     (localized slugs from `meta.slugs`; `prerender: true` so `astro build`
        //     emits the `/pl/…` pages). Single-locale projects skip it entirely
        //     (zero-cost no-op; its getStaticPaths would enumerate nothing anyway).
        if (injectRoute && i18nConfig.locales.length > 1) {
          injectRoute({
            pattern: LOCALE_ROUTE_PATTERN,
            entrypoint: LOCALE_ROUTE_ENTRYPOINT,
            prerender: true,
          });
        }

        // (d) Editor play mode only (MENO_PLAY=1 in the spawn env): inject the
        //     navigation bridge so in-preview navigation syncs the editor's
        //     current page (see the bridge section above for the stage choice),
        //     the X-Ray bridge that renders selection borders in-page from
        //     the editor's postMessaged targets (see ./xray), and the design
        //     bridge that reports content height + forwards design-canvas
        //     gestures (see ./designBridge).
        if (isPlayMode && injectScript) {
          injectScript('head-inline', PLAY_NAVIGATION_BRIDGE_SCRIPT);
          // The X-Ray bridge also owns pinned-comment resolution (see ./xray).
          injectScript('head-inline', PLAY_XRAY_BRIDGE_SCRIPT);
          injectScript('head-inline', PLAY_DESIGN_BRIDGE_SCRIPT);
          // Dev only: the patch bridge that applies style/text patches in
          // place (see ./playPatch) — useless without an HMR socket.
          if (isPlayDev) injectScript('head-inline', PLAY_PATCH_BRIDGE_SCRIPT);
        }
      },

      // Copy the project's root-level asset dirs (fonts/images/icons/…) into the
      // build output so `/fonts/x.woff2` etc. resolve in `astro preview` and on the
      // deploy host (Netlify serves `dist/`). The dev path is covered by the vite
      // plugin above. No-op when the output dir is missing.
      //
      // Also writes `<outDir>/sitemap.xml` from the build's page list — absolute URLs
      // on the project's `siteUrl`, with per-locale `<xhtml:link>` alternates for every
      // page the slug map can route (see ./sitemap). Without a `siteUrl` a sitemap
      // would have to invent an origin (the standard requires absolute URLs), so it is
      // skipped — announced once so a missing-sitemap deploy is diagnosable.
      'astro:build:done': ({ dir, pages }) => {
        if (!dir) return;
        const outDir = resolveProjectRoot(dir);
        copyAssetDirsToOutput(projectRoot, outDir);

        const siteUrl = loadSiteUrl(projectRoot);
        if (!siteUrl) {
          console.log('[meno-astro] sitemap skipped: no siteUrl in project.config.json');
          return;
        }
        const xml = buildSitemapXml(
          pages ?? [],
          siteUrl,
          loadI18nConfig(projectRoot),
          loadSlugMappings(projectRoot),
          loadSitemapMeta(projectRoot),
        );
        // null = nothing worth writing (no pages / only error routes) — leave no file.
        // Best-effort like the asset copy: a failed write must not fail the build.
        if (xml) {
          try {
            writeFileSync(join(outDir, 'sitemap.xml'), xml, 'utf8');
          } catch {
            /* best-effort: the site itself built fine */
          }
        }
      },
    },
  };
  // Astro flattens nested integration arrays, so returning [meno, react, …, node] registers
  // the installed island-framework renderers AND the SSR adapter as TOP-LEVEL integrations
  // alongside meno(). The adapter needs BOTH: its hooks must run here (so its
  // `astro:config:done` sets the real serverEntrypoint — without it the build fails with
  // `virtual:astro:legacy-ssr-entry` unresolved) AND `config.adapter` must be set in
  // config:setup (without it the build fails `NoAdapterInstalled`). meno() does both — the
  // updateConfig above sets `adapter`, this returns its integration. Verified by the SSR e2e.
  return [base, ...loadInstalledFrameworkIntegrations(), ...(adapterIntegration ? [adapterIntegration] : [])];
}
