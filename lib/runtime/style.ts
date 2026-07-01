/**
 * meno-astro — `style()` runtime resolver (class-name only).
 *
 * Emitted `.astro` markup styles every node with `class={style(styleObject[, props][, meta])}`
 * (see `dialect/emit/emitNode.ts`). The `styleObject` is a Meno
 * `StyleObject` / `ResponsiveStyleObject` — `{ base, tablet, mobile }` where any value
 * may be a prop-binding `{ _mapping: true, prop, values }`. The optional `meta` carries
 * `interactive` (hover/etc. state rules), `label`, and `genClass`.
 *
 * `style()` ONLY computes and returns the element's class name(s) — the `class={...}`
 * value. It does NOT generate or collect CSS at render time. The actual utility +
 * interactive CSS is produced at BUILD time by the `meno()` integration, which scans
 * every `.astro` source and emits one global stylesheet served as the virtual module
 * `virtual:meno-utilities.css` (imported by BaseLayout's <head>); see
 * `integration/utilityCss.ts`. A render-time collector would always be empty anyway —
 * Astro renders <head> (where the sheet is linked) before the <body> nodes that call
 * `style()`. That is exactly why the names produced here must be byte-identical to
 * meno-core's: the build-time scan generates the matching `.<class>` /
 * `.<class>:hover` rules.
 *
 * ── Why a props argument ───────────────────────────────────────────────────────
 * A `_mapping` value resolves against the *host component's prop values*, so the emitted
 * `style(styleObject, props, meta)` call threads a `props` scope and resolves each
 * `_mapping` to a concrete value *before* computing the class name. Unresolvable
 * mappings degrade gracefully (the bound property is dropped — never throws).
 *
 * ── Reuse, not reinvention ─────────────────────────────────────────────────────
 * Class-name computation is meno-core's, the same code the JSON runtime uses:
 *   - `responsiveStylesToClasses` — the forward mapper that turns a resolved style into
 *     utility class names (byte-identical to meno-core's ComponentBuilder).
 *   - `shortHash` — meno-core's deterministic FNV-1a hash, so an interactive style maps to
 *     a stable, element-scoped class the build-time scan can match.
 *   - `isStyleMapping` — the `_mapping` type guard; mapping *resolution* mirrors
 *     meno-core's `resolveExtractedMappings` (`mapping.values[String(propValue)]`).
 */

// The reverse mapper (class → { prop, value }) — used to key classes by CSS property for
// the instance-over-root merge (see mergeInstanceClasses).
import { classToStyle } from 'meno-core/shared';
import { isStyleMapping } from 'meno-core/shared';
import { shortHash } from 'meno-core/shared';
// The SAME forward mapper meno-core's JSON runtime (ComponentBuilder) uses — so the
// emitted class names are byte-identical to Meno core. The utility CSS itself is
// generated at BUILD time by the meno() integration (Astro renders <head> before
// <body>, so a runtime collector would always be empty); style() only returns names.
import { responsiveStylesToClasses } from 'meno-core/shared';
import { sanitizeCssValue, templateVarName } from './cssValue';
import type {
  StyleObject,
  StyleValue,
  ResponsiveStyleObject,
  InteractiveStyles,
  InteractiveStyleRule,
} from 'meno-core/shared';

// ---------------------------------------------------------------------------
// `meta` — the second/third argument shape emitted alongside the style object.
// Mirrors `emitClassAttr` in dialect/emit/emitNode.ts.
// ---------------------------------------------------------------------------

/** The `meta` payload carried by `class={style(styleObject, meta)}`. */
export interface StyleMeta {
  /** Hover/focus/state rules (`.element:hover { … }`, etc.). */
  interactive?: InteractiveStyles;
  /** The node's editor label — folded into the (still content-derived) class name. */
  label?: string;
  /** The node's `generateElementClass` flag (carried for parity; not load-bearing here). */
  genClass?: boolean;
  /**
   * Emitted on the COMPONENT STRUCTURE ROOT's class attr: merge the instance class the
   * parent passed (`props.class` — a `class={style(…, { instance: true })}` computed in
   * the parent's scope) over this element's own classes. meno-core merges instance
   * styles over the component root's styles before class generation; this is the
   * class-level equivalent (see mergeInstanceClasses).
   */
  root?: boolean;
}

