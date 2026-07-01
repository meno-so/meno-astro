/**
 * meno-astro/server — `loadCustomCode`.
 *
 * Reads a converted project's `project.config.json` and returns its `customCode` object —
 * the global head / bodyStart / bodyEnd HTML the Studio settings panel writes
 * (`PageMetaData.customCode` for per-page; `config.customCode` for project-wide). meno-core's
 * SSR merges global + page custom code and injects it into `<head>`, after `<body>`, and
 * before `</body>` (`htmlGenerator.ts` — `configService.getCustomCode()` + `pageCustomCode`).
 * `BaseLayout.astro` reproduces that here so the astro dialect has the same custom-code seam.
 *
 * The whole project config (including `customCode`) is carried wholesale into the converted
 * project by `convertProject` (it copies the source `project.config.json`), so this reads it
 * the same way `loadIconsConfig` / `loadSiteUrl` read `icons` / `siteUrl`.
 *
 * A missing file, unparseable JSON, or a missing/non-object `customCode` key all degrade to
 * `{}` rather than throwing (the `loadIconsConfig`/`loadSiteUrl` convention: a project must
 * always build, with or without custom code configured). Mtime-memoized — BaseLayout calls
 * this on every page render, so a build would otherwise re-read + JSON.parse the same
 * unchanged file once per page.
 *
 * Server/build-only (touches the filesystem); called with `process.cwd()` (= project root
 * during `astro dev`/`build`) by the published BaseLayout, same contract as `loadIconsConfig`.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Custom-code injection HTML from `project.config.json`'s `customCode` object (all optional). */
export interface CustomCodeConfig {
  /** Inserted into `<head>`. */
  head?: string;
  /** Inserted right after `<body>`. */
  bodyStart?: string;
  /** Inserted before `</body>`. */
  bodyEnd?: string;
}

/** Per-project mtime memo (see `loadSiteUrl` for the rationale). */
const cache = new Map<string, { mtimeMs: number; customCode: CustomCodeConfig }>();

/** Keep only the string-valued known keys (drops nulls / non-strings / empties). */
function pickCustomCode(raw: unknown): CustomCodeConfig {
  if (!raw || typeof raw !== 'object') return {};
  const src = raw as Record<string, unknown>;
  const out: CustomCodeConfig = {};
  for (const key of ['head', 'bodyStart', 'bodyEnd'] as const) {
    const v = src[key];
    if (typeof v === 'string' && v.trim() !== '') out[key] = v;
  }
  return out;
}

/**
 * Load the project-wide custom code for the project rooted at `projectRoot`.
 *
 * Resolution:
 *   1. Read `<projectRoot>/project.config.json`. Missing/unreadable → `{}`.
 *   2. Take its `.customCode`; non-object / empty → `{}`; otherwise the string-valued
 *      `head` / `bodyStart` / `bodyEnd` keys.
 *
 * Never throws: every failure path returns `{}` (the "no custom code" mode — BaseLayout
 * injects nothing, matching meno-core SSR when `customCode` is absent).
 */
export function loadCustomCode(projectRoot: string): CustomCodeConfig {
  try {
    const cfgPath = join(projectRoot, 'project.config.json');
    const { mtimeMs } = statSync(cfgPath); // throws when missing → {} below
    const cached = cache.get(projectRoot);
    if (cached && cached.mtimeMs === mtimeMs) return cached.customCode;
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8')) as { customCode?: unknown };
    const customCode = pickCustomCode(parsed.customCode);
    cache.set(projectRoot, { mtimeMs, customCode });
    return customCode;
  } catch {
    return {};
  }
}

/**
 * Merge project-wide custom code with a page's `meta.customCode` (page appended after global,
 * mirroring meno-core SSR's `[global, page].filter(Boolean).join('\n')` order). Returns the
 * merged head / bodyStart / bodyEnd strings (empty when neither level set a section).
 */
export function mergeCustomCode(
  global: CustomCodeConfig,
  page: CustomCodeConfig | undefined,
): Required<CustomCodeConfig> {
  const join = (a?: string, b?: string) => [a, b].filter(Boolean).join('\n');
  return {
    head: join(global.head, page?.head),
    bodyStart: join(global.bodyStart, page?.bodyStart),
    bodyEnd: join(global.bodyEnd, page?.bodyEnd),
  };
}
