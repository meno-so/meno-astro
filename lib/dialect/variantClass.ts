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

import { classToStyle } from 'meno-core/shared';

const VAR_TOKEN_SHORTHAND = /-\(--[\w-]+\)/;
const BARE_TOKEN = /^[\w-]+$/;

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
