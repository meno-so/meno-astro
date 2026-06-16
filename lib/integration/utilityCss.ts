/**
 * Build-time utility CSS generation for meno-astro projects.
 *
 * Astro renders <head> before <body>, so a runtime collector flushed by BaseLayout
 * would always be empty. Instead, the meno() integration calls this at build time:
 * it parses every `.astro` source, then for each styled node collects
 *   - the utility classes its base `style({…})` contributes (every prop-`_mapping`
 *     expanded across ALL its `values`), and
 *   - the `:hover`/interactive CSS, scoped to the SAME deterministic class `style()`
 *     emits at runtime (so the class names match), also expanded across variants.
 * meno-core's `generateUtilityCSS`/`generateInteractiveCSS` produce the rules — so the
 * output is byte-identical to the JSON runtime's utility CSS — emitted as ONE global
 * stylesheet that BaseLayout imports.
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from '../dialect';
import {
  responsiveStylesToClasses,
  generateUtilityCSS,
  generateInteractiveCSS,
  isStyleMapping,
  sortClassesByPropertyOrder,
  DEFAULT_BREAKPOINTS,
} from 'meno-core/shared';
import type { BreakpointConfig, ResponsiveScales } from 'meno-core/shared';
import type { StyleValue, StyleObject, InteractiveStyles } from 'meno-core/shared';
import { computeClassName, resolveMappingsInStyle, NODE_RESET_STYLES } from '../runtime/style';
import { templateVarName } from '../runtime/cssValue';

/** Walk `<dir>` recursively, calling `visit` for every `.astro` file path. Shared by
 *  the utility-CSS source scan and the play-patch class-vocabulary scan. */
export function walkAstroFiles(dir: string, visit: (path: string) => void): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkAstroFiles(p, visit);
    else if (e.name.endsWith('.astro')) visit(p);
  }
}

function isResponsive(s: unknown): s is Record<string, StyleObject> {
  return !!s && typeof s === 'object' && ('base' in s || 'tablet' in s || 'mobile' in s);
}

/** Iterate every breakpoint's flat style object of a (responsive-or-flat) style value. */
function eachBpStyle(style: unknown): Array<[string, StyleObject]> {
  if (!style || typeof style !== 'object') return [];
  const byBp = isResponsive(style) ? (style as Record<string, StyleObject>) : { base: style as StyleObject };
  return Object.entries(byBp).filter(([, v]) => v && typeof v === 'object');
}

/** Collect the base utility classes a style value contributes, expanding every mapping. */
function collectClasses(style: unknown, into: Set<string>): void {
  for (const [bp, bpStyle] of eachBpStyle(style)) {
    for (const [prop, value] of Object.entries(bpStyle)) {
      const candidates = isStyleMapping(value)
        ? Object.values((value as { values?: Record<string, unknown> }).values ?? {})
        : [value];
      for (const v of candidates) {
        if (v === undefined || v === null || v === '' || typeof v === 'object') continue;
        // `{{template}}` values can't be a static utility class — they're bridged through a CSS
        // variable: emit the rule that reads `var(--m-<bp>-<prop>)`; the element sets that variable
        // inline (emitInlineStyleAttr). Mirrors the runtime style() resolver (resolveMappingsInFlat)
        // so class names match byte-for-byte. Bridged for EVERY breakpoint incl. `base` — the
        // runtime keeps a component ROOT's base template on the direct-inline path instead (so it
        // never carries this class), but over-generating the unused base rule here is harmless (the
        // sheet over-generates by design) and avoids having to know root-ness during the scan.
        if (typeof v === 'string' && v.includes('{{')) {
          const varVal = `var(${templateVarName(bp, prop)})`;
          const bridged = (bp === 'base' ? { [prop]: varVal } : { [bp]: { [prop]: varVal } }) as StyleValue;
          for (const c of responsiveStylesToClasses(bridged)) into.add(c);
          continue;
        }
        const single = (bp === 'base' ? { [prop]: v } : { [bp]: { [prop]: v } }) as StyleValue;
        for (const c of responsiveStylesToClasses(single)) into.add(c);
      }
    }
  }
}

