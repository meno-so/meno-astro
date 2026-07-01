/**
 * meno-astro/server — `loadSocial`.
 *
 * Reads a converted project's `project.config.json` and returns its `social` object — the
 * site-wide social configuration (currently just `twitterHandle`) that meno-core's
 * `configService.getSocial()` exposes to the SSR meta-tag generator. `BaseLayout.astro` feeds
 * `twitterHandle` into `buildSocialMetaTags`, which emits `<meta name="twitter:site">` /
 * `<meta name="twitter:creator">` — the dialect twin of meno-core's SSR Twitter block.
 *
 * A missing file, unparseable JSON, or a missing/non-object `social` key all degrade to `{}`
 * rather than throwing (the `loadSiteUrl`/`loadIconsConfig` convention: a project must always
 * build, with or without social config). Mtime-memoized — BaseLayout calls this on every page
 * render, so a build would otherwise re-read + JSON.parse the same unchanged file once per page.
 *
 * Server/build-only (touches the filesystem); called with `process.cwd()` (= project root
 * during `astro dev`/`build`) by the published BaseLayout, same contract as `loadSiteUrl`.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Site-wide social config from `project.config.json`'s `social` object (all optional). */
export interface SocialConfig {
  /** Twitter/X handle (with or without a leading `@`) → twitter:site / twitter:creator. */
  twitterHandle?: string;
}

/** Per-project mtime memo (see `loadSiteUrl` for the rationale). */
const cache = new Map<string, { mtimeMs: number; social: SocialConfig }>();

/**
 * Load the social config for the project rooted at `projectRoot`.
 *
 * Resolution:
 *   1. Read `<projectRoot>/project.config.json`. Missing/unreadable → `{}`.
 *   2. Take its `.social`; non-object → `{}`; otherwise the string-valued, non-empty
 *      `twitterHandle` (trimmed).
 *
 * Never throws: every failure path returns `{}` (the "no social config" mode — BaseLayout
 * emits no twitter:site/creator tags, matching meno-core SSR when `social` is absent).
 */
export function loadSocial(projectRoot: string): SocialConfig {
  try {
    const cfgPath = join(projectRoot, 'project.config.json');
    const { mtimeMs } = statSync(cfgPath); // throws when missing → {} below
    const cached = cache.get(projectRoot);
    if (cached && cached.mtimeMs === mtimeMs) return cached.social;
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8')) as { social?: unknown };
    const social: SocialConfig = {};
    if (parsed.social && typeof parsed.social === 'object') {
      const handle = (parsed.social as Record<string, unknown>).twitterHandle;
      if (typeof handle === 'string' && handle.trim() !== '') {
        social.twitterHandle = handle.trim();
      }
    }
    cache.set(projectRoot, { mtimeMs, social });
    return social;
  } catch {
    return {};
  }
}
