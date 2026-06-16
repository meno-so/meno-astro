/**
 * richTextWithComponents / expandRichTextComponents tests — rich-text `menoComponent`
 * markers render as REAL project components (the generic companion of the URL-embed
 * fast path). A stub renderer stands in for the Astro Container (created only inside a
 * real Astro build); the container path itself is covered by the e2e build loop.
 */
import { test, expect, describe } from 'bun:test';
import { expandRichTextComponents, richTextWithComponents, type ComponentRenderer } from './richTextComponents';
import type { TiptapDocument } from 'meno-core/shared/richtext';

/** A fake compiled component the registry would hold. */
const Button = { name: 'Button' };

/** Stub renderer: records calls, renders a recognizable tag. */
function stubRenderer(calls: { component: unknown; props: Record<string, unknown> }[]): ComponentRenderer {
  return async (component, props) => {
    calls.push({ component, props });
    return `<a class="rendered-button">${String(props.text ?? '')}</a>`;
  };
}

const marker =
  '<div data-meno-component="Button" data-meno-props="{&quot;text&quot;:&quot;Go&quot;,&quot;href&quot;:&quot;/x&quot;}"></div>';

describe('expandRichTextComponents', () => {
  test('renders a known component marker via the renderer (props unescaped)', async () => {
    const calls: { component: unknown; props: Record<string, unknown> }[] = [];
    const html = await expandRichTextComponents(`<p>before</p>${marker}<p>after</p>`, { Button }, stubRenderer(calls));
    expect(html).toBe('<p>before</p><a class="rendered-button">Go</a><p>after</p>');
    expect(calls).toEqual([{ component: Button, props: { text: 'Go', href: '/x' } }]);
  });

  test('keeps the marker for a component absent from the registry (meno-core parity)', async () => {
    const calls: { component: unknown; props: Record<string, unknown> }[] = [];
    const html = await expandRichTextComponents(`<p>x</p>${marker}`, {}, stubRenderer(calls));
    expect(html).toBe(`<p>x</p>${marker}`);
    expect(calls).toEqual([]);
  });

  test('keeps a marker whose props JSON is malformed', async () => {
    const bad = '<div data-meno-component="Button" data-meno-props="{not json"></div>';
    const html = await expandRichTextComponents(bad, { Button }, stubRenderer([]));
    expect(html).toBe(bad);
  });

  test('expands multiple markers, mixed known/unknown, in document order', async () => {
    const unknown = '<div data-meno-component="Mystery" data-meno-props="{}"></div>';
    const calls: { component: unknown; props: Record<string, unknown> }[] = [];
    const html = await expandRichTextComponents(
      `${marker}<p>mid</p>${unknown}${marker}`,
      { Button },
      stubRenderer(calls),
    );
    expect(html).toBe(`<a class="rendered-button">Go</a><p>mid</p>${unknown}<a class="rendered-button">Go</a>`);
    expect(calls.length).toBe(2);
  });

  test('passes marker-free HTML through untouched (no renderer work)', async () => {
    const html = await expandRichTextComponents('<p>plain</p>', { Button }, async () => {
      throw new Error('must not render');
    });
    expect(html).toBe('<p>plain</p>');
  });
});

describe('richTextWithComponents', () => {
  test('a TipTap doc with a URL embed resolves via the iframe fast path (no container)', async () => {
    // The Youtube marker carries a url prop → expandRichTextEmbeds consumes it inside
    // richText(); no renderable marker remains, so the container is never touched.
    const url = 'https://www.youtube.com/embed/VZEa13_DNHw';
    const doc: TiptapDocument = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'intro' }] },
        { type: 'menoComponent', attrs: { component: 'Youtube', props: { url } } },
      ],
    };
    const html = await richTextWithComponents(doc, {});
    expect(html).toContain('<p>intro</p>');
    expect(html).toContain(`<iframe src="${url}"`);
    expect(html).not.toContain('data-meno-component');
  });

  test('a non-embed marker with an empty registry keeps its marker (no container)', async () => {
    const doc: TiptapDocument = {
      type: 'doc',
      content: [{ type: 'menoComponent', attrs: { component: 'Button', props: { text: 'Go' } } }],
    };
    const html = await richTextWithComponents(doc, {});
    expect(html).toContain('data-meno-component="Button"');
  });
});
