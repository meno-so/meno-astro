/**
 * meno-astro/server — `loadI18nConfig`.
 *
 * Reads a converted project's `project.config.json`, pulls its `.i18n` block, and runs it
 * through meno-core's `migrateI18nConfig` so both the modern `LocaleConfig[]` shape and the
 * legacy `string[]` locales shape resolve to a canonical {@link I18nConfig}. Any failure
 * (missing file, unparseable JSON, absent/empty `.i18n`) degrades to
 * `DEFAULT_I18N_CONFIG` rather than throwing — a project should always render in *some*
 * locale, even one that predates i18n config.
 *
 * This is the single source of truth the locale middleware (and, by extension, every
 * `i18n()` call) reads its config from. It is server/build-only (touches the filesystem)
 * and reuses meno-core wholesale — no migration logic is reinvented here.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { migrateI18nConfig, DEFAULT_I18N_CONFIG } from 'meno-core/shared';
import type { I18nConfig } from 'meno-core/shared';

/**
 * Per-project mtime memo. This loader sits on the RENDER hot path — BaseLayout,
 * LocaleList, and (via the slug-map loaders) every `localizeHref` call re-resolve the
 * config, so an `astro build` would otherwise read + JSON.parse + migrate the same
 * unchanged file tens of thousands of times. One `statSync` per call replaces the full
 * parse; an mtime change (editor config save) re-reads on the next call, so dev
 * freshness is preserved.
 */
const cache = new Map<string, { mtimeMs: number; config: I18nConfig }>();

/**
 * Load the i18n config for the project rooted at `projectRoot`.
 *
 * Resolution:
 *   1. Read `<projectRoot>/project.config.json`. Missing/unreadable → `DEFAULT_I18N_CONFIG`.
 *   2. Take its `.i18n` value and run `migrateI18nConfig` (handles modern + legacy shapes,
 *      and itself falls back to `DEFAULT_I18N_CONFIG` for anything it can't interpret).
 *
 * Never throws: every failure path returns `DEFAULT_I18N_CONFIG`.
 */
export function loadI18nConfig(projectRoot: string): I18nConfig {
  try {
    const cfgPath = join(projectRoot, 'project.config.json');
    const { mtimeMs } = statSync(cfgPath); // throws when missing → DEFAULT below
    const cached = cache.get(projectRoot);
    if (cached && cached.mtimeMs === mtimeMs) return cached.config;
    const raw = readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw) as { i18n?: unknown };
    // migrateI18nConfig itself returns DEFAULT_I18N_CONFIG for undefined/empty/invalid.
    const config = migrateI18nConfig(parsed.i18n);
    cache.set(projectRoot, { mtimeMs, config });
    return config;
  } catch {
    return DEFAULT_I18N_CONFIG;
  }
}
