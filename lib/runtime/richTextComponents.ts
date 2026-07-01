/**
 * Render arbitrary project components embedded in CMS rich text (the generic
 * companion of `expandRichTextEmbeds` — together they are the dialect twin of
 * meno-core SSR's `expandRichTextComponents`, ssrRenderer.ts).
 *
 * A CMS rich-text body can embed ANY project component via a TipTap `menoComponent`
 * node; `tiptapToHtml` serializes it to a placeholder marker
 * (`<div data-meno-component="Button" data-meno-props="{…}"></div>`). meno-core's SSR
 * expands the marker by RUNNING the component renderer; the astro pipeline renders
 * rich text as a string through `set:html`, so `expandRichTextEmbeds` reconstructs the
 * uniform URL-embed components (Youtube → iframe) — but a generic component (a Button,
 * a Callout) has real `.astro` markup only its compiled component can produce, and
 * without this pass its marker reaches the page as an empty `<div>`.
 *
 * This pass renders those markers to HTML strings with Astro's Container API
 * (`experimental_AstroContainer`), against the converter-generated registry module
 * (`src/cmsComponents.ts` — every project component by name; see convertProject's
 * buildCmsComponentsModule). That works because of how the rest of the format is built:
 *   - utility/interactive CSS is one BUILD-time global stylesheet scanned from every
 *     `.astro` source (see runtime/style.ts), so a container-rendered class matches it;
 *   - component `<style is:global>` CSS ships through the registry's import graph;
 *   - component scripts are inline (`is:inline` / `define:vars`), so they render INTO
 *     the returned string.
 * Unknown components and unparseable props keep their marker (meno-core parity);
 * a render error propagates (a broken component should fail the build, not vanish).
 *
 * Lives in meno-astro (not meno-core) on purpose: the play runtime installs meno-core
 * from PUBLISHED npm — meno-astro is rebuilt from the workspace, so this ships with it.
 */

import { MARKER_RE, unescapeAttr } from './expandRichTextEmbeds';
import { richText } from './richText';

/** Renders one component (a compiled `.astro` default export) with props to HTML. */
export type ComponentRenderer = (component: unknown, props: Record<string, unknown>) => Promise<string>;

// One shared container per process — creation is not free, and every rich-text body
// on every page funnels through here during a build.
let containerRenderer: Promise<ComponentRenderer> | null = null;

/**
 * Lazily create the shared Astro Container renderer. `astro/container` is imported
 * dynamically so this module never drags `astro` (a peer dependency) into the static
 * graph — the import only resolves when a renderable marker actually exists, which
 * can only happen inside a running Astro build/dev where `astro` is installed.
 */
function getContainerRenderer(): Promise<ComponentRenderer> {
  containerRenderer ??= import('astro/container').then(async ({ experimental_AstroContainer }) => {
    const container = await experimental_AstroContainer.create();
    return (component, props) => container.renderToString(component, { props });
  });
  return containerRenderer;
}

/**
 * Replace `menoComponent` markers in a rich-text HTML string with the named project
 * component rendered to real markup. Markers naming a component absent from
 * `components` (or carrying unparseable props) pass through untouched — exactly the
 * markers meno-core's SSR would also leave. The `render` parameter exists for unit
 * tests; production callers use the shared container renderer.
 */
export async function expandRichTextComponents(
  html: string,
  components: Record<string, unknown>,
  render?: ComponentRenderer,
): Promise<string> {
  if (typeof html !== 'string' || !html.includes('data-meno-component')) return html;
  // Resolve each marker to its component + props first: the container is only created
  // when at least one marker is actually renderable (String.replace can't await).
  const jobs: { index: number; marker: string; component: unknown; props: Record<string, unknown> }[] = [];
  for (const m of html.matchAll(MARKER_RE)) {
    const name = m[1] ?? '';
    const component = components?.[name];
    if (!component) continue;
    try {
      jobs.push({ index: m.index, marker: m[0], component, props: JSON.parse(unescapeAttr(m[2] ?? '')) });
    } catch {
      // malformed props JSON — keep the marker
    }
  }
  if (jobs.length === 0) return html;
  const renderFn = render ?? (await getContainerRenderer());
  let out = '';
  let last = 0;
  for (const job of jobs) {
    out += html.slice(last, job.index) + (await renderFn(job.component, job.props));
    last = job.index + job.marker.length;
  }
  return out + html.slice(last);
}

/**
 * The full CMS rich-text render pipeline INCLUDING embedded components: `richText()`
 * (locale resolve → TipTap → HTML → URL-embed fast-path → link localization), then
 * the component-marker expansion above. The dialect emitter binds a CMS rich-text
 * field as `<Fragment set:html={richTextWithComponents(cms.content, cmsComponents)} />`
 * — `set:html` awaits the returned promise natively. Internal links inside rendered
 * components localize themselves (Link.astro runs `localizeHref` at render), so the
 * component pass composes cleanly after `richText()`'s own link pass.
 */
export async function richTextWithComponents(value: unknown, components: Record<string, unknown>): Promise<string> {
  return expandRichTextComponents(richText(value), components);
}
