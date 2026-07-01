/**
 * meno-astro/server — `loadLibraries`.
 *
 * Reads a project's `project.config.json`, merges its three library tiers (global
 * `libraries` → component tier → the page's `meta.libraries`), and renders the `<link>` /
 * `<script>` / inline `<style>` tags for `BaseLayout.astro` to drop into `<head>` (and
 * before `</body>` for body-end scripts). Without it the libraries config ships in the
 * project but is never *loaded* — the converter's gap this closes.
 *
 * The component tier is collected LIVE from `src/components/**∕*.astro` (each component's
 * `const __meno = {…}` literal) on every render — the dialect twin of meno-core's SSR,
 * which runs `collectComponentLibraries` over the live registry per render. A project being
 * edited bidirectionally rewrites its component files continuously; the convert-time
 * `__componentLibraries` snapshot in `project.config.json` goes stale the moment that
 * happens (nothing refreshes it), which made component-tier libraries vanish from real
 * Astro renders (`astro dev` play mode, `astro build`). The snapshot remains the fallback
 * for output without a components dir.
 *
 * This is the dialect twin of meno-core's SSR (`htmlGenerator.ts`): same merge order, same
 * URL-dedupe, same local-CSS inlining, so the two runtimes stay byte-identical. The Astro
 * output is always the **build** context (`disableBuild` libs dropped, `disableEditor` kept;
 * no dev cache-busting). The pure tag/merge logic is reused wholesale from meno-core's
 * `libraryLoader` (exposed on the `meno-core/shared` barrel).
 *
 * Any failure (missing file, bad JSON, unreadable local CSS) degrades to empty strings — a
 * project always renders, just without its libraries.
 *
 * Server/build-only (touches the filesystem); BaseLayout's frontmatter runs at build/SSR
 * time, never in the browser.
 */

import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
// Import from the `meno-core/shared` barrel (not a deep `./libraryLoader` path): the
// published meno-core bundles shared modules into the barrel and does not emit
// `dist/lib/shared/libraryLoader.js`, so the deep path would 404 in a consumer project.
// Same constraint that drives loadFontCss's import.
import {
  mergeLibraries,
  filterLibrariesByContext,
  generateLibraryTags,
  type LibrariesConfig,
  type PageLibrariesConfig,
  type JSLibraryConfig,
  type CSSLibraryConfig,
  type LibraryTags,
} from 'meno-core/shared';
import { stripImportedLibraries } from '../dialect/libraryImports';
import { readComponentMeta } from '../dialect/parse/parseFrontmatter';

const EMPTY: LibraryTags = { headCSS: '', headJS: '', bodyEndJS: '' };

/**
 * A page's meta as far as libraries are concerned. Structural (not `MenoPageMeta`) to avoid
 * a type cycle with the root barrel, which re-exports `loadLibraries`. BaseLayout passes the
 * full `meta`, which is assignable.
 */
export interface PageLibrariesMeta {
  libraries?: PageLibrariesConfig;
}

/**
 * Normalize a raw `libraries` block (string URLs OR object configs) to object form — mirrors
 * `ConfigService.getLibraries` so author-written `"js": ["https://…"]` shorthand still works.
 */
function normalizeLibraries(raw: unknown): LibrariesConfig {
  if (!raw || typeof raw !== 'object') return { js: [], css: [] };
  const libs = raw as { js?: unknown; css?: unknown };
  const js = Array.isArray(libs.js)
    ? (libs.js.map((l) => (typeof l === 'string' ? { url: l } : l)) as JSLibraryConfig[])
    : [];
  const css = Array.isArray(libs.css)
    ? (libs.css.map((l) => (typeof l === 'string' ? { url: l } : l)) as CSSLibraryConfig[])
    : [];
  return { js, css };
}

