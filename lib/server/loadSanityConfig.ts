/**
 * meno-astro/server — `loadSanityConfig`.
 *
 * Reads a converted project's `project.config.json` and returns its Sanity CMS connection
 * info (`integrations.sanity` — projectId/dataset/apiVersion/useCdn) that the runtime
 * `getSanityData` helper turns into a GROQ query URL. Read-only, PUBLIC datasets only:
 * there is no token field (no auth header is ever sent).
 *
 * A missing file, unparseable JSON, or a config without a non-empty `projectId`+`dataset`
 * degrades to `null` rather than throwing (the `loadSiteUrl`/`loadI18nConfig` convention —
 * a project must always build; a Sanity list/template with no config just renders empty).
 * `apiVersion` defaults to `2024-01-01` and `useCdn` to `true` (the cached `apicdn` host).
 *
 * Server/build-only (touches the filesystem); called with `process.cwd()` (= project root
 * during `astro dev`/`build`) by `getSanityData`. Mtime-memoized like `loadSiteUrl` — a
 * page may run several Sanity fetches, each of which would otherwise re-read + JSON.parse
 * the same unchanged file.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The resolved Sanity connection (defaults filled in). */
export interface SanityRuntimeConfig {
  projectId: string;
  dataset: string;
  apiVersion: string;
  useCdn: boolean;
}

interface RawSanity {
  projectId?: unknown;
  dataset?: unknown;
  apiVersion?: unknown;
  useCdn?: unknown;
}

/** Per-project mtime memo (see `loadSiteUrl` for the rationale). */
const cache = new Map<string, { mtimeMs: number; config: SanityRuntimeConfig | null }>();

/**
 * Load the Sanity connection for the project rooted at `projectRoot`.
 *
 * Resolution:
 *   1. Read `<projectRoot>/project.config.json`. Missing/unreadable → `null`.
 *   2. Take its `.integrations.sanity`; require non-empty string `projectId` + `dataset`,
 *      else → `null`. `apiVersion` defaults to `2024-01-01`; `useCdn` defaults to `true`.
 *
 * Never throws: every failure path returns `null` (Sanity lists/templates render empty).
 */
export function loadSanityConfig(projectRoot: string): SanityRuntimeConfig | null {
  try {
    const cfgPath = join(projectRoot, 'project.config.json');
    const { mtimeMs } = statSync(cfgPath); // throws when missing → null below
    const cached = cache.get(projectRoot);
    if (cached && cached.mtimeMs === mtimeMs) return cached.config;

    const parsed = JSON.parse(readFileSync(cfgPath, 'utf8')) as { integrations?: { sanity?: RawSanity } };
    const sanity = parsed.integrations?.sanity;
    let config: SanityRuntimeConfig | null = null;
    if (sanity && typeof sanity.projectId === 'string' && typeof sanity.dataset === 'string') {
      const projectId = sanity.projectId.trim();
      const dataset = sanity.dataset.trim();
      if (projectId !== '' && dataset !== '') {
        const apiVersion =
          typeof sanity.apiVersion === 'string' && sanity.apiVersion.trim() !== ''
            ? sanity.apiVersion.trim()
            : '2024-01-01';
        config = { projectId, dataset, apiVersion, useCdn: sanity.useCdn !== false };
      }
    }
    cache.set(projectRoot, { mtimeMs, config });
    return config;
  } catch {
    return null;
  }
}
