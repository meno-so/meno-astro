/**
 * Which library entries are emitted as native Astro/Vite ESM `import`s (so Vite bundles +
 * fingerprints them) vs left as `<link>`/`<script src>` tags (rendered at build by
 * `loadLibraries` → BaseLayout).
 *
 * Rule (Phase 2 — "optimize local files via Astro"):
 *  - **Local CSS** (`url` starts with `/`)            → ESM import. CSS imports are always safe.
 *  - **Local JS with `type:'module'`**                → ESM import. Module scripts are safe to import.
 *  - **Local JS classic** (default) + **all external** → stay tags. A classic/IIFE script can rely
 *    on global execution (`document.currentScript`, no module scope) so it must NOT be bundled;
 *    external CDN URLs can't be bundled at all.
 *
 * The import is emitted as a bare side-effect `import '…';`, which the parser ignores (it only
 * tracks `.astro` component imports — see parseFrontmatter), so it is re-derived from the
 * `libraries` config on every emit and round-trips with no model field — exactly like the
 * `import '../styles/theme.css'` line in emitPage. The `libraries` config literal
 * (`__meno.libraries` / page `const meta`) stays the single round-trippable source of truth.
 *
 * Pure (no fs); shared by the emitters (emitPage/emitComponent), the converter
 * (convertProject's `__componentLibraries`) and `loadLibraries`, so all three agree on the
 * local-vs-external split and nothing is double-loaded.
 */

import type { LibrariesConfig, CSSLibraryConfig, JSLibraryConfig } from 'meno-core/shared';

/** A library URL is local when it is a project-root path (`/libraries/x.css`), not a CDN URL. */
export function isLocalLibraryUrl(url: string): boolean {
  return url.startsWith('/');
}

/** A CSS library that should be emitted as a Vite import (local file). */
export function isImportedCss(lib: CSSLibraryConfig): boolean {
  return isLocalLibraryUrl(lib.url);
}

/** A JS library that should be emitted as a Vite import (local ES module). */
export function isImportedJs(lib: JSLibraryConfig): boolean {
  return isLocalLibraryUrl(lib.url) && lib.type === 'module';
}

/**
 * The local library URLs (CSS first, then module JS) that should be emitted as Vite ESM
 * imports for the given config, in stable order. Each URL is a project-root path
 * (`/libraries/x.css`); the caller turns it into a file-relative import specifier.
 */
export function importedLibraryUrls(libs?: LibrariesConfig): string[] {
  if (!libs) return [];
  const urls: string[] = [];
  for (const css of libs.css || []) if (isImportedCss(css)) urls.push(css.url);
  for (const js of libs.js || []) if (isImportedJs(js)) urls.push(js.url);
  return urls;
}

/**
 * Drop the entries that are emitted as Vite imports, leaving only what `loadLibraries` should
 * render as tags (external + local classic JS). Preserves any extra fields (e.g. a page tier's
 * `mode`). Used to keep the import path and the tag path from double-loading the same file.
 */
export function stripImportedLibraries<T extends LibrariesConfig>(libs: T): T {
  return {
    ...libs,
    css: (libs.css || []).filter((c) => !isImportedCss(c)),
    js: (libs.js || []).filter((j) => !isImportedJs(j)),
  };
}
