/**
 * meno-astro/server — `loadIconsConfig`.
 *
 * Reads a converted project's `project.config.json` and returns its `icons` object —
 * the favicon / dark-favicon / apple-touch-icon hrefs the Studio "Icons" settings panel
 * writes (`packages/studio/.../ProjectSettings/IconsSection.tsx`). `BaseLayout.astro`
 * turns these into `<link rel="icon">` / `<link rel="apple-touch-icon">` tags in `<head>`,
 * the dialect twin of meno-core's SSR favicon emission (`htmlGenerator.ts`).
 *
 * The href values are root-absolute paths into the project's bridged asset dirs
 * (e.g. `/icons/favicon.svg`) — served at runtime by the `meno()` integration's
 * static-asset middleware in `astro dev` and copied into `dist/` on `astro build`
 * (`icons` is in `MENO_ASSET_DIRS`), so the same href resolves in dev, preview, and
 * the deployed site without a `public/` dir.
 *
 * A missing file, unparseable JSON, or a missing/non-object `icons` key all degrade to
 * `{}` rather than throwing (the `loadSiteUrl`/`loadI18nConfig` convention: a project must
 * always build, with or without icons configured). Mtime-memoized — BaseLayout calls this
 * on every page render, so a build would otherwise re-read + JSON.parse the same unchanged
 * file once per page.
 *
 * Server/build-only (touches the filesystem); called with `process.cwd()` (= project root
 * during `astro dev`/`build`) by the published BaseLayout, same contract as `loadFontCss`.
 */

import { readFileSync, statSync } from 'fs';
import { join } from 'path';

/** Favicon hrefs from `project.config.json`'s `icons` object (all optional). */
export interface IconsConfig {
  favicon?: string;
  faviconDark?: string;
  appleTouchIcon?: string;
}

/** Per-project mtime memo (see `loadSiteUrl` for the rationale). */
const cache = new Map<string, { mtimeMs: number; icons: IconsConfig }>();

/** Keep only the string-valued known icon keys (drops nulls / non-strings the editor never writes). */
function pickIcons(raw: unknown): IconsConfig {
  if (!raw || typeof raw !== 'object') return {};
  const src = raw as Record<string, unknown>;
  const out: IconsConfig = {};
  for (const key of ['favicon', 'faviconDark', 'appleTouchIcon'] as const) {
    const v = src[key];
    if (typeof v === 'string' && v.trim() !== '') out[key] = v;
  }
  return out;
}

/**
 * Load the icons config for the project rooted at `projectRoot`.
 *
 * Resolution:
 *   1. Read `<projectRoot>/project.config.json`. Missing/unreadable → `{}`.
 *   2. Take its `.icons`; non-object / empty → `{}`; otherwise the string-valued
 *      `favicon` / `faviconDark` / `appleTouchIcon` keys.
 *
 * Never throws: every failure path returns `{}` (the "no favicons" mode — BaseLayout
 * emits no icon tags, matching meno-core SSR when `icons` is absent).
 */
export function loadIconsConfig(projectRoot: string): IconsConfig {
  try {
    const cfgPath = join(projectRoot, 'project.config.json');
    const { mtimeMs } = statSync(cfgPath); // throws when missing → {} below
    const cached = cache.get(projectRoot);
    if (cached && cached.mtimeMs === mtimeMs) return cached.icons;
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8')) as { icons?: unknown };
    const icons = pickIcons(parsed.icons);
    cache.set(projectRoot, { mtimeMs, icons });
    return icons;
  } catch {
    return {};
  }
}
