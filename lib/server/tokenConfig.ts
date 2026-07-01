/**
 * Resolver for a project's defined design-token names — the `knownTokens` set the
 * utility-CSS generators use to recognize the BARE color-token class form
 * (`bg-primary` → `var(--primary)`).
 *
 * A bare `bg-<name>` is syntactically indistinguishable from a foreign / authored
 * class (`text-wrapper`, an imported `bg-dark`). The generators only treat
 * `bg-<name>` as a token when `<name>` is in this set, so authored classes are
 * never misclassified and never gain a stray `var(--…)` rule. The self-describing
 * `var(--…)` shorthand form (`bg-(--primary)`) needs no token set.
 *
 * Tokens are the CSS custom-property names (minus the `--` prefix) that
 * `src/styles/theme.css` defines — and theme.css IS the source of truth: it carries
 * every color (across every theme) and every variable as a `--<name>:` declaration,
 * so its declared property names ARE the token set. We read them straight from it
 * rather than the JSON it used to be generated from, because `colors.json` /
 * `variables.json` have been retired (theme.css migration) — a converted project no
 * longer ships them, so the old JSON read returned an EMPTY set and every bare
 * color-token class (`bg-bg`, `text-text`, `border-border`) lost its CSS rule.
 *
 * The legacy JSON files are still read as a FALLBACK for any un-migrated project that
 * has them but no theme.css. Best-effort throughout — a missing/invalid source
 * contributes nothing and never throws (a project with no tokens just gets an empty
 * set, i.e. the original behavior for the bare form).
 *
 * Self-contained on purpose: it only needs the custom-property NAMES, so it parses
 * theme.css with a local regex instead of importing meno-core's theme codec — the
 * integration's utility-CSS path stays on `meno-core/shared` only (the play runtime
 * installs meno-core from npm; a `/server` import would couple this to that build's
 * core version — see the runtime-provisioning rules).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Custom-property names declared in a theme.css source (minus the `--` prefix). Matches
 * `--name:` DECLARATIONS only — `var(--ref)` uses inside values end in `)` not `:`, so
 * they're ignored — and strips comments first so prose in the banner can't leak a token.
 */
function themeCssTokenNames(css: string): string[] {
  const names: string[] = [];
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of withoutComments.matchAll(/--([\w-]+)\s*:/g)) names.push(m[1]!);
  return names;
}

/** Read the project's color + variable token names. Pure function of a project path. */
export function readKnownTokensSync(projectRoot: string): Set<string> {
  const tokens = new Set<string>();

  // theme.css — the source of truth: every `--<name>:` declaration (colors + variables).
  try {
    const css = readFileSync(join(projectRoot, 'src', 'styles', 'theme.css'), 'utf8');
    for (const name of themeCssTokenNames(css)) tokens.add(name);
  } catch {
    // missing/unreadable theme.css → fall through to the legacy JSON token files
  }

  // Already resolved from theme.css → done. The JSON files below are the legacy fallback,
  // only consulted when theme.css is absent/empty (a project predating the migration).
  if (tokens.size > 0) return tokens;

  // colors.json — every color name across every theme is a `--<name>` custom property.
  try {
    const colors = JSON.parse(readFileSync(join(projectRoot, 'colors.json'), 'utf8')) as {
      themes?: Record<string, { colors?: Record<string, unknown> }>;
    };
    const themes = colors?.themes;
    if (themes && typeof themes === 'object') {
      for (const theme of Object.values(themes)) {
        const cols = theme?.colors;
        if (cols && typeof cols === 'object') {
          for (const name of Object.keys(cols)) tokens.add(name);
        }
      }
    }
  } catch {
    // missing/invalid colors.json → no color tokens
  }

  // variables.json — each variable defines a `cssVar` custom property (`--h1-fs`).
  try {
    const vars = JSON.parse(readFileSync(join(projectRoot, 'variables.json'), 'utf8')) as {
      variables?: Array<{ cssVar?: unknown }>;
    };
    const list = vars?.variables;
    if (Array.isArray(list)) {
      for (const v of list) {
        const cssVar = v?.cssVar;
        if (typeof cssVar === 'string' && cssVar) tokens.add(cssVar.replace(/^--/, ''));
      }
    }
  } catch {
    // missing/invalid variables.json → no variable tokens
  }

  return tokens;
}