/** Map of prop → its possible mapping-key values, across a style value's `_mapping`s. */
function mappingPropValues(style: unknown, into: Map<string, Set<string>>): void {
  for (const [, bpStyle] of eachBpStyle(style)) {
    for (const value of Object.values(bpStyle)) {
      if (isStyleMapping(value)) {
        const m = value as { prop: string; values?: Record<string, unknown> };
        const set = into.get(m.prop) ?? new Set<string>();
        for (const k of Object.keys(m.values ?? {})) set.add(k);
        into.set(m.prop, set);
      }
    }
  }
}

/** Cartesian product of prop → values into concrete `{ prop: value }` assignments. */
function cartesian(propValues: Map<string, Set<string>>): Array<Record<string, string>> {
  let combos: Array<Record<string, string>> = [{}];
  for (const [prop, values] of propValues) {
    const next: Array<Record<string, string>> = [];
    for (const combo of combos) for (const v of values) next.push({ ...combo, [prop]: v });
    combos = next;
  }
  return combos;
}

/**
 * Append the `:hover`/interactive CSS for a node's interactive rules — one rule-set per
 * prop-mapping variant — under the same deterministic class `style()` produces.
 */
function collectInteractiveCss(
  interactive: unknown,
  label: string | undefined,
  acc: { css: string; seen: Set<string> },
  breakpoints: BreakpointConfig,
  responsiveScales: ResponsiveScales | undefined,
): void {
  if (!Array.isArray(interactive) || interactive.length === 0) return;
  const rules = interactive as InteractiveStyles;
  const propValues = new Map<string, Set<string>>();
  for (const r of rules) mappingPropValues((r as { style: StyleValue }).style, propValues);
  for (const assignment of cartesian(propValues)) {
    const resolved = rules.map((r) => ({ ...r, style: resolveMappingsInStyle((r as any).style, assignment) }));
    const cls = computeClassName({}, resolved as InteractiveStyles, label);
    if (acc.seen.has(cls)) continue;
    acc.seen.add(cls);
    // responsiveScales is the 5th arg (after the remConfig slot) — applies the same
    // per-breakpoint / clamp() scaling meno-core's SSR does (cssGeneration.ts).
    acc.css +=
      generateInteractiveCSS(cls, resolved as InteractiveStyles, breakpoints, undefined, responsiveScales) + '\n';
  }
}

/**
 * Deep-walk a parsed model's node tree, calling `onNode` for every plain-object
 * node. Recurses into every field EXCEPT `style`/`interactiveStyles` (those are
 * style values the caller reads off the node, not further node trees).
 */
function visitModelNodes(node: unknown, onNode: (node: Record<string, unknown>) => void): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) visitModelNodes(n, onNode);
    return;
  }
  const obj = node as Record<string, unknown>;
  onNode(obj);
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'style' || k === 'interactiveStyles') continue; // read by onNode / not node trees
    visitModelNodes(v, onNode);
  }
}

/** Deep-walk a parsed model's node tree, collecting base + interactive styles. */
function walkModel(
  node: unknown,
  classes: Set<string>,
  inter: { css: string; seen: Set<string> },
  breakpoints: BreakpointConfig,
  responsiveScales: ResponsiveScales | undefined,
): void {
  visitModelNodes(node, (obj) => {
    if (obj.style) collectClasses(obj.style, classes);
    // A node-type UA reset (links: `block no-underline text-inherit`) is applied at render by the
    // Link.astro runtime component (linkClass), not from the model — so collect its rules here
    // unconditionally for every link node, else the classes ship with no CSS. Union (not merge):
    // an explicit `display:flex` keeps its own `flex` rule too; only one lands on a given element
    // (linkClass drops the conflicting reset utility per CSS property).
    const reset = typeof obj.type === 'string' ? NODE_RESET_STYLES[obj.type] : undefined;
    if (reset) collectClasses(reset, classes);
    if (obj.interactiveStyles)
      collectInteractiveCss(
        obj.interactiveStyles,
        obj.label as string | undefined,
        inter,
        breakpoints,
        responsiveScales,
      );
  });
}

/**
 * Every class token any node in a parsed model can render — `collectNodeClassTokens`
 * (all `_mapping` variants expanded, runtime class names) accumulated over the whole
 * tree. The play patch plugin unions this across a project for prop-edit stale tokens.
 */
export function collectModelClassTokens(model: unknown): Set<string> {
  const out = new Set<string>();
  visitModelNodes(model, (obj) => {
    if (obj.style || obj.interactiveStyles || obj.label) {
      for (const t of collectNodeClassTokens(
        obj.style,
        obj.interactiveStyles,
        typeof obj.label === 'string' ? obj.label : undefined,
      )) {
        out.add(t);
      }
    }
  });
  return out;
}

