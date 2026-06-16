/**
 * Deterministic JS-literal serializer — the round-trip linchpin.
 *
 * Every non-structural payload in the meno-astro dialect (style objects, component
 * props, `export const meta`, the `resolveProps(Astro, {…})` argument, i18n values,
 * list config, mappings) is emitted as the literal argument of a known call or a named
 * const. This serializer
 * produces those literals so that:
 *   - the output is valid JS (embeds cleanly in `.astro` frontmatter + JSX expressions),
 *   - it is parseable back verbatim by a tiny total evaluator (Phase 2 parser),
 *   - it is deterministic + diff-stable (stable key order, canonical formatting).
 *
 * Formatting: small values render inline; values whose inline form would exceed
 * `width` columns expand to one entry per line (clean git diffs). Strings use JSON
 * double-quote escaping. Object keys are emitted unquoted when they are valid JS
 * identifiers, quoted otherwise.
 */

const DEFAULT_WIDTH = 80;
const INDENT_STEP = 2;

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Whether a key can be emitted unquoted as a JS object key. */
export function isIdentifier(key: string): boolean {
  return IDENT_RE.test(key);
}

function renderKey(key: string): string {
  return isIdentifier(key) ? key : JSON.stringify(key);
}

function renderString(value: string): string {
  // JSON string escaping is valid JS string escaping (and single-line).
  return JSON.stringify(value);
}

function renderNumber(value: number): string {
  return Number.isFinite(value) ? String(value) : 'null';
}

/** Object entries with `undefined` values dropped (JSON semantics; the model should not carry undefined). */
function definedEntries(obj: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(obj).filter(([, v]) => v !== undefined);
}

/** Always-inline rendering (never emits newlines). Used for fit-testing and for short values. */
function renderInline(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  switch (typeof value) {
    case 'string':
      return renderString(value);
    case 'number':
      return renderNumber(value);
    case 'boolean':
      return String(value);
    case 'object': {
      if (Array.isArray(value)) {
        if (value.length === 0) return '[]';
        return '[' + value.map(renderInline).join(', ') + ']';
      }
      const entries = definedEntries(value as Record<string, unknown>);
      if (entries.length === 0) return '{}';
      return '{ ' + entries.map(([k, v]) => `${renderKey(k)}: ${renderInline(v)}`).join(', ') + ' }';
    }
    default:
      // functions/symbols/bigint are not part of the model
      return 'null';
  }
}

export interface SerializeOptions {
  /** Column at which continuation lines of this value are indented. Default 0. */
  indent?: number;
  /** Max line width before an object/array expands to multi-line. Default 80. */
  width?: number;
  /**
   * Column where this value begins on the current line (drives the top-level
   * inline-fit test). Defaults to `indent`. Set this when the value is emitted to
   * the right of a prefix (e.g. `resolveProps(Astro, <here>)`) but its
   * continuation lines should still indent relative to `indent`.
   */
  startCol?: number;
}

/**
 * Serialize a model value to a deterministic JS literal string.
 * The returned string has no leading indentation; continuation lines are indented
 * relative to `opts.indent` (the column where the value starts).
 */
export function serializeLiteral(value: unknown, opts: SerializeOptions = {}): string {
  const width = opts.width ?? DEFAULT_WIDTH;
  const baseIndent = opts.indent ?? 0;
  const startCol = opts.startCol ?? baseIndent;

  /**
   * @param v          value to render
   * @param contIndent indentation (spaces) for continuation lines of this value
   * @param startCol   column where this value begins on the current line (for the inline-fit test)
   */
  const render = (v: unknown, contIndent: number, startCol: number): string => {
    // Primitives are always inline.
    if (v === null || typeof v !== 'object') return renderInline(v);

    const inline = renderInline(v);
    if (startCol + inline.length <= width) return inline;

    const pad = ' '.repeat(contIndent + INDENT_STEP);
    const closePad = ' '.repeat(contIndent);

    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      const items = v.map((item) => pad + render(item, contIndent + INDENT_STEP, contIndent + INDENT_STEP));
      return '[\n' + items.join(',\n') + '\n' + closePad + ']';
    }

    const entries = definedEntries(v as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const lines = entries.map(([k, val]) => {
      const prefix = pad + renderKey(k) + ': ';
      return prefix + render(val, contIndent + INDENT_STEP, prefix.length);
    });
    return '{\n' + lines.join(',\n') + '\n' + closePad + '}';
  };

  return render(value, baseIndent, startCol);
}