/**
 * Per-node-type UA reset styles — meno-core's `.olink` base class, expressed as the style object
 * whose utility classes (`block`, `no-underline`, `text-inherit`) the collector already produces.
 * Single source of truth for {@link linkClass} (the render-time application) AND the build-time
 * stylesheet scan (utilityCss.ts imports this), so both stay in sync.
 */
export const NODE_RESET_STYLES: Record<string, StyleObject> = {
  link: { display: 'block', textDecoration: 'none', color: 'inherit' },
};

/**
 * Apply the `link` UA reset to a link's class string — the meno-astro equivalent of meno-core
 * seeding every link node with the `.olink` class. Called by the `Link.astro` runtime component
 * (NOT the emitter), so the reset is intrinsic to *every* `<Link>` at render — no per-node marker
 * in the source, no re-conversion of existing projects.
 *
 * The reset is the WEAK side: each reset utility is kept only if the link's own classes don't
 * already set that CSS property (conflict-aware, via {@link mergeInstanceClasses} + meno-core's
 * `classToStyle` reverse mapper). So a `display:flex` link drops `block` but keeps
 * `no-underline`/`text-inherit`; an authored `text-decoration:underline` drops `no-underline`;
 * a style-less link gets all three. One class per property — no stylesheet-order cascade fight.
 */
export function linkClass(incoming?: string | null): string {
  const reset = responsiveStylesToClasses(NODE_RESET_STYLES.link);
  return mergeInstanceClasses(reset, incoming ?? '').join(' ');
}

// ---------------------------------------------------------------------------
// `_mapping` (prop-binding) resolution.
// ---------------------------------------------------------------------------

/**
 * Resolve a single `_mapping` value against `props`, returning the concrete CSS value
 * or `undefined` when it cannot be resolved (no props, prop unset, or value not in the
 * mapping's table). Semantics mirror meno-core's `resolveExtractedMappings`:
 * `mapping.values[String(props[mapping.prop])]`.
 */
function resolveMappingValue(
  mapping: { prop: string; values: Record<string, string | number> },
  props: Record<string, unknown> | undefined,
): string | number | undefined {
  if (!props) return undefined;
  const propValue = props[mapping.prop];
  if (propValue === undefined || propValue === null) return undefined;
  const resolved = mapping.values[String(propValue)];
  return resolved === undefined ? undefined : resolved;
}

/**
 * Return a copy of a flat StyleObject with every `_mapping` value replaced by its
 * prop-resolved concrete value. Unresolvable mappings are dropped (graceful
 * degradation — a missing prop must never throw, and an unresolved property simply
 * isn't emitted, falling back to the cascade/UA default). Plain values pass through.
 */
