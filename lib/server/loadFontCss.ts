/**
 * meno-astro/server — `loadFontCss`.
 *
 * Reads a project's `project.config.json`, pulls its `fonts` array, and renders the
 * `@font-face` rules + `<link rel="preload">` tags for `BaseLayout.astro` to drop into
 * `<head>`. This is the dialect twin's counterpart to what meno-core's SSR
 * (`htmlGenerator`) and JSON→Astro export (`build-astro`) already emit — without it the
 * font files ship but are never *defined*, so any `font-family: 'Inter'` declared via
 * `style()` silently falls back to a system font.
 *
 * Formatting is delegated wholesale to meno-core's pure `fontCss` helpers so all three
 * renderers stay byte-identical. Any failure (missing file, bad JSON, no `fonts`)
 * degrades to empty strings — a project always renders, just without custom fonts.
 *
 * Server/build-only (touches the filesystem); BaseLayout's frontmatter runs at
 * build/SSR time, never in the browser.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// Import from the `meno-core/shared` barrel (not the deep `./fontCss` path): the
// published meno-core bundles shared modules into the barrel and does not emit
// `dist/lib/shared/fontCss.js`, so the deep path would 404 in a consumer project.
import { fontFaceCss, fontPreloadLinks, type FontConfig } from 'meno-core/shared';

export interface FontHeadAssets {
  /** `@font-face` rules for a `<style>` tag (empty string when no fonts). */
  css: string;
  /** `<link rel="preload">` tags (empty string when no fonts). */
  preloads: string;
}

const EMPTY: FontHeadAssets = { css: '', preloads: '' };

/**
 * Load font `<head>` assets for the project rooted at `projectRoot`.
 *
 * Resolution: read `<projectRoot>/project.config.json`, take its `.fonts` array, and
 * format it. Never throws — every failure path returns empty strings.
 */
export function loadFontCss(projectRoot: string): FontHeadAssets {
  try {
    const cfgPath = join(projectRoot, 'project.config.json');
    if (!existsSync(cfgPath)) return EMPTY;
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8')) as { fonts?: FontConfig[] };
    const fonts = Array.isArray(parsed.fonts) ? parsed.fonts : [];
    if (fonts.length === 0) return EMPTY;
    return { css: fontFaceCss(fonts), preloads: fontPreloadLinks(fonts) };
  } catch {
    return EMPTY;
  }
}
