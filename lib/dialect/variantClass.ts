/**
 * Variant-aware utility-class decode, shared by the emit gate (`mappingConvertibleToClasses`) and
 * the parse reconstruction (`interpretVariantsCall`) so they agree exactly.
 *
 * It is `classToStyle` plus one correction: the color var-token SHORTHAND (`text-(--text)`) decodes
 * to a BARE token (`text`) because `classToStyle` canonicalizes `var(--x)`→`x` for color props.
 * Meno stores those values as `var(--x)` (the model convention, used throughout `example/`), so we
 * re-wrap the bare token back to `var(--x)`. Because the convertibility gate uses THIS decode, a
 * value only converts to a class when the decode recovers the original exactly — so the re-wrap is
 * self-protecting: anything it would get wrong stays on the `style()` path.
 */

import { classToStyle, responsiveStylesToClasses } from 'meno-core/shared';
import type { ResponsiveStyleObject } from 'meno-core/shared';

const VAR_TOKEN_SHORTHAND = /-\(--[\w-]+\)/;
const BARE_TOKEN = /^[\w-]+$/;

/** Color CSS prop → its class root, for keeping the `var()` shorthand in variant tables. */
const VARIANT_COLOR_ROOT: Record<string, string> = {
  color: 'text',
  backgroundColor: 'bg',
  borderColor: 'border',
  accentColor: 'accent',
  outlineColor: 'outline',
};

/**
 * The variant-TABLE utility class for a CSS prop+value at a breakpoint (the runtime `variants()`
 * form), or undefined for the empty value. The exact inverse of `decodeVariantClass`, and the
 * single source of truth for a variant table's class names — used by the emit gate
 * (`mappingConvertibleToClasses` / table build) AND the build-time utility-CSS collector, so the CSS
 * generated matches the class the runtime renders.
 *
 * It is `responsiveStylesToClasses` plus one correction: a `var(--token)` color value emits the BARE
 * token form (`text-muted`) in the static engine, but variant tables keep the self-describing `var()`
 * SHORTHAND (`text-(--muted)`) so they round-trip through `decodeVariantClass` without the project
 * token set (the table is parsed/built standalone). Keep this in lock-step with `decodeVariantClass`.
 */
export function variantClassFor(cssProp: string, value: string | number, bp: string): string | undefined {
  if (value === '') return undefined;
  const responsive: ResponsiveStyleObject = { [bp]: { [cssProp]: value } };
  const cls = responsiveStylesToClasses(responsive)[0];
  if (!cls) return cls;
  const root = VARIANT_COLOR_ROOT[cssProp];
  const varMatch = typeof value === 'string' ? value.match(/^var\((--[\w-]+)\)$/) : null;
  if (root && varMatch?.[1]) {
    const bare = `${root}-${varMatch[1].slice(2)}`;
    if (cls.endsWith(bare)) return `${cls.slice(0, -bare.length)}${root}-(${varMatch[1]})`;
  }
  return cls;
}

export function decodeVariantClass(cls: string): { prop: string; value: string } | null {
  const entry = classToStyle(cls);
  if (!entry) return null;
  // A var-token shorthand color class whose value classToStyle stripped to a bare token → restore
  // Meno's `var(--x)` form. (Arbitrary forms like `[background:var(--primary)]` keep var() already.)
  if (VAR_TOKEN_SHORTHAND.test(cls) && BARE_TOKEN.test(entry.value)) {
    return { prop: entry.prop, value: `var(--${entry.value})` };
  }
  return entry;
}
