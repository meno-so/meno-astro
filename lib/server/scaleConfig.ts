/**
 * Shared resolver for the responsive-scaling inputs the CSS generators need
 * (`breakpoints` + `responsiveScales`), read from a project's `project.config.json`.
 *
 * Reproduces what meno-core's SSR feeds the generators at request time
 * (`ConfigService.getBreakpoints()` + `getResponsiveScales()`, htmlGenerator.ts:422-427),
 * but as a pure function of a parsed config object so it can be driven from either:
 *   - the async converter ({@link resolveScaleConfigFromObject} via `convertProject`'s
 *     `readJsonSafe`), which derives `src/styles/theme.css`, and
 *   - the synchronous integration utility-CSS rebuild ({@link readScaleConfigSync}),
 *     which derives the per-class utility/interactive stylesheet.
 *
 * Both must use the SAME merge so the emitted `@media` / `clamp()` scaling matches the
 * runtime (and each other). We read the JSON directly rather than going through
 * meno-core's config services because those resolve paths from a *global* project root
 * (projectContext/cwd); these consumers are pure functions of a project path, so wiring
 * the global singletons in would couple them to ambient state.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { normalizeBreakpointConfig, DEFAULT_BREAKPOINTS, DEFAULT_RESPONSIVE_SCALES } from 'meno-core/shared';
import type { BreakpointConfig, BreakpointConfigInput, ResponsiveScales, BreakpointScales } from 'meno-core/shared';

/** The slice of `project.config.json` this resolver reads. */
export interface ScaleConfigInput {
  breakpoints?: BreakpointConfigInput;
  responsiveScales?: Partial<ResponsiveScales>;
}

/**
 * Pure resolution of a parsed `project.config.json` (or `null`) into the
 * `{ breakpoints, responsiveScales }` pair the CSS generators consume. Absent/invalid
 * config falls back to the same defaults meno-core uses, so a variable/class still gets
 * its static base value either way. {@link normalizeBreakpointConfig} +
 * {@link mergeResponsiveScales} reproduce `ConfigService.getBreakpoints()` +
 * `getResponsiveScales()`.
 */
export function resolveScaleConfigFromObject(cfg: ScaleConfigInput | null): {
  breakpoints: BreakpointConfig;
  responsiveScales: ResponsiveScales;
} {
  const normalized =
    cfg?.breakpoints && typeof cfg.breakpoints === 'object' ? normalizeBreakpointConfig(cfg.breakpoints) : {};
  const breakpoints = Object.keys(normalized).length ? normalized : { ...DEFAULT_BREAKPOINTS };
  return { breakpoints, responsiveScales: mergeResponsiveScales(cfg?.responsiveScales) };
}

/**
 * Synchronous reader for callers that can't `await` (the integration's utility-CSS
 * `rebuild()`). Best-effort: a missing/unreadable/invalid `project.config.json` resolves
 * to the meno-core defaults, never throws.
 */
export function readScaleConfigSync(projectRoot: string): {
  breakpoints: BreakpointConfig;
  responsiveScales: ResponsiveScales;
} {
  let cfg: ScaleConfigInput | null = null;
  try {
    cfg = JSON.parse(readFileSync(join(projectRoot, 'project.config.json'), 'utf8')) as ScaleConfigInput;
  } catch {
    cfg = null;
  }
  return resolveScaleConfigFromObject(cfg);
}

/**
 * Reproduce `ConfigService.getResponsiveScales()`: user values win, but each scale
 * category falls back to meno-core's defaults for breakpoints the user didn't set, so a
 * `borderRadius`/`size`-typed variable/class still scales exactly as it does at runtime.
 */
function mergeResponsiveScales(raw: Partial<ResponsiveScales> | undefined): ResponsiveScales {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_RESPONSIVE_SCALES };
  const d = DEFAULT_RESPONSIVE_SCALES;
  const mergeCategory = (
    user: BreakpointScales | undefined,
    def: BreakpointScales | undefined,
  ): BreakpointScales | undefined => {
    if (!user && !def) return undefined;
    if (!user) return def ? { ...def } : undefined;
    if (!def) return { ...user };
    return { ...def, ...user };
  };
  return {
    enabled: raw.enabled ?? d.enabled,
    mode: raw.mode ?? d.mode,
    baseReference: raw.baseReference ?? d.baseReference,
    fluidRange: raw.fluidRange ?? (d.fluidRange ? { ...d.fluidRange } : undefined),
    siteMargin: raw.siteMargin ?? (d.siteMargin ? { ...d.siteMargin } : undefined),
    fontSize: mergeCategory(raw.fontSize, d.fontSize),
    padding: mergeCategory(raw.padding, d.padding),
    margin: mergeCategory(raw.margin, d.margin),
    gap: mergeCategory(raw.gap, d.gap),
    borderRadius: mergeCategory(raw.borderRadius, d.borderRadius),
    size: mergeCategory(raw.size, d.size),
  };
}
