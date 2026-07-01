import { test, expect, describe } from 'bun:test';
import { emit, parse, normalizeModel } from './index';

/**
 * Guards the CMS-under-SSR fix: a CMS `[slug]` template gets its `cms` prop from
 * getStaticPaths, which Astro IGNORES for on-demand routes under `output: 'server'`. So the
 * template MUST emit `export const prerender = true` to stay statically generated, else it
 * crashes at request time (`Cannot read … 'title'`). This was a real production bug — without
 * a unit test it would only be caught by the (not-in-CI) ssr-cms e2e.
 */
const cmsTemplate = {
  meta: {
    title: '{{cms.title}}',
    source: 'cms' as const,
    cms: {
      id: 'blog',
      slugField: 'slug',
      urlPattern: '/blog/{{slug}}',
      fields: { slug: { type: 'string' }, title: { type: 'string' } },
    },
  },
  root: { type: 'node' as const, tag: 'article', children: ['{{cms.title}}'] },
};

describe('CMS template pages prerender (SSR-safe)', () => {
  test('emit adds `export const prerender = true` ahead of getStaticPaths', () => {
    const out = emit(cmsTemplate as any);
    expect(out).toContain('export const prerender = true;');
    expect(out.indexOf('export const prerender = true;')).toBeLessThan(out.indexOf('getStaticPaths'));
  });

  test('a regular (non-CMS) page does NOT emit prerender', () => {
    const out = emit({ meta: { title: 'Home' }, root: { type: 'node', tag: 'main' } } as any);
    expect(out).not.toContain('prerender');
  });

  test('the prerender const is emit-only boilerplate — round-trips, never enters the model', () => {
    const n = normalizeModel(cmsTemplate);
    expect(parse(emit(n as any)).model).toEqual(n as any);
    expect(JSON.stringify(parse(emit(n as any)).model)).not.toContain('prerender');
  });
});
