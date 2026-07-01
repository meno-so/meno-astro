/**
 * px→rem conversion — a meno-astro-local, node-free copy of meno-core's `pxToRem.ts`.
 *
 * meno-core's render path feeds `RemConversionConfig` into its CSS generators so the
 * "Convert px to rem" project setting takes effect. The meno-astro build path must do the
 * same. The two meno-core generators it uses (`generateUtilityCSS`/`generateInteractiveCSS`)
 * already take a `remConfig` arg and convert internally — but the meno-astro-local
 * state-variant CSS (`generateStateVariantCss`, which assembles decls from the published
 * `generateRuleForClass`) has to convert its own declarations.
 *
 * ── Published-only by design (see dialect/styleValues.ts) ────────────────────────────────
 * `meno-core/shared` does NOT export `pxToRem`, and this module is imported app-side by the
 * codec (interactiveVariants), so it must stay free of node built-ins. Hence this faithful,
 * byte-identical copy (same `PX_KEEP_PROPERTIES`, same rounding) rather than a core import —
 * keeping every CSS path's output identical. Keep in sync with packages/core/lib/shared/pxToRem.ts.
 * (The `project.config.json` reader lives in ../server/remConfig.ts, which CAN use node:fs.)
 */

/** Structurally identical to meno-core's `RemConversionConfig` (so it's assignable to the
 *  generators' `remConfig` param under structural typing). */
export interface RemConversionConfig {
  enabled: boolean;
  baseFontSize: number;
}

export const DEFAULT_REM_CONFIG: RemConversionConfig = {
  enabled: false,
  baseFontSize: 16,
};

const PX_REGEX = /(-?\d*\.?\d+)px/g;

/**
 * Convert all px values in a CSS value string to rem. Multi-value shorthands
 * ("16px 32px" → "1rem 2rem") are handled; "0px" collapses to unitless "0".
 * Faithful copy of meno-core `convertPxToRem`.
 */
export function convertPxToRem(cssValue: string, baseFontSize: number): string {
  return cssValue.replace(PX_REGEX, (_, num) => {
    const px = parseFloat(num);
    if (px === 0) return '0';
    const rounded = parseFloat((px / baseFontSize).toFixed(4));
    return `${rounded}rem`;
  });
}

/** Properties that keep px (thin borders/shadows) — copy of meno-core's `PX_KEEP_PROPERTIES`. */
const PX_KEEP_PROPERTIES = new Set([
  'border-width',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'outline-width',
  'outline-offset',
  'border',
  'box-shadow',
  'text-shadow',
]);

/**
 * Apply rem conversion to a CSS declarations string (e.g. "padding: 16px; font-size: 18px"),
 * skipping the keep-px properties. A no-op when conversion is disabled. Faithful copy of
 * meno-core `applyRemConversion`.
 */
export function applyRemConversion(declarations: string, remConfig?: RemConversionConfig): string {
  if (!remConfig?.enabled) return declarations;
  return declarations
    .split(';')
    .map((decl) => {
      const trimmed = decl.trim();
      if (!trimmed) return '';
      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) return trimmed;
      const property = trimmed.substring(0, colonIndex).trim();
      const value = trimmed.substring(colonIndex + 1).trim();
      if (!PX_KEEP_PROPERTIES.has(property)) {
        return `${property}: ${convertPxToRem(value, remConfig.baseFontSize)}`;
      }
      return trimmed;
    })
    .filter(Boolean)
    .join('; ');
}