/** Deduplicate JS + CSS libraries by URL (first occurrence wins). */
function dedupeByUrl(libs: LibrariesConfig): LibrariesConfig {
  const seenJS = new Set<string>();
  const seenCSS = new Set<string>();
  const keepUnseen = (seen: Set<string>) => (url: string) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  };
  return {
    js: (libs.js || []).filter((l) => keepUnseen(seenJS)(l.url)),
    css: (libs.css || []).filter((l) => keepUnseen(seenCSS)(l.url)),
  };
}

/**
 * Per-file cache for component-library extraction, keyed by absolute path and reused while
 * the file's mtime is unchanged. `astro dev` calls loadLibraries on every page render —
 * re-parsing every component each time would be wasted work — while an editor save (the
 * workdir mirror rewrites the file, bumping its mtime) invalidates naturally.
 */
const componentLibsCache = new Map<string, { mtimeMs: number; libs: LibrariesConfig | null }>();

/** A single component file's tag-tier libraries (mtime-cached), or null when it has none. */
function componentLibsOf(absPath: string): LibrariesConfig | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(absPath).mtimeMs;
  } catch {
    return null;
  }
  const cached = componentLibsCache.get(absPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.libs;

  let libs: LibrariesConfig | null = null;
  try {
    const raw = readComponentMeta(readFileSync(absPath, 'utf8'))?.libraries;
    if (raw) {
      // Vite-imported locals (local CSS / module JS) load via the component's own emitted
      // `import` — strip them so they aren't ALSO rendered as tags (same rule as
      // convertProject's snapshot). What remains (external + local classic JS) is the tag tier.
      const normalized = stripImportedLibraries(normalizeLibraries(raw));
      if (normalized.js?.length || normalized.css?.length) libs = normalized;
    }
  } catch {
    // Unreadable/unparseable component — contributes nothing.
  }

  componentLibsCache.set(absPath, { mtimeMs, libs });
  return libs;
}

/**
 * Collect the component tier the way meno-core SSR does (`collectComponentLibraries` over
 * the LIVE registry on every render), but from the dialect's canonical store: each
 * `src/components/**∕*.astro` carries its `libraries` inside the `const __meno = {…}`
 * literal. Deduped by URL (first wins, files walked in sorted order for determinism).
 * Returns null when the project has no `src/components` dir, so the caller can fall back
 * to the convert-time `__componentLibraries` snapshot.
 */
export function collectAstroComponentLibraries(projectRoot: string): LibrariesConfig | null {
  const dir = join(projectRoot, 'src', 'components');
  if (!existsSync(dir)) return null;

  const collected: LibrariesConfig = { js: [], css: [] };
  const seenJS = new Set<string>();
  const seenCSS = new Set<string>();

  const visit = (d: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const abs = join(d, e.name);
      if (e.isDirectory()) {
        visit(abs);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith('.astro')) continue;
      const libs = componentLibsOf(abs);
      if (!libs) continue;
      for (const js of libs.js || [])
        if (!seenJS.has(js.url)) {
          seenJS.add(js.url);
          collected.js!.push(js);
        }
      for (const css of libs.css || [])
        if (!seenCSS.has(css.url)) {
          seenCSS.add(css.url);
          collected.css!.push(css);
        }
    }
  };
  visit(dir);
  return collected;
}

/**
 * Load library `<head>`/body tags for the project rooted at `projectRoot`, for the given page.
 *
 * Merge order (mirrors htmlGenerator): global → component → page. The page tier may `extend`
 * (default) or `replace` global+component. Never throws — every failure returns empty strings.
 */
