/**
 * `.astro` line mapper — the dialect counterpart to meno-core's `buildLineMap` for JSON.
 *
 * The Studio editor and the `.meno/selection.json` writer locate a selected node by a
 * `filePath:lineStart-lineEnd` pointer. For JSON projects the line range comes from
 * `buildLineMap(jsonText)`. For `.astro` projects the on-disk file bears no relation to
 * the JSON-stringified model, so we recover ranges from the `.astro` source directly:
 * parse it once with source-span collection on, then walk the node tree assigning the
 * SAME path keys meno-core's mapper uses (`""` = root, `"0"`/`"1,2"` = child index
 * chains, following only `children` arrays). Keys therefore line up 1:1 with the editor's
 * selection paths, so a selection resolves to the right `.astro` lines.
 *
 * Built from the raw parsed model (pre-normalize), which for `.astro` input has the same
 * `children` shape the editor indexes into — the only divergence (a lone string child
 * collapsing array→string) adds harmless extra keys the editor never requests.
 */

import { parseFile } from './parse/parseFile';
import type { NodeSpan } from './parse/parseContext';

export interface LineRange {
  startLine: number;
  endLine: number;
}

export type LineMap = Map<string, LineRange>;

type Node = Record<string, unknown>;

/** Per-character line-number lookup (1-based), matching meno-core's jsonLineMapper. */
function buildCharToLine(source: string): number[] {
  const charToLine = new Array<number>(source.length);
  let line = 1;
  for (let i = 0; i < source.length; i++) {
    charToLine[i] = line;
    if (source[i] === '\n') line++;
  }
  return charToLine;
}

/** The tracked root node of a parsed model: a page's `root` or a component's `structure`. */
function rootNode(model: Record<string, unknown>): Node | undefined {
  const component = model.component as Record<string, unknown> | undefined;
  const candidate = component ? component.structure : model.root;
  return candidate && typeof candidate === 'object' ? (candidate as Node) : undefined;
}

/**
 * Build a `path-key → line range` map for an `.astro` source, keyed identically to
 * meno-core's `buildLineMap` so selection/copy line lookups work unchanged. Returns an
 * empty map for unparseable input (best-effort, never throws).
 */
export function buildAstroLineMap(source: string): LineMap {
  const lineMap: LineMap = new Map();
  try {
    const { model, spans } = parseFile(source, { collectSpans: true });
    if (!spans) return lineMap;
    const root = rootNode(model);
    if (!root) return lineMap;

    const charToLine = buildCharToLine(source);
    const toRange = (span: NodeSpan): LineRange => ({
      startLine: charToLine[span.start] ?? 1,
      endLine: charToLine[span.end - 1] ?? charToLine[span.start] ?? 1,
    });

    const walk = (node: Node, key: string): void => {
      const span = spans.get(node);
      if (span) lineMap.set(key, toRange(span));
      const children = node.children;
      if (Array.isArray(children)) {
        children.forEach((child, i) => {
          if (child && typeof child === 'object') {
            walk(child as Node, key === '' ? String(i) : `${key},${i}`);
          }
        });
      }
    };
    walk(root, '');
  } catch {
    // Best-effort: a malformed file yields an empty map rather than breaking the editor.
  }
  return lineMap;
}