function resolveMappingsInFlat(
  style: StyleObject,
  props: Record<string, unknown> | undefined,
  breakpoint?: string,
  bridgeBase = false,
): StyleObject {
  const out: StyleObject = {};
  for (const [prop, value] of Object.entries(style)) {
    if (isStyleMapping(value)) {
      const resolved = resolveMappingValue(value, props);
      if (resolved !== undefined) setSanitized(out, prop, resolved);
      // else: drop — unresolved mapping, no rule emitted.
      continue;
    }
    // A `{{template}}` value (e.g. `gap: "{{gap}}px"`) is per-instance and can't be a static
    // utility class. It's bridged through a CSS variable: emit the utility class
    // `<prop>: var(--m-<bp>-<prop>)` and have the element set that variable inline to its resolved
    // value (emitInlineStyleAttr / templateVarName). The bridge — rather than a plain inline
    // `<prop>: <value>` — is what lets a `:hover`/`.is-open` interactive class STILL override the
    // declaration: the inline sets the variable, not the property, so the property is only ever
    // assigned by class rules and normal specificity decides. tablet/mobile MUST bridge (an inline
    // style can't carry a media query). `base` bridges too EXCEPT on a component ROOT
    // (`bridgeBase` false), which keeps the direct inline form so the instance-over-root
    // suppression (inlineStyle) stays in charge of that element. Interactive callers don't bridge.
    if (typeof value === 'string' && value.includes('{{')) {
      const isBase = !breakpoint || breakpoint === 'base';
      if (!isBase) setSanitized(out, prop, `var(${templateVarName(breakpoint, prop)})`);
      else if (bridgeBase) setSanitized(out, prop, `var(${templateVarName('base', prop)})`);
      // else: root base (or interactive) → drop; the inline direct style handles it.
      continue;
    }
    setSanitized(out, prop, value);
  }
  return out;
}

/**
 * Land a resolved declaration value, sanitizing strings (see {@link sanitizeCssValue}).
 * Keeps the class hash identical to the build-time sheet's: `normalizeModel` sanitizes
 * the values the sheet builder sees, so a stale `.astro` whose literal still carries
 * junk must hash the SAME cleaned value here or its rule would never match. A value
 * with nothing valid left is dropped (no class, no rule — like an unresolved mapping).
 */
function setSanitized(out: StyleObject, prop: string, value: string | number): void {
  if (typeof value !== 'string') {
    out[prop] = value;
    return;
  }
  const clean = sanitizeCssValue(value);
  if (clean !== '') out[prop] = clean;
  else if (value === '') out[prop] = value; // preserve an authored empty string as-is
}

/** True when a StyleValue is the responsive `{ base/tablet/mobile }` shape. */
function isResponsive(style: StyleValue): style is ResponsiveStyleObject {
  return typeof style === 'object' && style !== null && ('base' in style || 'tablet' in style || 'mobile' in style);
}

/**
 * Resolve `_mapping` values across a whole StyleValue (flat or responsive), per
 * breakpoint, against `props`. The result is a plain StyleValue with no `_mapping`
 * objects remaining — ready for meno-core's CSS generator.
 *
 * `bridgeVars` turns a `{{template}}` declaration into a `var(--m-<bp>-<prop>)` utility class
 * (see resolveMappingsInFlat) instead of dropping it — set only when resolving an element's
 * BASE style (the element sets the variable inline). `isRoot` carves out the one exception:
 * on a component structure root, `base`-breakpoint templates keep the direct inline form
 * (`bridgeBase` off) so the instance-over-root suppression (inlineStyle) governs them; tablet/
 * mobile still bridge even on a root. Interactive-rule resolution leaves `bridgeVars` off:
 * those rules carry concrete values, and a bridged var there would have nothing setting it.
 */
export function resolveMappingsInStyle(
  style: StyleValue,
  props: Record<string, unknown> | undefined,
  bridgeVars = false,
  isRoot = false,
): StyleValue {
  const bridgeBase = bridgeVars && !isRoot;
  if (isResponsive(style)) {
    const out: ResponsiveStyleObject = {};
    for (const [bp, bpStyle] of Object.entries(style)) {
      if (!bpStyle) continue;
      out[bp] = resolveMappingsInFlat(bpStyle, props, bridgeVars ? bp : undefined, bridgeBase);
    }
    return out;
  }
  return resolveMappingsInFlat(style as StyleObject, props, bridgeVars ? 'base' : undefined, bridgeBase);
}

// ---------------------------------------------------------------------------
// Deterministic class name.
// ---------------------------------------------------------------------------

/** Lowercase + CSS-safe a label fragment for use in a class name. */
function sanitizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

