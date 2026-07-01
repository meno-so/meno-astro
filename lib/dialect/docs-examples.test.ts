/**
 * Docs-examples gate — keeps `docs/meno-astro-dialect.md` and `docs/meno-astro-api.md`
 * honest. Every model shape the docs show as a dialect example is asserted to round-trip
 * exactly here, and the documented emit encodings (style() meta-key renaming, dynamic
 * tags, the collection-list loop-variable gap) are pinned so the docs can't drift from
 * the codec.
 */

import { test, expect, describe } from 'bun:test';
import { emit, parse, normalizeModel } from './index';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const comp = (structure: unknown): any => ({ component: { structure } });

/** The contract the docs cite: parse(emit(normalizeModel(x))) === normalizeModel(x). */
function assertRoundTrip(x: unknown) {
  const n = normalizeModel(x);
  expect(normalizeModel(n)).toEqual(n as any); // idempotent
  expect(parse(emit(n as any)).model).toEqual(n as any);
}

describe('docs: every dialect example round-trips', () => {
  test('§3.1 page file — meta + BaseLayout-wrapped root', () => {
    assertRoundTrip({
      meta: { title: 'List Demo', description: 'Demonstrates the List node' },
      root: {
        type: 'node',
        tag: 'main',
        children: [{ type: 'component', component: 'ListSection', props: { title: 'Our Features' } }],
      },
    });
  });

  test('§3.1.1 CMS template page — meta.cms schema + {{cms.field}} body (getStaticPaths is emit-only)', () => {
    assertRoundTrip({
      meta: {
        title: '{{cms.title}} | Blog',
        source: 'cms',
        cms: {
          id: 'blog',
          name: 'Blog Posts',
          slugField: 'slug',
          urlPattern: '/blog/{{slug}}',
          fields: { title: { type: 'string', required: true }, slug: { type: 'string', required: true } },
        },
      },
      root: {
        type: 'node',
        tag: 'article',
        children: [
          { type: 'component', component: 'Heading', props: { text: '{{cms.title}}', size: 1 } },
          { type: 'node', tag: 'div', children: '{{cms.content}}' },
        ],
      },
    });
  });

  test('§3.2 component file — resolveProps/__meno (Button)', () => {
    assertRoundTrip({
      component: {
        category: 'ui',
        interface: {
          text: { type: 'string', default: 'Link' },
          isMarginTop: { type: 'boolean', default: false },
          link: { type: 'link', default: { href: '#' } },
        },
        structure: {
          type: 'link',
          href: { _mapping: true, prop: 'link' },
          children: [{ type: 'node', tag: 'span', style: { base: { color: 'var(--text)' } }, children: '{{text}}' }],
        },
      },
    });
  });

  test('§4.1 node — responsive style + attributes + children', () => {
    assertRoundTrip(
      comp({
        type: 'node',
        tag: 'section',
        style: { base: { display: 'flex', gap: '12px' }, tablet: { gap: '8px' }, mobile: {} },
        attributes: { 'data-id': 'x', role: 'region' },
        children: [
          { type: 'node', tag: 'h2', children: 'Title' },
          { type: 'node', tag: 'p', children: 'Hi {{name}}!' },
        ],
      }),
    );
  });

  test('§4.1 node — img void element with style', () => {
    assertRoundTrip(
      comp({
        type: 'node',
        tag: 'img',
        style: { base: { objectFit: 'cover' }, tablet: { height: '380px' }, mobile: {} },
        attributes: { src: '/images/img.jpg', alt: '' },
      }),
    );
  });

  test('§4.1 style() meta — interactive/label/genClass renaming', () => {
    assertRoundTrip(
      comp({
        type: 'node',
        tag: 'a',
        style: { base: { color: { _mapping: true, prop: 'tone', values: { dark: '#000', light: '#fff' } } } },
        interactiveStyles: [{ name: 'onHover', postfix: ':hover', style: { base: { opacity: '0.8' } } }],
        label: 'cta',
        generateElementClass: true,
      }),
    );
  });

  test('§4.2 component instance — mixed prop kinds + i18n', () => {
    assertRoundTrip(
      comp({
        type: 'component',
        component: 'Button',
        props: {
          text: { _i18n: true, en: 'Go', pl: 'Idź' },
          size: 1,
          isMarginTop: true,
          link: { href: '/x', target: '_blank' },
        },
        style: { base: { marginTop: '8px' } },
      }),
    );
  });

  test('§4.3/4.4/4.5/4.6 link, embed (single + multi-line), slot, locale-list', () => {
    assertRoundTrip(comp({ type: 'link', href: '/pricing', children: 'Pricing' }));
    assertRoundTrip(comp({ type: 'embed', html: '<svg><path d="M0 0"/></svg>' }));
    assertRoundTrip(comp({ type: 'embed', html: '<svg>\n  <path d="M0 0"/>\n  <path d="M1 1"/>\n</svg>' }));
    assertRoundTrip(comp({ type: 'slot', default: [{ type: 'node', tag: 'p', children: 'fallback' }] }));
    assertRoundTrip(
      comp({
        type: 'locale-list',
        displayType: 'nativeName',
        showFlag: true,
        style: { base: { display: 'flex' } },
        itemStyle: { padding: '4px' },
      }),
    );
  });

  test('§5.1 prop list + §5.2 collection list', () => {
    assertRoundTrip(
      comp({
        type: 'list',
        sourceType: 'prop',
        source: '{{items}}',
        itemAs: 'thing',
        limit: 6,
        children: [{ type: 'node', tag: 'span', children: '{{thing.label}}' }],
      }),
    );
    assertRoundTrip(
      comp({
        type: 'list',
        sourceType: 'collection',
        source: 'blog',
        itemAs: 'post',
        filter: { field: 'featured', operator: 'eq', value: true },
        sort: { field: 'publishedAt', order: 'desc' },
        children: [{ type: 'component', component: 'Card', props: { title: '{{post.title}}' } }],
      }),
    );
  });

  test('§6.2 conditionals + §6.3 dynamic tag', () => {
    assertRoundTrip(comp({ type: 'node', tag: 'div', if: '{{visible}}', children: 'A' }));
    assertRoundTrip(comp({ type: 'node', tag: 'div', if: false, children: 'B' }));
    assertRoundTrip(comp({ type: 'node', tag: 'h{{size}}', children: 'Heading' }));
  });

  test('§8.2 legacy migration: cms-list → div>list, image → img', () => {
    assertRoundTrip({
      component: {
        structure: {
          type: 'cms-list',
          collection: 'products',
          style: { display: 'grid', gap: '16px' },
          attributes: { 'data-meno-list': '' },
          children: [{ type: 'node', tag: 'div', children: '{{product.name}}' }],
        },
      },
    });
    assertRoundTrip(comp({ type: 'image', src: '/a.jpg', alt: 'pic', style: { base: { objectFit: 'cover' } } }));
  });
});

