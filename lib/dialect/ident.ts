/**
 * Identifier rules for emitted JS bindings. A Meno prop name is an arbitrary string
 * (imports produce things like `Mobile-0`), but only valid, non-reserved identifiers
 * can be destructure-bound (`const { Mobile-0 } = __props` is a syntax error) or used
 * in `define:vars={{ … }}` shorthand. Non-bindable props stay reachable through the
 * `__props` object — which is what `style()`/`href()` `_mapping`s resolve against —
 * so skipping the local binding loses nothing the body could legally reference.
 */

const RESERVED = new Set([
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'new',
  'null',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  // strict-mode / contextual reserved — emitted modules are strict
  'await',
  'implements',
  'interface',
  'let',
  'package',
  'private',
  'protected',
  'public',
  'static',
  'yield',
]);

/** True when `name` can be a bare destructure binding / `define:vars` shorthand key. */
export function isBindableIdent(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name) && !RESERVED.has(name);
}