/**
 * Every class TOKEN a node's style + interactive styles put on its rendered element,
 * expanded across all `_mapping` variants — the base utility classes plus each variant's
 * deterministic interactive class (`computeClassName`, the same name `style()` emits at
 * runtime). Used by the play patch plugin to compute the STALE tokens an edit retires
 * (old tokens that must be removed from live elements when the new class list arrives).
 */
export function collectNodeClassTokens(style: unknown, interactive: unknown, label: string | undefined): Set<string> {
  const tokens = new Set<string>();
  if (style) collectClasses(style, tokens);
  if (Array.isArray(interactive) && interactive.length > 0) {
    const rules = interactive as InteractiveStyles;
    const propValues = new Map<string, Set<string>>();
    for (const r of rules) mappingPropValues((r as { style: StyleValue }).style, propValues);
    for (const assignment of cartesian(propValues)) {
      const resolved = rules.map((r) => ({ ...r, style: resolveMappingsInStyle((r as any).style, assignment) }));
      tokens.add(computeClassName({}, resolved as InteractiveStyles, label));
    }
  }
  return tokens;
}

/** One `.astro` source to extract utility CSS from; `path` (when known) labels build warnings. */
export interface UtilitySource {
  src: string;
  path?: string;
}

/**
 * Build the project's global utility + interactive stylesheet from a set of `.astro`
 * sources. A source whose `parse()` throws is skipped (a build must not die on one file)
 * but a WARNING is emitted — a skipped file silently drops every `style()` utility class
 * it defines (its elements render unstyled), and the usual cause is a converter/parser
 * version skew: the converter emitting `.astro` syntax this *published* parser predates
 * (e.g. a new directive attribute). The warning turns that invisible failure into a build
 * signal. Accepts bare strings too (path-less; tests/ad-hoc callers).
 *
 * `breakpoints` + `responsiveScales` (from the project's `project.config.json`, resolved
 * via {@link readScaleConfigSync}) drive the per-class responsive scaling — the same
 * `@media` / `clamp()` size scaling meno-core's SSR and design canvas apply — so the
 * sheet matches the canvas at every breakpoint. Both default so callers that don't scale
 * (tests, ad-hoc) keep their previous unscaled output.
 */
export function buildUtilityStylesheet(
  sources: Array<UtilitySource | string>,
  breakpoints: BreakpointConfig = DEFAULT_BREAKPOINTS,
  responsiveScales?: ResponsiveScales,
): string {
  const classes = new Set<string>();
  const inter = { css: '', seen: new Set<string>() };
  for (const entry of sources) {
    const src = typeof entry === 'string' ? entry : entry.src;
    const path = typeof entry === 'string' ? undefined : entry.path;
    let model: unknown;
    try {
      model = parse(src).model;
    } catch (err) {
      console.warn(
        `[meno-astro] utility-CSS: could not parse ${path ?? 'a .astro file'} — its style() classes ` +
          `will be missing from the page. This usually means the installed meno-astro is older than the ` +
          `converter that produced this file. Parse error: ${(err as Error).message}`,
      );
      continue;
    }
    walkModel(model, classes, inter, breakpoints, responsiveScales);
  }
  // Pass the classes property-sorted (shorthand before longhand). generateUtilityCSS sorts
  // its BASE rules itself, but the auto-responsive @media section emits in the set's
  // iteration order — and some published meno-core builds the play runtime installs DON'T
  // re-sort there. Unsorted, a `margin` shorthand emitted after a `margin-bottom` longhand
  // inside a breakpoint block clobbers it (equal specificity ⇒ source order wins), silently
  // dropping margin-bottom on tablet/mobile. The model-walk collection order differs from
  // the SSR canvas's render order, so the same project rendered correctly in select mode but
  // lost the longhand in Astro play. Sorting the input makes the @media cascade correct
  // regardless of the runtime core's internal ordering (a no-op when it already sorts).
  const sorted = new Set(sortClassesByPropertyOrder(classes));
  const utility = sorted.size ? generateUtilityCSS(sorted, breakpoints, responsiveScales) : '';
  return [utility, inter.css].filter(Boolean).join('\n');
}