/**
 * Compute a deterministic class name from the *resolved* style payload (base style +
 * interactive rules) plus the optional label. Identical inputs ⇒ identical class, so
 * two `style()` calls with the same styleObject dedupe to one CSS rule. The hash uses
 * meno-core's `shortHash` (FNV-1a). A label prefix is added for human-readable selectors
 * but the hash still keys dedup, so distinct styles never collide on label alone.
 */
export function computeClassName(
  resolvedBase: StyleValue,
  resolvedInteractive: InteractiveStyles,
  label: string | undefined,
): string {
  const fingerprint = JSON.stringify({ b: resolvedBase, i: resolvedInteractive });
  const hash = shortHash(fingerprint);
  const prefix = label ? sanitizeLabel(label) : '';
  return prefix ? `m_${prefix}_${hash}` : `m_${hash}`;
}

// ---------------------------------------------------------------------------
// Instance-over-root class merge (component structure roots).
// ---------------------------------------------------------------------------

/**
 * Merge key for one utility class: breakpoint prefix + the CSS property the class
 * decodes to (meno-core's `classToStyle` reverse mapper). `null` when the class isn't a
 * recognized utility (interactive `m_…` hash classes, dynamic-registry classes) — those
 * never participate in conflict detection and are always kept.
 */
function classMergeKey(cls: string): string | null {
  // Breakpoint variant prefix (`max-tablet:p-[10px]`) — the segment before the
  // first colon, when it's a bare identifier (arbitrary-property classes like
  // `[grid-area:hero]` and var hints like `text-(length:--x)` never match).
  const variantMatch = cls.match(/^([a-z][a-z0-9_-]*):/);
  // Normalize so every breakpoint form shares a merge key — an instance's `max-lg:p-4` must override a
  // root's `max-tablet:p-4` or legacy `tablet:p-4`. Strip the desktop-first marker, then fold the
  // Tailwind-scale class alias back to the identity (lg→tablet, sm→mobile). Mirrors meno-core's
  // normalizeBreakpointVariant, inlined to keep the published runtime off a new meno-core export.
  let bp = (variantMatch ? variantMatch[1]! : '').replace(/^max-/, '');
  if (bp === 'lg') bp = 'tablet';
  else if (bp === 'sm') bp = 'mobile';
  const entry = classToStyle(cls);
  return entry ? `${bp}|${entry.prop}` : null;
}

/**
 * Merge the instance class string (computed by the PARENT's `style(…, { instance: true })`
 * call and passed via the component's `class` prop) over the root element's own classes.
 * Instance wins per (breakpoint, CSS property) — the class-level equivalent of meno-core's
 * instance-over-root style-object merge (which is why its `<img>` renders `h-auto` and no
 * `h-100p` when an instance overrides the component's `height`). Without property-aware
 * dropping, both classes would apply and stylesheet order — not the instance — would
 * decide the winner.
 */
export function mergeInstanceClasses(own: string[], instanceClass: string): string[] {
  const instance = instanceClass.split(/\s+/).filter(Boolean);
  if (instance.length === 0) return own;
  const overridden = new Set(instance.map(classMergeKey).filter((k): k is string => k !== null));
  const kept = own.filter((cls) => {
    const key = classMergeKey(cls);
    return key === null || !overridden.has(key);
  });
  return [...kept, ...instance];
}

// ---------------------------------------------------------------------------
// style() — the emitter-facing resolver.
// ---------------------------------------------------------------------------

/**
 * Resolve a Meno style payload to its CSS class name(s). Pure — returns only the
 * `class={...}` value; the matching CSS is generated at build time (see the header).
 *
 * @param styleObject  The node's style — flat `StyleObject` or responsive
 *                     `{ base, tablet, mobile }`. Values may be `_mapping` prop bindings.
 * @param props        The host component's resolved prop values, used to resolve
 *                     `_mapping` bindings (the option-A contract). Optional: a style
 *                     with a `_mapping` but no `props` degrades gracefully (the bound
 *                     property is omitted rather than throwing).
 * @param meta         Optional `{ interactive, label, genClass }` — interactive state
 *                     rules and label, as emitted.
 * @returns The element's CSS class name (the `class={style(...)}` value).
 */
