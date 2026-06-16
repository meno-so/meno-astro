/**
 * meno-astro — `href()` / `embedHtml()` runtime resolvers.
 *
 * Emitted markup binds a Link's `href` and an Embed's `html` through these helpers when
 * the model value is a prop-`_mapping` (`{ _mapping: true, prop, values? }`) rather than a
 * literal string/template:
 *
 *   <Link  href={href(mapping, __props)} />
 *   <Embed html={embedHtml(mapping, __props)} />
 *
 * `__props` is the host component's resolved props (threaded by the emitter, exactly like
 * `style()`); pages have no props scope, so the emitter calls the 1-arg form and the
 * mapping degrades to a safe default.
 *
 * ── Parity with meno-core ──────────────────────────────────────────────────────
 * These mirror meno-core's canonical `resolveLinkMapping` / `resolveHtmlMapping`
 * (`client/templateEngine.ts`), re-implemented locally so this Node/SSR package keeps its
 * narrow `meno-core/shared`-only import graph — the `meno-core/client` barrel re-exports
 * the whole React renderer (and browser globals), which must not enter an Astro build.
 * `style.ts` mirrors core's style-mapping resolver for the same reason.
 *
 * Both mapping modes are supported, matching core:
 *   - value mapping: `mapping.values[String(props[prop])]`
 *   - passthrough  : `props[prop]` used directly (an object link `{ href, target? }` or a
 *                    bare string URL / HTML string) when `values` is omitted/empty.
 * The resolved link is flattened to its URL the same way the JSON→Astro exporter does
 * (`(typeof v === 'string' ? v : v?.href) ?? '#'`) — the dialect `Link.astro` takes a
 * string `href`. Anything that can't resolve (no props, prop unset, missing key) degrades
 * to a safe default — `"#"` for href, `""` for html — and never throws.
 */

/** A prop-binding `_mapping` of either link or html flavour. */
interface RefMapping {
  _mapping: true;
  prop: string;
  values?: Record<string, unknown>;
}

function isMapping(value: unknown): value is RefMapping {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { _mapping?: unknown })._mapping === true &&
    typeof (value as { prop?: unknown }).prop === 'string'
  );
}

/** Flatten a resolved link value (object `{ href }` or bare string) to its URL, else `"#"`. */
function toHrefString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'href' in value) {
    const h = (value as { href?: unknown }).href;
    return typeof h === 'string' ? h : '#';
  }
  return '#';
}

/**
 * Resolve a Link node's `href` to a URL string.
 *
 * @param value  A `LinkMapping` (`{ _mapping, prop, values? }`) for a prop-bound link, or
 *               an already-literal value (passed straight through).
 * @param props  The host component's resolved props (`__props`); absent for pages.
 * @returns The URL the dialect `Link.astro` renders; `"#"` when unresolvable.
 */
export function href(value: unknown, props?: Record<string, unknown>): string {
  if (!isMapping(value)) return toHrefString(value);
  const propValue = props?.[value.prop];
  if (propValue === undefined || propValue === null) return '#';
  // Passthrough: the prop value is already a link object — use it directly (mirrors
  // resolveLinkMapping, which prefers passthrough even when a `values` table exists).
  if (typeof propValue === 'object' && propValue !== null && 'href' in propValue) {
    return toHrefString(propValue);
  }
  // Value-mapping mode: look the prop value up in the mapping table.
  if (value.values) return toHrefString(value.values[String(propValue)]);
  // Passthrough of a coerced string URL.
  return toHrefString(propValue);
}

/**
 * Resolve an Embed node's `html` to an HTML string.
 *
 * @param value  An `HtmlMapping` (`{ _mapping, prop, values? }`) for a prop-bound embed, or
 *               an already-literal string (passed straight through).
 * @param props  The host component's resolved props (`__props`); absent for pages.
 * @returns The HTML string to inject; `""` when unresolvable.
 */
export function embedHtml(value: unknown, props?: Record<string, unknown>): string {
  if (!isMapping(value)) return typeof value === 'string' ? value : '';
  const propValue = props?.[value.prop];
  if (propValue === undefined || propValue === null) return '';
  // Value-mapping mode (non-empty table); else passthrough of a string prop.
  if (value.values && Object.keys(value.values).length > 0) {
    const mapped = value.values[String(propValue)];
    return typeof mapped === 'string' ? mapped : '';
  }
  return typeof propValue === 'string' ? propValue : '';
}

/**
 * Resolve a node's `if` condition when it is a `BooleanMapping`
 * (`{ _mapping, prop, values }`) — the emitter wraps that form in `when(...)`. Mirrors
 * meno-core's `resolveConditionalValue` (nodeUtils.ts): look the host prop's value up in
 * the mapping's table and coerce to a boolean.
 *
 * Defaults to `true` (render) when the mapping can't be resolved — no props, or the prop
 * value isn't in the table — matching meno-core, so a misconfigured condition shows the
 * node rather than silently hiding it. A non-mapping argument is coerced directly.
 *
 * @param value  A `BooleanMapping`, or an already-evaluated condition value.
 * @param props  The host component's resolved props (`__props`); absent for pages.
 */
export function when(value: unknown, props?: Record<string, unknown>): boolean {
  if (!isMapping(value)) return Boolean(value);
  if (!props) return true;
  const propValue = props[value.prop];
  const mapped = value.values?.[String(propValue)];
  return mapped !== undefined ? Boolean(mapped) : true;
}
