/**
 * buildAstroLineMap — line ranges keyed like meno-core's jsonLineMapper, but pointing
 * into the real `.astro` source. We emit canonical `.astro` from a model, map it, and
 * assert each path key's range frames the expected markup in the source.
 */
import { test, expect, describe } from 'bun:test';
import { emit, buildAstroLineMap, type LineRange } from './index';

/** The source line at 1-based `n`. */
function lineAt(src: string, n: number): string {
  return src.split('\n')[n - 1] ?? '';
}

/** All source lines in `[startLine, endLine]`, joined. */
function rangeText(src: string, r: LineRange): string {
  return src
    .split('\n')
    .slice(r.startLine - 1, r.endLine)
    .join('\n');
}

describe('buildAstroLineMap', () => {
  test('maps a page tree by child-index path keys to real .astro lines', () => {
    const page = {
      meta: { title: 'Home' },
      root: {
        type: 'node',
        tag: 'main',
        children: [
          {
            type: 'node',
            tag: 'section',
            children: [
              { type: 'component', component: 'Button', props: { label: 'Go' } },
              { type: 'node', tag: 'span', children: 'hi' },
            ],
          },
          { type: 'node', tag: 'footer', children: 'x' },
        ],
      },
    };
    const src = emit(page as any);
    const map = buildAstroLineMap(src);

    // Root, children and grandchildren resolve under the jsonLineMapper key scheme.
    expect(lineAt(src, map.get('')!.startLine)).toContain('<main');
    expect(lineAt(src, map.get('0')!.startLine)).toContain('<section');
    expect(lineAt(src, map.get('1')!.startLine)).toContain('<footer');
    expect(lineAt(src, map.get('0,0')!.startLine)).toContain('<Button');
    expect(lineAt(src, map.get('0,1')!.startLine)).toContain('<span');

    // The root range spans from <main> through </main>.
    expect(lineAt(src, map.get('')!.endLine)).toContain('</main>');
    const sectionText = rangeText(src, map.get('0')!);
    expect(sectionText).toContain('<section');
    expect(sectionText).toContain('</section>');
  });

  test('maps inside a prop list template (the .map body children)', () => {
    const page = {
      root: {
        type: 'node',
        tag: 'ul',
        children: [
          {
            type: 'list',
            sourceType: 'prop',
            source: '{{items}}',
            children: [{ type: 'node', tag: 'li', children: '{{item.name}}' }],
          },
        ],
      },
    };
    const src = emit(page as any);
    const map = buildAstroLineMap(src);

    // ul = root, the list node = ul.children[0] = "0", the <li> template = "0,0".
    expect(lineAt(src, map.get('')!.startLine)).toContain('<ul');
    expect(rangeText(src, map.get('0')!)).toContain('.map(');
    expect(lineAt(src, map.get('0,0')!.startLine)).toContain('<li');
  });

  test('maps a conditional (if) node to its wrapped element lines', () => {
    const page = {
      root: {
        type: 'node',
        tag: 'div',
        children: [{ type: 'node', tag: 'p', if: '{{show}}', children: 'hello' }],
      },
    };
    const src = emit(page as any);
    const map = buildAstroLineMap(src);

    expect(lineAt(src, map.get('')!.startLine)).toContain('<div');
    expect(rangeText(src, map.get('0')!)).toContain('<p');
  });

  test('maps a component file from its structure root', () => {
    const comp = {
      component: {
        structure: {
          type: 'node',
          tag: 'h1',
          children: [
            { type: 'node', tag: 'span' },
            { type: 'component', component: 'Icon' },
          ],
        },
      },
    };
    const src = emit(comp as any);
    const map = buildAstroLineMap(src);

    expect(lineAt(src, map.get('')!.startLine)).toContain('<h1');
    expect(lineAt(src, map.get('0')!.startLine)).toContain('<span');
    expect(lineAt(src, map.get('1')!.startLine)).toContain('<Icon');
  });

  test('round-trips: parsing the emitted source is unaffected by span collection', () => {
    // A malformed file degrades to an empty map rather than throwing.
    expect(buildAstroLineMap('not a valid <astro').size).toBe(0);
  });
});