export function style(
  styleObject: StyleValue | null | undefined,
  props?: Record<string, unknown>,
  meta?: StyleMeta,
): string {
  const base = styleObject ?? {};

  // 1. Resolve prop-bound `_mapping` values to concrete CSS values using the host
  //    component's props (the same resolution meno-core does at render). `bridgeVars`:
  //    a `{{template}}` declaration becomes a `var(--m-<bp>-<prop>)` class (the element sets the
  //    variable inline) instead of vanishing — see resolveMappingsInFlat. `meta.root` keeps the
  //    root's BASE templates on the direct-inline path (instance-over-root), bridging only its
  //    tablet/mobile; a non-root bridges every breakpoint so interactive rules can override.
  const resolvedBase = resolveMappingsInStyle(base, props, true, meta?.root === true);

  // 2. Base styles → meno-core utility classes (byte-identical to the JSON runtime).
  const classes = responsiveStylesToClasses(resolvedBase);

  // 3. Interactive (`:hover`, …) styles aren't expressible as utility classes (they're
  //    states), so meno-core scopes them to an element-specific class. Resolve their
  //    `_mapping`s the same way and emit a DETERMINISTIC class so the build-time CSS
  //    scan generates the matching `.<class>:hover { … }` rule. No interactive ⇒ no
  //    extra class.
  const resolvedInteractive: InteractiveStyles = (meta?.interactive ?? []).map(
    (rule): InteractiveStyleRule => ({
      ...rule,
      style: resolveMappingsInStyle(rule.style, props),
    }),
  );
  if (resolvedInteractive.length > 0) {
    classes.push(computeClassName({}, resolvedInteractive, meta?.label));
  }

  // 4. Component structure root (`meta.root`): merge the instance class the parent
  //    passed (`props.class`) over this element's own classes — instance wins per
  //    (breakpoint, property), mirroring meno-core's instance-over-root style merge.
  if (meta?.root) {
    const instanceClass = typeof props?.class === 'string' ? props.class : '';
    if (instanceClass.trim()) return mergeInstanceClasses(classes, instanceClass).join(' ');
  }

  return classes.join(' ');
}

// ---------------------------------------------------------------------------
// inlineStyle() — a component ROOT's prop-bound inline styles, instance-aware.
// ---------------------------------------------------------------------------