describe('docs: pinned emit encodings (claims in the spec)', () => {
  test('component props emit a single authoritative resolveProps(Astro, {…}) call', () => {
    const src = emit({
      component: {
        interface: {
          text: { type: 'string', default: 'Link' },
          isMarginTop: { type: 'boolean', default: false },
          link: { type: 'link', default: { href: '#' } },
        },
        structure: { type: 'node', tag: 'span', children: '{{text}}' },
      },
    } as any);
    // One import line of the runtime helpers (`cx` rides along — the style-less structure
    // root emits `cx(className)` to merge the incoming instance class), no MenoProps type
    // import, no interface Props / __meno_props.
    expect(src).toContain("import { cx, resolveProps } from 'meno-astro';");
    expect(src).not.toContain('interface Props');
    expect(src).not.toContain('__meno_props');
    expect(src).not.toContain('Astro.props');
    expect(src).not.toContain('satisfies MenoProps');
    expect(src).not.toContain('import type { MenoProps');
    // `__props` holds the authoritative resolveProps() result (passed to style() for
    // mapping resolution); the destructure binds the prop names + class: className.
    expect(src).toContain('const __props = resolveProps(Astro, {');
    expect(src).toContain('const { text, isMarginTop, link, class: className } = __props;');
    expect(src).toContain('text: { type: "string", default: "Link" }');
  });

  test('an empty-interface component still emits the resolveProps call', () => {
    const src = emit({ component: { structure: { type: 'node', tag: 'div', children: 'x' } } } as any);
    expect(src).toContain('const __props = resolveProps(Astro, {});');
    expect(src).toContain('const { class: className } = __props;');
  });

  test('style() emits the meta object with renamed keys', () => {
    const src = emit(
      comp({
        type: 'node',
        tag: 'a',
        style: { base: { color: 'red' } },
        // A context-prefixed rule is NOT convertible to a variant class, so it stays in the
        // style() interactive meta (a convertible bare `:hover` would lower to a `hover:` token).
        interactiveStyles: [
          { name: 'onHover', prefix: '.is-dark ', postfix: ':hover', style: { base: { opacity: '0.8' } } },
        ],
        label: 'cta',
        generateElementClass: true,
      }),
    );
    // The `<a>` is the structure root → style() is wrapped in the cx instance-merge form.
    expect(src).toContain('class={cx(style(');
    expect(src).toContain('interactive:');
    expect(src).toContain('label: "cta"');
    expect(src).toContain('genClass: true');
  });

  test('dynamic tag hoists to a frontmatter const and references it', () => {
    const src = emit(comp({ type: 'node', tag: 'h{{size}}', children: 'Heading' }));
    expect(src).toContain('const Tag_0 = `h${size}`;');
    expect(src).toContain('<Tag_0');
  });

  test('multi-line embed HTML is hoisted to __embedN', () => {
    const src = emit(comp({ type: 'embed', html: '<svg>\n  <path d="M0 0"/>\n</svg>' }));
    expect(src).toContain('const __embed0 = `');
    expect(src).toContain('html={__embed0}');
  });

  test('§4.4 a hand-authored embed hoist under a non-__embedN name is recovered, not lost', () => {
    // The codec's canonical hoist name is `__embedN`, but an author may name the const
    // anything. Parse must resolve `html={__iconChat}` to the verbatim SVG (not a phantom
    // `{{__iconChat}}` binding), and emit must re-hoist it as `__embed0` — name normalizes,
    // HTML survives. Regression guard for the silent-SVG-loss round-trip bug.
    const authored = [
      '---',
      'const __iconChat = `<svg width="10" height="10">',
      '<path d="M0 0" />',
      '</svg>`;',
      'const { class: className } = resolveProps(Astro, {});',
      '---',
      '<div class={className}>',
      '  <Embed html={__iconChat} />',
      '</div>',
      '',
    ].join('\n');

    const { model } = parse(authored);
    // The SVG is recovered verbatim into the embed node — NOT misread as a binding.
    const svg = '<svg width="10" height="10">\n<path d="M0 0" />\n</svg>';
    const embed = (model as any).component.structure.children[0];
    expect(embed).toEqual({ type: 'embed', html: svg });
    expect(JSON.stringify(model)).not.toContain('{{__iconChat}}');

    // Emit normalizes the const NAME to `__embed0` while preserving the HTML, and never
    // re-emits the custom name as a bogus prop destructure.
    const out = emit(model);
    expect(out).toContain('const __embed0 = `');
    expect(out).toContain('html={__embed0}');
    expect(out).toContain('<path d="M0 0" />');
    expect(out).not.toContain('__iconChat');

    // Stable thereafter (the recovered model is already canonical).
    expect(parse(emit(model)).model).toEqual(model as any);
  });

  test('defineVars: true emits native <script define:vars={{…}}> (all interface props) and keeps it out of __meno', () => {
    const src = emit({
      component: {
        category: 'ui',
        interface: {
          text: { type: 'string', default: 'Link' },
          isMarginTop: { type: 'boolean', default: false },
        },
        structure: { type: 'node', tag: 'div', children: '{{text}}' },
        javascript: 'const el = document.currentScript.previousElementSibling;\nel.dataset.t = text;',
        defineVars: true,
      },
    } as any);
    expect(src).toContain('<script define:vars={{ text, isMarginTop }}>');
    expect(src).not.toContain('<script is:inline>');
    // __meno carries only category — never defineVars.
    expect(src).toContain('const __meno = { category: "ui" };');
    expect(src).not.toContain('defineVars');
  });

  test('defineVars: ["x"] emits a shorthand subset and keeps it out of __meno', () => {
    const src = emit({
      component: {
        interface: {
          text: { type: 'string', default: 'Link' },
          isMarginTop: { type: 'boolean', default: false },
        },
        structure: { type: 'node', tag: 'div', children: '{{text}}' },
        javascript: 'el.dataset.t = isMarginTop;',
        defineVars: ['isMarginTop'],
      },
    } as any);
    expect(src).toContain('<script define:vars={{ isMarginTop }}>');
    expect(src).not.toContain('<script is:inline>');
    expect(src).not.toContain('defineVars');
    expect(src).not.toContain('__meno'); // its only would-be meta (defineVars) is no longer in __meno
  });

  test('a component whose ONLY meta was defineVars emits no __meno line', () => {
    const src = emit({
      component: {
        interface: { count: { type: 'number', default: 0 } },
        structure: { type: 'node', tag: 'span', children: '{{count}}' },
        javascript: 'el.textContent = count;',
        defineVars: true,
      },
    } as any);
    expect(src).toContain('<script define:vars={{ count }}>');
    expect(src).not.toContain('__meno');
  });

  test('component WITHOUT defineVars still emits a plain <script is:inline>', () => {
    const src = emit({
      component: {
        structure: { type: 'node', tag: 'div', children: 'x' },
        javascript: 'console.log(1)',
      },
    } as any);
    expect(src).toContain('<script is:inline>');
    expect(src).not.toContain('define:vars');
  });

  test('defineVars round-trips: true, explicit subset, all-props→true, no-JS drop', () => {
    const iface = {
      text: { type: 'string', default: 'Link' },
      isMarginTop: { type: 'boolean', default: false },
    };
    const js = 'const el = document.currentScript.previousElementSibling;\nel.dataset.t = text;';
    // true → emit all → parse all → normalize back to true.
    assertRoundTrip({
      component: {
        category: 'ui',
        interface: iface,
        structure: { type: 'node', tag: 'div', children: '{{text}}' },
        javascript: js,
        defineVars: true,
      },
    });
    // explicit subset stays a string[].
    assertRoundTrip({
      component: {
        interface: iface,
        structure: { type: 'node', tag: 'div', children: '{{text}}' },
        javascript: js,
        defineVars: ['isMarginTop'],
      },
    });
    // an explicit list naming every prop canonicalizes to true (same set).
    const allList = normalizeModel({
      component: {
        interface: iface,
        structure: { type: 'node', tag: 'div', children: '{{text}}' },
        javascript: js,
        defineVars: ['text', 'isMarginTop'],
      },
    }) as any;
    expect(allList.component.defineVars).toBe(true);
    assertRoundTrip(allList);
    // defineVars with no javascript is meaningless → dropped by normalize, absent after round-trip.
    const noJs = normalizeModel({
      component: { interface: iface, structure: { type: 'node', tag: 'div', children: 'x' }, defineVars: true },
    }) as any;
    expect('defineVars' in noJs.component).toBe(false);
    assertRoundTrip(noJs);
  });

  test('migrated cms-list (no itemAs) binds the loop to `item` to match {{item.*}} children', () => {
    // normalize.ts migrateLegacy sets itemAs:"item" for legacy cms-list, so the emitted
    // collection loop var matches the children's {{item.*}} templates (was a bug: it used
    // singularize(source)).
    const src = emit({
      component: {
        structure: {
          type: 'cms-list',
          collection: 'products',
          attributes: { 'data-meno-list': '' },
          children: [{ type: 'node', tag: 'div', attributes: { 'data-id': '{{item._id}}' } }],
        },
      },
    } as any);
    expect(src).toContain('.map((item, itemIndex)');
    // loop var matches the children; the `|| undefined` guard is the meno-core parity for an
    // entirely-`{{template}}` node attribute (dropped when it resolves to "" — skipEmptyTemplateAttributes).
    // The bare `{{item._id}}` chain is i18n()-wrapped: collection items are RAW entry data,
    // so an { _i18n, … } field would otherwise interpolate as "[object Object]" (identity
    // for plain values like _id).
    expect(src).toContain('data-id={i18n(item._id) || undefined}');
  });

  test('legacy `collection`-field list (no source) → promoted to source + sourceType, loop bound to `item`', () => {
    // A `type:"list"` node that still carries the deprecated `collection` field (and no
    // `source`) used to crash emit: singularize(undefined) → "undefined is not an object
    // (evaluating 'collection.endsWith')". normalize.ts migrateLegacy now promotes the
    // string `collection` to `source`, infers sourceType:"collection", and binds the loop to
    // `item` (legacy collection-list children reference {{item.*}}).
    const src = emit(
      comp({
        type: 'list',
        sourceType: 'collection',
        collection: 'case-study-category',
        children: [{ type: 'node', tag: 'span', children: '{{item.title}}' }],
      }),
    );
    expect(src).toContain('await getCollectionList("case-study-category"');
    expect(src).toContain('.map((item, itemIndex)');
    expect(src).toContain('<span>{i18n(item.title)}</span>');
  });

  test('collection name that is not a JS identifier → singularize sanitizes the loop var (case-study → caseStudy)', () => {
    // A collection list with an explicit `source` whose name has a hyphen and no itemAs:
    // the default loop var was singularize("case-study") === "case-study", an invalid `.map`
    // arg. singularize() now coerces it to a valid identifier so the emitted JS parses.
    const src = emit(
      comp({
        type: 'list',
        sourceType: 'collection',
        source: 'case-study',
        children: [{ type: 'node', tag: 'span', children: '{{caseStudy.title}}' }],
      }),
    );
    expect(src).toContain('await getCollectionList("case-study"'); // real collection name kept
    expect(src).toContain('.map((caseStudy, caseStudyIndex)'); // loop var is a valid identifier
    expect(src).not.toContain('case-study, '); // no invalid hyphenated `.map` arg
  });

  test('prop named `list` does not shadow the `list()` helper — import is aliased, round-trips', () => {
    // A list component conventionally names its items prop `list` (`source: "{{list}}"`).
    // The destructured `const { list } = __props` would shadow the imported `list()` helper,
    // so `list(list)` calls the Array → runtime "list is not a function". Emit aliases the
    // helper import (`list as list$`) and calls `list$(list)`; the prop reference stays bare.
    const model = {
      component: {
        interface: { list: { type: 'list', itemSchema: {}, default: [] } },
        structure: {
          type: 'list',
          sourceType: 'prop',
          source: '{{list}}',
          children: [{ type: 'node', tag: 'span', children: '{{item.title}}' }],
        },
      },
    };
    const src = emit(model as any);
    expect(src).toContain("import { list as list$, resolveProps } from 'meno-astro';");
    expect(src).toContain('const { list, class: className } = __props;');
    expect(src).toContain('{list$(list).map((item, itemIndex) => (');
    expect(src).not.toMatch(/[^A-Za-z0-9_$.]list\(list/); // no un-aliased collision
    assertRoundTrip(model); // parse resolves the `list as list$` alias back to the prop source
  });

  test('a prop-list whose prop is NOT a helper name imports `list` plainly (no needless alias)', () => {
    const src = emit(
      comp({
        type: 'list',
        sourceType: 'prop',
        source: '{{items}}',
        children: [{ type: 'node', tag: 'span', children: '{{item.title}}' }],
      }),
    );
    expect(src).toContain("import { list, resolveProps } from 'meno-astro';");
    expect(src).toContain('{list(items).map((item, itemIndex) => (');
    expect(src).not.toContain('list as'); // no alias when there's no collision
  });

  test('§6.4 CMS-data bindings wrap in i18n(): emit forms + the parse disambiguation table', () => {
    const page = {
      meta: {
        source: 'cms',
        cms: { id: 'blog', slugField: 'slug', urlPattern: '/blog/{{slug}}', fields: {} },
      },
      root: {
        type: 'node',
        tag: 'article',
        children: [
          { type: 'node', tag: 'h1', children: '{{cms.title}}' },
          { type: 'node', tag: 'em', children: '{{cms.title.pl}}' },
          { type: 'node', tag: 'span', children: 'By {{cms.author}}' },
          { type: 'node', tag: 'b', children: '{{cms.price * 2}}' },
        ],
      },
    };
    const src = emit(normalizeModel(page) as any);
    expect(src).toContain('<h1>{i18n(cms.title)}</h1>'); // whole-template value position
    expect(src).toContain('<em>{i18n(cms.title.pl)}</em>'); // forced-locale suffix: no special case
    expect(src).toContain('{`By ${i18n(cms.author)}`}'); // template-literal interpolation
    expect(src).toContain('{cms.price * 2}'); // operator expression: NOT wrapped (boundary)
    assertRoundTrip(page);

    // Parse disambiguation by argument shape (the §6.4 table):
    const wrap = (expr: string) =>
      (
        parse(
          `---\nimport { resolveProps } from 'meno-astro';\n\nconst __props = resolveProps(Astro, {});\nconst { class: className } = __props;\n---\n<div data-x={${expr}}>x</div>\n`,
        ).model as any
      ).component.structure.attributes['data-x'];
    expect(wrap('i18n({ _i18n: true, en: "Go" })')).toEqual({ _i18n: true, en: 'Go' }); // VALUE literal
    expect(wrap('i18n(cms.title)')).toBe('{{cms.title}}'); // wrapped BINDING
    expect(wrap('i18n(fn(x))')).toEqual({ _code: true, expr: 'i18n(fn(x))' }); // authored JS → verbatim
  });

  test('§10 verbatim escape hatch: un-evaluatable JS → { _code, expr } + verbatim region', () => {
    // meno-core's evaluator rejects function/method calls, so `(price * 0.8).toFixed(2)`
    // can't be a {{binding}} — it is preserved verbatim, round-trips, builds natively, and
    // is reported as a `verbatim` region.
    const node = comp({
      type: 'node',
      tag: 'span',
      children: [{ _code: true, expr: '(product.price * 0.8).toFixed(2)' }],
    });
    assertRoundTrip(node);
    const src = emit(node);
    expect(src).toContain('{(product.price * 0.8).toFixed(2)}'); // native JS under astro build
    expect(parse(src).regions.some((r) => r.kind === 'verbatim')).toBe(true);
  });
});
