/**
 * meno-astro/dialect — the editor/build-only codec between the Meno in-memory
 * model and the round-trippable `.astro` dialect.
 *
 * This module is NOT shipped to generated projects' runtime; it is used by the
 * Studio editor (read/save) and the build/convert tooling.
 *
 *   emit(model)  -> .astro source   (deterministic, git-stable)
 *   parse(source) -> { model, regions }
 *
 * Round-trip contract:
 *   - parse(emit(x)) === x          (exact: every payload read back verbatim)
 *   - emit(parse(y)) === y          (stable up to canonical formatting)
 *
 * Bodies are implemented in Phase 1 (emit) and Phase 2 (parse). This file pins
 * the public types/signatures so later phases and downstream callers compile
 * against a stable contract.
 */

import type { JSONPage, StructuredComponentDefinition } from 'meno-core/shared';
import { emitPage } from './emit/emitPage';
import { emitComponent } from './emit/emitComponent';
import { parseFile } from './parse/parseFile';
import type { NodeSpan } from './parse/parseContext';
import { normalizeModel } from './normalize';
import type { EmitOptions } from './emit/emitContext';

export type { EmitOptions };

export { normalizeModel };
export { buildAstroLineMap, type LineMap, type LineRange } from './lineMap';

/** The on-disk component file shape: `{ component: StructuredComponentDefinition }`. */
export interface ComponentFile {
  component: StructuredComponentDefinition;
}

/** A page or a component definition — the two top-level things a `.astro` file maps to. */
export type DialectModel = JSONPage | StructuredComponentDefinition | ComponentFile;

/**
 * A tracked span of the source file. The parser returns these so the emitter can
 * re-emit non-dialect / hand-written regions verbatim (escape hatch) and so editing
 * one section never reformats an untouched region.
 */
export interface MenoRegion {
  /** Stable id of the model node this region corresponds to, if any. */
  nodeId?: string;
  /**
   * - `editable`: in-dialect, fully round-tripped.
   * - `rawClass`: foreign `class="…"` captured as read-only passthrough.
   * - `verbatim`: arbitrary Astro/JS preserved byte-for-byte.
   */
  kind: 'editable' | 'rawClass' | 'verbatim';
  /** Byte offset start (inclusive) in the source. */
  start: number;
  /** Byte offset end (exclusive) in the source. */
  end: number;
}

export interface ParseResult {
  model: DialectModel;
  regions: MenoRegion[];
}

/** Serialize the Meno model to deterministic `.astro` dialect source. */
export function emit(model: DialectModel, opts?: EmitOptions): string {
  // Canonicalize first (migrate legacy types, drop empties) so emit accepts raw models
  // and always produces canonical .astro. Symmetric with parse() normalizing its output.
  const m = normalizeModel(model) as Record<string, any>;
  if (m && typeof m === 'object') {
    // On-disk component file: { component: { … } }
    if (m.component && typeof m.component === 'object') return emitComponent(m.component, opts);
    // Raw component definition (structure/interface/js/css at the top level).
    if (m.structure !== undefined || m.interface !== undefined || m.javascript !== undefined || m.css !== undefined) {
      return emitComponent(m as StructuredComponentDefinition, opts);
    }
  }
  // Otherwise it's a page (meta / root / components).
  return emitPage(m as JSONPage, opts);
}

/**
 * Walk the (pre-normalize) parsed model for verbatim-code markers and report each as a
 * `kind: 'verbatim'` region, using the byte spans `parseFile` recorded. Run BEFORE
 * `normalizeModel`, which copies node objects and would break the span map's identity keys.
 * Child/element-position markers carry spans; attribute-position markers may not (Phase 1).
 */
function collectVerbatimRegions(model: unknown, spans: Map<object, NodeSpan>): MenoRegion[] {
  const regions: MenoRegion[] = [];
  const seen = new Set<object>();
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);
    if ((node as Record<string, unknown>)._code === true) {
      const span = spans.get(node);
      if (span) regions.push({ kind: 'verbatim', start: span.start, end: span.end });
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    for (const value of Object.values(node as Record<string, unknown>)) walk(value);
  };
  walk(model);
  regions.sort((a, b) => a.start - b.start);
  return regions;
}

/** Parse `.astro` dialect source back into the Meno model (+ tracked regions). */
export function parse(source: string): ParseResult {
  const { model, spans } = parseFile(source, { collectSpans: true });
  const regions = spans ? collectVerbatimRegions(model, spans) : [];
  // Output is canonicalized so the editor always sees a normalized model.
  return { model: normalizeModel(model) as DialectModel, regions };
}