/** camelCase → kebab-case CSS property (idempotent for already-kebab keys). */
function cssKebab(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/**
 * The (kebab) CSS properties a component instance OVERRIDES via its style object
 * (`props.__menoStyle`, passed by the parent's `<Child __menoStyle={…} />`). A property is an
 * override when the instance sets a concrete value for it — a static value or a prop-`_mapping`
 * (both of which the parent's `style(…, { instance: true })` already turned into the utility
 * class the root merged in). A `{{template}}` instance value is NOT an override: it produces no
 * utility class (per-instance, skipped), so dropping the root's own inline declaration for it
 * would leave the property unset. Read at the inline/class boundary so the instance's utility
 * class wins over the root's prop-bound inline style (mirrors meno-core's instance-over-root
 * merge — styleProcessor.mergeComponentStyles — which never split the two tiers).
 */
function instanceOverriddenCssProps(props?: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  // (a) Instance override carried as a style OBJECT (`__menoStyle`, the legacy/dynamic form).
  const styleObj = props?.__menoStyle as StyleValue | undefined;
  if (styleObj && typeof styleObj === 'object') {
    const flat = isResponsive(styleObj) ? styleObj.base : (styleObj as StyleObject);
    if (flat && typeof flat === 'object') {
      for (const [k, v] of Object.entries(flat)) {
        if (v === undefined || v === null || v === '') continue;
        if (typeof v === 'string' && v.includes('{{')) continue; // template → no class, don't suppress
        out.add(cssKebab(k));
      }
    }
  }
  // (b) Instance override carried as a class STRING (the class-based form — `<Child class="p-[24px]" />`).
  // Decode each base-level (unprefixed) utility token to the CSS property it overrides, so the root's
  // prop-bound inline style for that property is still dropped (instance class must win over inline).
  const cls = typeof props?.class === 'string' ? (props.class as string) : '';
  for (const token of cls.split(/\s+/)) {
    if (!token || /^[a-z][a-z0-9_-]*:/.test(token)) continue; // skip blanks + breakpoint variants
    const entry = classToStyle(token);
    if (entry) out.add(cssKebab(entry.prop));
  }
  return out;
}

/**
 * Build a component ROOT element's inline `style="…"` from its prop-bound (templated) style
 * declarations, dropping any whose CSS property the instance overrides. The emitter passes each
 * declaration's value already resolved against the host props (a build-time JS template literal,
 * e.g. `` `${maxWidth}` `` — so arbitrary `{{expr}}` bindings keep working) plus the host's
 * resolved props, so the instance overrides (`props.__menoStyle`) can be read.
 *
 * Why this exists: a value bound to a prop (`maxWidth: "{{maxWidth}}"`) can't be a build-time
 * utility class, so it renders as an inline `style="…"`. An inline style outranks the utility
 * class an instance override (`class={style(…, { instance: true })}`) lands on the SAME element
 * — so without dropping the overridden property here, the instance value is silently lost.
 * meno-core never split the two tiers: it merged the instance style over the resolved root style
 * OBJECT first, then generated classes (styleProcessor.mergeComponentStyles). Returns `undefined`
 * when nothing remains, so Astro omits the attribute.
 */
export function inlineStyle(decls: Record<string, string>, props?: Record<string, unknown>): string | undefined {
  const overridden = instanceOverriddenCssProps(props);
  const out: string[] = [];
  for (const [cssProp, value] of Object.entries(decls)) {
    if (value === '' || value == null) continue;
    if (overridden.has(cssProp)) continue;
    out.push(`${cssProp}: ${value}`);
  }
  return out.length ? out.join('; ') : undefined;
}

// ---------------------------------------------------------------------------
// cx() / variants() — class-based prop-driven styling (class form of `_mapping`).
// ---------------------------------------------------------------------------

/**
 * Concatenate utility-class fragments into one class string, dropping empty parts and, when two
 * fragments target the same (breakpoint, CSS property), keeping the LAST (later args win — callers
 * order base-then-override). Conflict-aware via the same `classMergeKey` used for instance merging,
 * so a variant class cleanly overrides a base one without relying on stylesheet order (spec §8).
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  const tokens: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    for (const t of String(part).split(/\s+/)) if (t) tokens.push(t);
  }
  if (tokens.length < 2) return tokens.join(' ');
  const lastForKey = new Map<string, number>();
  tokens.forEach((t, i) => {
    const k = classMergeKey(t);
    if (k) lastForKey.set(k, i);
  });
  return tokens
    .filter((t, i) => {
      const k = classMergeKey(t);
      return k === null || lastForKey.get(k) === i;
    })
    .join(' ');
}

/**
 * Resolve a prop-driven variant table to the active utility class(es). `table` maps a PROP name to
 * a `{ propValue: "utility classes" }` lookup — the class form of a `_mapping` (the values are
 * utility classes, not CSS). For each prop the class for the current `props[prop]` value is picked
 * (string-coerced). The class analogue of meno-core's `resolveStyleMapping`; a missing/unmatched
 * value contributes nothing.
 */
export function variants(
  props: Record<string, unknown> | undefined,
  table: Record<string, Record<string, string>>,
): string {
  const out: string[] = [];
  for (const [prop, lookup] of Object.entries(table)) {
    const value = props?.[prop];
    if (value === undefined || value === null) continue;
    const cls = lookup[String(value)];
    if (cls) out.push(cls);
  }
  return out.join(' ');
}
