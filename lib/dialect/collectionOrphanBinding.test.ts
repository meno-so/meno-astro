import { test, expect, describe } from 'bun:test';
import { emit, parse } from './index';

/**
 * Regression: a `getCollectionList` (or remote/sanity) binding consumed ONLY by hand-authored
 * frontmatter code — the body maps over a DERIVED variable, not the binding directly — must
 * survive parse→emit. Previously the binding was captured as a collection source and dropped on
 * emit (only regenerated when a body list node maps over it), leaving the passthrough code that
 * uses it (`const visible = providersList.filter(…)`) referencing an undefined identifier →
 * `ReferenceError` on every SSR render (the "page keeps blinking" dev-overlay loop).
 *
 * Shape drawn from a real Being-Health component (ProvidersTeam.astro).
 */
const PROVIDERS_TEAM = `---
import { getCollection } from 'astro:content';
import { getCollectionList, resolveProps, style } from 'meno-astro';
import { Link } from 'meno-astro/components';
const __props = resolveProps(Astro, {
  team: { type: "string", default: "main" }
});
const { team, class: className } = __props;

const providersList = await getCollectionList("providers", { sort: { field: "order", order: "asc" } }, Astro, getCollection);

const visibleProviders = providersList.filter((provider) => provider.undiscoverable !== true);
let teamProviders = visibleProviders;
if (team === "spravato") {
  teamProviders = visibleProviders.filter((provider) => provider.type === "psychiatrist");
}
---
<div class={style({}, __props, { root: true })}>
  {teamProviders.map((provider, providerIndex) => (
    <Link href={\`/providers/\${provider.slug}\`} class={style({}, __props, { label: "Card" })}>{provider.name}</Link>
  ))}
</div>`;

describe('orphaned getCollectionList binding (consumed only by frontmatter) survives emit', () => {
  test('the binding + its imports are preserved, and the body is an editable expression list', () => {
    const model = parse(PROVIDERS_TEAM).model as any;

    // The body maps over the DERIVED var → an editable expression list, not a collection list.
    const list = model.component.structure.children[0];
    expect(list.type).toBe('list');
    expect(list.sourceType).toBe('expression');
    expect(list.source).toBe('teamProviders');

    // The binding declaration is kept verbatim in the frontmatter passthrough (not dropped).
    expect(model.component._frontmatter).toContain('const providersList = await getCollectionList("providers"');

    const out = emit(model);
    // The `getCollectionList` const survives — nothing downstream references an undefined var.
    expect(out).toContain('const providersList = await getCollectionList("providers"');
    // …and its helper imports come back: `getCollection` (astro:content) + `getCollectionList`.
    expect(out).toContain("import { getCollection } from 'astro:content';");
    expect(out).toMatch(/import \{[^}]*\bgetCollectionList\b[^}]*\} from 'meno-astro';/);
    // The derived consts still resolve.
    expect(out).toContain('const visibleProviders = providersList.filter');
    expect(out).toContain('let teamProviders = visibleProviders;');
  });

  test('round-trips byte-for-byte on re-emit (idempotent)', () => {
    const once = emit(parse(PROVIDERS_TEAM).model as any);
    const twice = emit(parse(once).model as any);
    expect(twice).toBe(once);
    // The re-emitted file has exactly one declaration of the binding (no duplicate).
    expect(once.match(/const providersList\b/g)?.length).toBe(1);
  });
});
