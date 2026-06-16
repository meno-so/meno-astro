/**
 * `define:vars` `el` + `props` binding — emit/parse twins.
 *
 * meno-core ran a component's `<script>` as `(function(el, props){ … })(el, props)`, so
 * component JS is authored assuming BOTH **`el`** (the instance's own root element) and
 * **`props`** (the resolved props object) are in scope — e.g.
 * `el.querySelector('[counter="display"]')` and `props.columns`. Astro's native
 * `<script define:vars={{…}}>` injects only the individual prop *values* as consts, never
 * `el` and never a `props` object, so that code throws `ReferenceError: el is not defined`
 * / `props is not defined` in the browser.
 *
 * We bridge the gap by wrapping the user JS in an IIFE that binds `el` to the script's own
 * component root and `props` to an object built from the injected define:vars consts. Astro
 * renders a `define:vars` script as a plain **inline** (non-module) script that runs
 * synchronously at its position in the document, so `document.currentScript` is valid and the
 * component's rendered markup is the script's previous element sibling (Astro hoists the
 * component `<style>` to `<head>`, so we skip any STYLE/SCRIPT siblings defensively). The
 * individual prop consts stay available in the enclosing scope too (the IIFE closes over
 * them), so destructured-prop access keeps working.
 *
 * The wrapper is deterministic boilerplate (the only per-component variation is the prop-name
 * list passed to {@link wrapDefineVarsJs}), so {@link unwrapDefineVarsJs} strips it back off on
 * parse — the model's `javascript` round-trips as the clean user source. An IIFE *parameter*
 * (not a `const`) is used so user code that itself does `var el`/`var props` can't collide.
 */

/** Resolve the component root element from the executing inline `define:vars` script. */
const EL_BIND_EXPR =
  '(function(){var s=document.currentScript,e=s&&s.previousElementSibling;' +
  "while(e&&(e.nodeName==='STYLE'||e.nodeName==='SCRIPT'))e=e.previousElementSibling;" +
  'return e||null;})()';

const WRAP_OPEN = '(function(el, props){\n';
/** The fixed head of the wrapper close; the `, { …names })` props arg follows it. */
const CLOSE_HEAD = `\n})(${EL_BIND_EXPR}`;

// The previous wrapper bound only `el` — recognized on parse for back-compat with already
// emitted `.astro` (so older files still round-trip to clean JS).
const OLD_OPEN = '(function(el){\n';
const OLD_CLOSE = `\n})(${EL_BIND_EXPR});`;

/**
 * Wrap a `define:vars` component's JS so `el` (its root element) and `props` (an object of
 * the injected prop values, keyed by `names`) are in scope at runtime. `names` are the same
 * define:vars consts the `<script define:vars={{…}}>` directive injects.
 */
export function wrapDefineVarsJs(js: string, names: string[] = []): string {
  const propsArg = names.length ? `{ ${names.join(', ')} }` : '{}';
  return `${WRAP_OPEN}${js}${CLOSE_HEAD}, ${propsArg});`;
}

/** Inverse of {@link wrapDefineVarsJs}: recover the clean user JS (no-op if not wrapped). */
export function unwrapDefineVarsJs(js: string): string {
  if (js.startsWith(WRAP_OPEN) && js.endsWith(');')) {
    const idx = js.lastIndexOf(CLOSE_HEAD);
    if (idx !== -1) return js.slice(WRAP_OPEN.length, idx);
  }
  // Back-compat: previous el-only wrapper.
  if (js.startsWith(OLD_OPEN) && js.endsWith(OLD_CLOSE)) {
    return js.slice(OLD_OPEN.length, js.length - OLD_CLOSE.length);
  }
  return js;
}
