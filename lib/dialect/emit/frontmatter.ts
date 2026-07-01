/**
 * Frontmatter helpers shared by the page + component assemblers: deterministic
 * import lines and the `resolveProps(Astro, {…})` prop block.
 */

import type { EmitContext } from './emitContext';
import { componentIdentFor, islandIdentFor, customAstroIdentFor } from './emitNode';
import { isBindableIdent } from '../ident';
import { serializeLiteral } from './serialize';

export interface ImportOptions {
  /** Type-only symbols from `meno-astro` (e.g. MenoComponentMeta, MenoPageMeta). */
  typeImports?: string[];
  /** Relative path prefix for local component imports (e.g. './' or '../components/'). */
  componentPrefix: string;
  /**
   * Optional override producing the full relative import path for a referenced
   * component by name (used when components live in category subfolders so imports
   * resolve to `…/section/Error404.astro` instead of a flat `…/Error404.astro`).
   * When absent, falls back to `${componentPrefix}${name}.astro`.
   */
  componentImportPath?: (name: string) => string;
  /**
   * Produces the full relative import path for an island `src` (a framework file under
   * `src/islands/`). The page/component assembler sets the correct `../` depth so the
   * import resolves to `src/islands/<src>`. When absent, falls back to `../islands/<src>`
   * (the top-level-page / flat default the round-trip codec uses).
   */
  islandImportPath?: (src: string) => string;
  /**
   * Produces the full relative import path for a custom-`.astro` `src` (a hand-authored
   * opaque component under `src/custom/`). The page/component assembler sets the correct
   * `../` depth so the import resolves to `src/custom/<src>`. When absent, falls back to
   * `../custom/<src>` (the top-level-page / flat default the round-trip codec uses).
   */
  customAstroImportPath?: (src: string) => string;
}

/** Build deterministic, alphabetized import lines from the emit context. */
export function buildImportLines(ctx: EmitContext, opts: ImportOptions): string[] {
  const lines: string[] = [];
  const types = [...new Set(opts.typeImports ?? [])].sort();
  if (types.length) lines.push(`import type { ${types.join(', ')} } from 'meno-astro';`);
  if (ctx.runtime.size) {
    // A helper whose name collides with a destructured prop is imported under an alias
    // (`list as list$`) so the prop local doesn't shadow it; everything else imports plainly.
    const specifiers = [...ctx.runtime].sort().map((name) => {
      const alias = ctx.runtimeAliases?.get(name);
      return alias ? `${name} as ${alias}` : name;
    });
    lines.push(`import { ${specifiers.join(', ')} } from 'meno-astro';`);
  }
  if (ctx.runtimeComponents.size) {
    lines.push(`import { ${[...ctx.runtimeComponents].sort().join(', ')} } from 'meno-astro/components';`);
  }
  for (const name of [...ctx.components].sort()) {
    const path = opts.componentImportPath ? opts.componentImportPath(name) : `${opts.componentPrefix}${name}.astro`;
    lines.push(`import ${componentIdentFor(ctx, name)} from '${path}';`);
  }
  // Island imports (BYO framework components under `src/islands/`). The `src` already
  // carries the file extension (so the framework is recoverable on parse).
  for (const src of [...ctx.islands].sort()) {
    const path = opts.islandImportPath ? opts.islandImportPath(src) : `../islands/${src}`;
    lines.push(`import ${islandIdentFor(ctx, src)} from '${path}';`);
  }
  // Custom-`.astro` imports (opaque hand-authored components under `src/custom/`). The `src`
  // already carries the `.astro` extension; the `custom/` segment is the parse discriminator
  // (a `.astro` import NOT under `components/`) that keeps it distinct from a Meno component.
  for (const src of [...ctx.customAstro].sort()) {
    const path = opts.customAstroImportPath ? opts.customAstroImportPath(src) : `../custom/${src}`;
    lines.push(`import ${customAstroIdentFor(ctx, src)} from '${path}';`);
  }
  return lines;
}

/**
 * `isEditorMode` — meno-core's global template variable (true only inside the Studio
 * editor; default false). The emitted `.astro` is the production/preview artifact, so it
 * always resolves to false. Pages/components define it as a frontmatter const when their
 * body references it (a bare identifier would otherwise throw at SSR). Emit-only:
 * parseFrontmatter doesn't recognize it, and it's re-derived from the body on every emit.
 */
export const IS_EDITOR_MODE_CONST = 'const isEditorMode = false;';

/** True when an emitted body references the `isEditorMode` identifier (word-anchored). */
export function referencesIsEditorMode(body: string): boolean {
  return /\bisEditorMode\b/.test(body);
}

// ---------------------------------------------------------------------------
// resolveProps(Astro, {…}) — the single authoritative prop block.
//
// The `{…}` literal is the authoritative prop definition (`serializeLiteral` of
// `def.interface`); the parser reads it back. The destructured names are emit-only
// (the prop names, minus `children`, plus `class: className`); the parser ignores
// them. TS types of the locals are inferred from the literal by `resolveProps`.
// ---------------------------------------------------------------------------

const WIDTH = 80;
const CALL_PREFIX = 'resolveProps(Astro, ';

type PropDef = Record<string, any>;

/**
 * Build the `const { …names…, class: className } = resolveProps(Astro, {…});`
 * block. Always binds `class: className` so instances can carry wrapper styles, and
 * always emits the call (even for an empty interface: `resolveProps(Astro, {})`).
 */
export function buildPropsBlock(propInterface: Record<string, PropDef> | undefined): string[] {
  const def = propInterface ?? {};
  const names: string[] = [];
  for (const name of Object.keys(def)) {
    if (name === 'children') continue;
    // Only bindable identifiers get a destructured local (a prop like "Mobile-0" would
    // be a syntax error: `const { Mobile-0 } = …`). The prop stays in the interface
    // literal and reaches style()/href() mappings through `__props` — the locals only
    // feed bare `{x}` template references, which can't name such props anyway.
    if (!isBindableIdent(name)) continue;
    names.push(name);
  }
  names.push('class: className');

  // Two statements:
  //   const __props = resolveProps(Astro, {…});   ← the authoritative prop definition
  //   const { x, y, class: className } = __props;  ← the destructured locals
  // `__props` (the resolved object) is what style()/href()/embedHtml() receive so that
  // prop-`_mapping`s resolve; the destructure feeds the template's `{x}` references.
  const head = `const __props = ${CALL_PREFIX}`;
  // Serialize the prop literal at its true start column; reserve 2 cols for `);`.
  const literal = serializeLiteral(def, { indent: 0, startCol: head.length + 2, width: WIDTH });
  const assign = `${head}${literal});`;

  const destrHead = `const { ${names.join(', ')} } = __props;`;
  const destructure =
    destrHead.length <= WIDTH ? destrHead : ['const {', ...names.map((n) => `  ${n},`), '} = __props;'].join('\n');

  return [assign, destructure];
}
