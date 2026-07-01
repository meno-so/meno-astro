/**
 * Synchronous reader for a project's px→rem conversion setting, read from
 * `project.config.json` (`remConversion: { enabled, baseFontSize }`).
 *
 * meno-core's render path resolves this via `ConfigService.getRemConversion()` and feeds it
 * into the CSS generators; the meno-astro build path's utility-CSS `rebuild()` needs the same
 * value but can't `await`, so this reads the JSON directly (the same approach as
 * {@link readScaleConfigSync} / {@link readKnownTokensSync}). The conversion itself lives in
 * the node-free ../dialect/remConversion.ts (shared with the app-side codec).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_REM_CONFIG, type RemConversionConfig } from '../dialect/remConversion';

export type { RemConversionConfig } from '../dialect/remConversion';

/**
 * Best-effort: a missing/unreadable/invalid `project.config.json`, or an absent
 * `remConversion` block, resolves to the disabled default — never throws. Mirrors
 * `ConfigService.getRemConversion()`.
 */
export function readRemConfigSync(projectRoot: string): RemConversionConfig {
  let cfg: { remConversion?: Partial<RemConversionConfig> } | null = null;
  try {
    cfg = JSON.parse(readFileSync(join(projectRoot, 'project.config.json'), 'utf8'));
  } catch {
    cfg = null;
  }
  const rem = cfg?.remConversion;
  if (!rem || typeof rem !== 'object') return { ...DEFAULT_REM_CONFIG };
  return {
    enabled: rem.enabled ?? DEFAULT_REM_CONFIG.enabled,
    baseFontSize: rem.baseFontSize ?? DEFAULT_REM_CONFIG.baseFontSize,
  };
}