export function loadLibraries(projectRoot: string, pageMeta?: PageLibrariesMeta): LibraryTags {
  try {
    const cfgPath = join(projectRoot, 'project.config.json');
    if (!existsSync(cfgPath)) return EMPTY;
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as {
      libraries?: unknown;
      __componentLibraries?: unknown;
    };

    const global = normalizeLibraries(cfg.libraries);
    // Component tier — collected LIVE from src/components/*.astro (mtime-cached) so editor
    // saves are reflected without re-converting; the convert-time `__componentLibraries`
    // snapshot is only the fallback for output without a components dir. Either way the tier
    // always extends, matching meno-core which injects every component's libs on every page.
    const component = collectAstroComponentLibraries(projectRoot) ?? normalizeLibraries(cfg.__componentLibraries);
    // Page tier: drop locals the page emits as Vite imports (local CSS / module JS) so they
    // aren't ALSO rendered as tags here. Global-tier locals stay (no per-page import exists for
    // them) — they're inlined (CSS) / tagged (JS) below, as in Phase 1.
    const page = pageMeta?.libraries ? stripImportedLibraries(pageMeta.libraries) : undefined;

    const globalPlusComponent = mergeLibraries(global, component);
    const merged = mergeLibraries(globalPlusComponent, page);
    const deduped = dedupeByUrl(merged);
    const filtered = filterLibrariesByContext(deduped, 'build');

    // Inline local CSS (default for `/…` paths unless `inline:false`) — byte-parity with SSR.
    // External URLs and `inline:false` stay as <link>. Local files live at <projectRoot>/<path>
    // (the meno() integration serves /libraries/* etc. from the project root).
    const inlineContents = new Map<string, string>();
    for (const css of filtered.css || []) {
      if (css.inline === false || !css.url.startsWith('/')) continue;
      try {
        const filePath = join(projectRoot, (css.url.split('?')[0] ?? '').slice(1));
        if (filePath.startsWith(projectRoot)) {
          inlineContents.set(css.url, readFileSync(filePath, 'utf8'));
        }
      } catch {
        // Unreadable local file — fall back to a <link> tag (skip inlining).
      }
    }

    // --- Library load-order guarantee (meno-astro-specific) ---------------------
    // The dialect emits each component's init JS as a plain INLINE <script> right where the
    // component renders in the body (resolving its element via document.currentScript). A
    // plain inline script runs the moment the parser reaches it — *during* parse. A library
    // script that is body-end + `defer` (the JS default) runs only AFTER the whole document
    // is parsed. So every component init runs BEFORE its library global is defined, the
    // `typeof EmblaCarousel !== 'undefined'` guards short-circuit, and carousels/sliders are
    // silently never created. (meno-core SSR escapes this because it collects ALL init JS into
    // a single body-end script; the dialect keeps init inline per component, so the runtime
    // must guarantee library globals exist before the body is parsed.)
    //
    // Fix: render DEFAULT classic library scripts as BLOCKING <head> scripts (no defer/async)
    // — the parser halts to fetch+execute them before it reaches any body init script, so the
    // global is defined in time. "Default" = a classic script (`type` not `module`) the author
    // left at the defaults (no explicit `mode`, no explicit `position`) — exactly the
    // auto-provisioned UMD-global case (embla, swiper, …) this bug is about. Any EXPLICIT
    // author choice (`mode: 'async'`, `position: 'body-end'`, a module, …) is honored verbatim
    // by generateLibraryTags — we don't second-guess an intentional load strategy.
    const isDefaultClassic = (l: JSLibraryConfig) => l.type !== 'module' && !l.mode && !l.position;
    const blockingJs = (filtered.js || []).filter(isDefaultClassic);
    const restJs = (filtered.js || []).filter((l) => !isDefaultClassic(l));

    const blockingHeadJS = blockingJs.map((l) => `<script src="${escapeAttr(l.url)}"></script>`).join('\n  ');

    const rest = generateLibraryTags({ js: restJs, css: filtered.css }, inlineContents);

    return {
      headCSS: rest.headCSS,
      // Blocking library scripts first, then any scripts the author explicitly placed in <head>.
      headJS: [blockingHeadJS, rest.headJS].filter(Boolean).join('\n  '),
      bodyEndJS: rest.bodyEndJS,
    };
  } catch {
    return EMPTY;
  }
}

/** Escape HTML special characters in an attribute value (mirrors meno-core's libraryLoader). */
function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
