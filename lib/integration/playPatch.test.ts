/**
 * Unit tests for the play-mode targeted patch system (lib/integration/playPatch.ts):
 *
 * - classifyModelEdit / classifyAstroEdit — the edit ladder's brain: style-only
 *   and text-only edits are patchable, everything else is structural.
 * - playPatchVitePlugin — ladder decisions over real sources: patch events
 *   (with stale tokens) vs stock full reload, theme.css branch, baselines.
 * - PATCH_JS — the restricted client patch evaluated as real JS against a
 *   happy-dom document (same pattern as xrayResolver.test.ts): sheet swap,
 *   token-granular class merge that survives JS-added tokens, property-granular
 *   inline style that survives fade.js reveals, text sync.
 */

import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Window } from 'happy-dom';
import { emit } from '../dialect';
import { collectNodeClassTokens } from './utilityCss';
import {
  extractScriptBlocks,
  classifyModelEdit,
  classifyAstroEdit,
  playPatchVitePlugin,
  PLAY_PATCH_EVENT,
  PLAY_STYLE_PREVIEW_EVENT,
  PLAY_VARS_PREVIEW_EVENT,
  PATCH_JS,
  PLAY_PATCH_BRIDGE_SCRIPT,
} from './playPatch';
import { XRAY_RESOLVER_JS } from './xray';

// ---------------------------------------------------------------------------
// Model fixtures
// ---------------------------------------------------------------------------

const page = (root: Record<string, unknown>) => ({ meta: { title: 'T' }, root });

const baseModel = () =>
  page({
    type: 'node',
    tag: 'div',
    style: { base: { gap: '224px' } },
    children: [
      { type: 'node', tag: 'p', style: { base: { fontSize: '16px' } }, children: 'Hello world' },
      { type: 'node', tag: 'span', children: 'plain' },
    ],
  });

describe('classifyModelEdit', () => {
  test('style({...}) value change → style diff carrying the OLD style, not structural', () => {
    const a = baseModel();
    const b = baseModel();
    ((b.root as any).style as any).base.gap = '223px';
    const c = classifyModelEdit(a, b);
    expect(c.structural).toBe(false);
    expect(c.textChanged).toBe(false);
    expect(c.styleDiffs).toHaveLength(1);
    expect((c.styleDiffs[0]!.style as any).base.gap).toBe('224px'); // old side
  });

  test('plain text child change → text, not structural', () => {
    const a = baseModel();
    const b = baseModel();
    ((b.root as any).children as any)[0].children = 'Hello edited';
    const c = classifyModelEdit(a, b);
    expect(c).toEqual({
      structural: false,
      styleDiffs: [],
      textChanged: true,
      attrsChanged: false,
      htmlChanged: false,
    });
  });

  test('style + text in one edit → both flags', () => {
    const a = baseModel();
    const b = baseModel();
    ((b.root as any).style as any).base.gap = '223px';
    ((b.root as any).children as any)[1].children = 'edited';
    const c = classifyModelEdit(a, b);
    expect(c.structural).toBe(false);
    expect(c.styleDiffs).toHaveLength(1);
    expect(c.textChanged).toBe(true);
  });

  test('structural changes → structural: child added, tag changed', () => {
    const added = baseModel();
    ((added.root as any).children as any).push({ type: 'node', tag: 'h2', children: 'new' });
    expect(classifyModelEdit(baseModel(), added).structural).toBe(true);

    const retagged = baseModel();
    ((retagged.root as any).children as any)[0].tag = 'h1';
    expect(classifyModelEdit(baseModel(), retagged).structural).toBe(true);
  });

  test('markup-looking text change → structural (rich text is not a text-node patch)', () => {
    const a = baseModel();
    const b = baseModel();
    ((b.root as any).children as any)[1].children = 'with <b>markup</b>';
    expect(classifyModelEdit(a, b).structural).toBe(true);
  });

  test('a component scalar prop change → attrs patch, never a style diff', () => {
    const propA = page({
      type: 'component',
      component: 'Card',
      props: { label: 'old', style: 'fancy' },
    });
    const propB = page({
      type: 'component',
      component: 'Card',
      props: { label: 'new', style: 'fancy' },
    });
    // props is data, not the node's style/label fields — a scalar change
    // re-syncs as attrs/text in place and never produces a style diff.
    const c = classifyModelEdit(propA, propB);
    expect(c.structural).toBe(false);
    expect(c.attrsChanged).toBe(true);
    expect(c.styleDiffs).toHaveLength(0);
    expect(c.textChanged).toBe(false);
  });

  test('non-scalar / opaque prop value changes → structural (reload, never a wrong patch)', () => {
    const withProp = (props: Record<string, unknown>) => page({ type: 'component', component: 'Card', props });
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ body: { type: 'rich-text', html: '<p>a</p>' } }, { body: { type: 'rich-text', html: '<p>b</p>' } }], // object
      [{ items: ['a', 'b'] }, { items: ['a', 'b', 'c'] }], // array
      [{ onClick: { _code: true, expr: 'a()' } }, { onClick: { _code: true, expr: 'b()' } }], // verbatim code
      [{ href: 'plain' }, { href: '{{cms.url}}' }], // opaque binding string
      [{ title: { _i18n: true, en: 'Hi' } }, { title: { _i18n: true, en: 'Yo {{x}}' } }], // i18n value carrying a binding
    ];
    for (const [a, b] of cases) {
      const c = classifyModelEdit(withProp(a), withProp(b));
      expect(c.structural).toBe(true);
      expect(c.attrsChanged).toBe(false);
      expect(c.htmlChanged).toBe(false);
    }
  });

  test('rich-text (markup-string) prop change → html (innerHTML re-sync), not structural', () => {
    const withProp = (props: Record<string, unknown>) => page({ type: 'component', component: 'Heading', props });
    // a markup-bearing title (set:html → elements) — patch by replacing innerHTML
    const a = withProp({ title: 'Build a <span class="hl">great</span> site' });
    const b = withProp({ title: 'Build a <span class="hl">better</span> site' });
    const c = classifyModelEdit(a, b);
    expect(c.structural).toBe(false);
    expect(c.htmlChanged).toBe(true);
    expect(c.attrsChanged).toBe(false);
    // an i18n value carrying markup → html too
    const ai = withProp({ title: { _i18n: true, en: 'Hi <b>there</b>', pl: 'Hej' } });
    const bi = withProp({ title: { _i18n: true, en: 'Hi <b>you</b>', pl: 'Hej' } });
    expect(classifyModelEdit(ai, bi).htmlChanged).toBe(true);
    expect(classifyModelEdit(ai, bi).structural).toBe(false);
  });

  test('a scalar prop AND a rich-text prop change in one save → both attrs and html', () => {
    const withProps = (props: Record<string, unknown>) => page({ type: 'component', component: 'Hero', props });
    const a = withProps({ theme: 'light', title: 'Plain <b>old</b> headline' });
    const b = withProps({ theme: 'dark', title: 'Plain <b>new</b> headline' });
    const c = classifyModelEdit(a, b);
    expect(c.structural).toBe(false);
    expect(c.attrsChanged).toBe(true);
    expect(c.htmlChanged).toBe(true);
  });

  test('plain-string i18n prop change → attrs (resolves to one locale string = text/attr in place)', () => {
    const withProp = (props: Record<string, unknown>) => page({ type: 'component', component: 'Text', props });
    // a locale value edited; another locale untouched — still patchable
    const a = withProp({ text: { _i18n: true, en: 'Hello', pl: 'Czesc' } });
    const b = withProp({ text: { _i18n: true, en: 'Hello there', pl: 'Czesc' } });
    const c = classifyModelEdit(a, b);
    expect(c.structural).toBe(false);
    expect(c.attrsChanged).toBe(true);
    // adding/removing a locale is still just a resolved-string change for the active locale
    const d = withProp({ text: { _i18n: true, en: 'Hello', pl: 'Czesc', de: 'Hallo' } });
    expect(classifyModelEdit(a, d).structural).toBe(false);
    expect(classifyModelEdit(a, d).attrsChanged).toBe(true);
  });

  test('component identity swap → structural even when props are scalar-equal', () => {
    const a = page({ type: 'component', component: 'Card', props: { label: 'x' } });
    const b = page({ type: 'component', component: 'Panel', props: { label: 'x' } });
    expect(classifyModelEdit(a, b).structural).toBe(true);
  });

  test('a style edit and a component prop edit in one save → both style diff and attrs', () => {
    const a = page({
      type: 'node',
      tag: 'div',
      style: { base: { gap: '224px' } },
      children: [{ type: 'component', component: 'Card', props: { label: 'old' } }],
    });
    const b = page({
      type: 'node',
      tag: 'div',
      style: { base: { gap: '223px' } },
      children: [{ type: 'component', component: 'Card', props: { label: 'new' } }],
    });
    const c = classifyModelEdit(a, b);
    expect(c.structural).toBe(false);
    expect(c.styleDiffs).toHaveLength(1);
    expect(c.attrsChanged).toBe(true);
  });
});

describe('classifyAstroEdit (source level, round-tripped through the dialect)', () => {
  test('emitted style edit classifies as style-only with the old style values', () => {
    const oldSrc = emit(baseModel() as any);
    const next = baseModel();
    ((next.root as any).style as any).base.gap = '223px';
    const newSrc = emit(next as any);
    const c = classifyAstroEdit(oldSrc, newSrc);
    expect(c.structural).toBe(false);
    expect(c.styleDiffs).toHaveLength(1);
  });

  test('unparseable source (mid-typing) → structural', () => {
    const oldSrc = emit(baseModel() as any);
    expect(classifyAstroEdit(oldSrc, '<div class={style({').structural).toBe(true);
  });

  test('emitted component scalar-prop edit classifies as attrs, not structural', () => {
    const model = () =>
      page({
        type: 'node',
        tag: 'div',
        children: [{ type: 'component', component: 'Card', props: { title: 'Hello', count: 2 } }],
      });
    const oldSrc = emit(model() as any);
    const next = model();
    ((next.root as any).children as any)[0].props.title = 'World';
    const c = classifyAstroEdit(oldSrc, emit(next as any));
    expect(c.structural).toBe(false);
    expect(c.attrsChanged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// playPatchVitePlugin — ladder decisions
// ---------------------------------------------------------------------------

const tmps: string[] = [];
afterAll(() => {
  for (const dir of tmps) rmSync(dir, { recursive: true, force: true });
});

type Ctx = { file: string; read: () => Promise<string>; server: { ws: { send: (p: unknown) => void } } };
type HotOpts = Ctx & { type: 'create' | 'update' | 'delete' };
type Plugin = {
  enforce?: string;
  configureServer: (server: { watcher: { on: (evt: string, cb: (f: string) => void) => void } }) => void;
  handleHotUpdate: (ctx: Ctx) => Promise<unknown[] | undefined>;
  hotUpdate: (this: { environment?: { name?: string } }, opts: HotOpts) => Promise<unknown[] | undefined>;
};

describe('playPatchVitePlugin', () => {
  let root: string;
  let plugin: Plugin;
  let sent: any[];

  const SRC_V1 = emit(baseModel() as any);

  const ctxFor = (file: string, source: string) => ({
    file,
    read: async () => source,
    server: { ws: { send: (p: unknown) => sent.push(p) } },
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'meno-patch-'));
    tmps.push(root);
    mkdirSync(join(root, 'src', 'pages'), { recursive: true });
    writeFileSync(join(root, 'src', 'pages', 'index.astro'), SRC_V1, 'utf8');
    sent = [];
    plugin = playPatchVitePlugin(root) as unknown as Plugin;
    plugin.configureServer({ watcher: { on: () => {} } });
  });

  test('style edit → patch event kind style with the retired tokens, HMR swallowed', async () => {
    const next = baseModel();
    ((next.root as any).style as any).base.gap = '223px';
    const result = await plugin.handleHotUpdate(ctxFor(join(root, 'src', 'pages', 'index.astro'), emit(next as any)));
    expect(result).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0].event).toBe(PLAY_PATCH_EVENT);
    expect(sent[0].data.kinds).toEqual(['style']);
    // The stale set is the OLD node's tokens (gap-224 retired, fontSize kept
    // by the untouched sibling not being part of the diff).
    const oldTokens = [...collectNodeClassTokens({ base: { gap: '224px' } }, undefined, undefined)];
    expect(sent[0].data.staleTokens).toEqual(expect.arrayContaining(oldTokens));
  });

  test('text edit → patch event kind text, no stale tokens', async () => {
    const next = baseModel();
    ((next.root as any).children as any)[0].children = 'Hello edited';
    const result = await plugin.handleHotUpdate(ctxFor(join(root, 'src', 'pages', 'index.astro'), emit(next as any)));
    expect(result).toEqual([]);
    expect(sent[0].data).toEqual({ kinds: ['text'], staleTokens: [] });
  });

  const cardPage = (title: string) =>
    page({
      type: 'node',
      tag: 'div',
      children: [{ type: 'component', component: 'Card', props: { title } }],
    });

  test('component scalar-prop edit → patch event kinds attrs+style carrying the project class vocabulary', async () => {
    const file = join(root, 'src', 'pages', 'card.astro');
    await plugin.handleHotUpdate(ctxFor(file, emit(cardPage('Hello') as any))); // seed baseline (reload once)
    sent = [];
    const result = await plugin.handleHotUpdate(ctxFor(file, emit(cardPage('World') as any)));
    expect(result).toEqual([]);
    expect(sent).toHaveLength(1);
    // A prop edit rides kind 'style' so the client's mergeClasses can retire the
    // component's variant classes; staleTokens is the whole project style()
    // vocabulary (here from the seeded index.astro — gap-224 etc.).
    expect(sent[0].data.kinds).toEqual(['attrs', 'style']);
    const projectTokens = [...collectNodeClassTokens({ base: { gap: '224px' } }, undefined, undefined)];
    expect(sent[0].data.staleTokens).toEqual(expect.arrayContaining(projectTokens));
  });

  test('component object/array-prop edit → undefined return (stock full reload)', async () => {
    const listPage = (items: string[]) =>
      page({
        type: 'node',
        tag: 'div',
        children: [{ type: 'component', component: 'List', props: { items } }],
      });
    const file = join(root, 'src', 'pages', 'list.astro');
    await plugin.handleHotUpdate(ctxFor(file, emit(listPage(['a', 'b']) as any)));
    sent = [];
    const result = await plugin.handleHotUpdate(ctxFor(file, emit(listPage(['a', 'b', 'c']) as any)));
    expect(result).toBeUndefined();
    expect(sent).toEqual([]);
  });

  // Styled single-node component (frontmatter + body) the parser understands.
  const styledComponent = (fontSize: string) =>
    emit({
      component: { structure: { type: 'node', tag: 'h1', style: { base: { fontSize } }, children: 'hi' } },
    } as any);

  test('prop-edit stale tokens are the on-disk class vocabulary; an unparseable component is skipped', async () => {
    mkdirSync(join(root, 'src', 'components'), { recursive: true });
    writeFileSync(join(root, 'src', 'components', 'Styled.astro'), styledComponent('40px'), 'utf8');
    writeFileSync(join(root, 'src', 'components', 'Broken.astro'), '<div class={style(', 'utf8'); // parse throws
    const file = join(root, 'src', 'pages', 'card.astro');
    await plugin.handleHotUpdate(ctxFor(file, emit(cardPage('Hello') as any))); // seed baseline
    sent = [];
    const result = await plugin.handleHotUpdate(ctxFor(file, emit(cardPage('World') as any)));
    expect(result).toEqual([]); // patched, NOT crashed by Broken.astro
    const styledTokens = [...collectNodeClassTokens({ base: { fontSize: '40px' } }, undefined, undefined)];
    expect(sent[0].data.staleTokens).toEqual(expect.arrayContaining(styledTokens)); // Styled's vocab present
  });

  test('class vocabulary is cached but rebuilds after a style edit changes it', async () => {
    mkdirSync(join(root, 'src', 'components'), { recursive: true });
    const compFile = join(root, 'src', 'components', 'Styled.astro');
    writeFileSync(compFile, styledComponent('40px'), 'utf8');
    const pageFile = join(root, 'src', 'pages', 'card.astro');
    await plugin.handleHotUpdate(ctxFor(compFile, styledComponent('40px'))); // seed component baseline
    await plugin.handleHotUpdate(ctxFor(pageFile, emit(cardPage('Hello') as any))); // seed page baseline
    // First prop edit builds the vocab from disk → fontSize-40 present.
    sent = [];
    await plugin.handleHotUpdate(ctxFor(pageFile, emit(cardPage('World') as any)));
    const tok40 = [...collectNodeClassTokens({ base: { fontSize: '40px' } }, undefined, undefined)];
    expect(sent[0].data.staleTokens).toEqual(expect.arrayContaining(tok40));
    // A STYLE edit to the component changes its vocabulary AND must invalidate the cache.
    writeFileSync(compFile, styledComponent('23px'), 'utf8');
    await plugin.handleHotUpdate(ctxFor(compFile, styledComponent('23px'))); // styleDiff → classVocab = null
    // Next prop edit reflects the NEW vocab (fontSize-23, not the stale fontSize-40 cache).
    sent = [];
    await plugin.handleHotUpdate(ctxFor(pageFile, emit(cardPage('Again') as any)));
    const tok23 = [...collectNodeClassTokens({ base: { fontSize: '23px' } }, undefined, undefined)];
    expect(sent[0].data.staleTokens).toEqual(expect.arrayContaining(tok23));
  });

  test('structural edit → undefined return (stock full reload), no event', async () => {
    const next = baseModel();
    ((next.root as any).children as any).push({ type: 'node', tag: 'h2', children: 'new' });
    const result = await plugin.handleHotUpdate(ctxFor(join(root, 'src', 'pages', 'index.astro'), emit(next as any)));
    expect(result).toBeUndefined();
    expect(sent).toEqual([]);
  });

  test('script-block change → reload even when the rest is a style edit', async () => {
    const next = baseModel();
    ((next.root as any).style as any).base.gap = '223px';
    const withScript = emit(next as any).replace('</BaseLayout>', '<script>boot()</script></BaseLayout>');
    const result = await plugin.handleHotUpdate(ctxFor(join(root, 'src', 'pages', 'index.astro'), withScript));
    expect(result).toBeUndefined();
    expect(sent).toEqual([]);
  });

  test('theme.css change → kind style with no stale tokens (pure sheet swap)', async () => {
    const result = await plugin.handleHotUpdate(ctxFor(join(root, 'src', 'styles', 'theme.css'), ':root { --x: 1px }'));
    expect(result).toEqual([]);
    expect(sent[0].data).toEqual({ kinds: ['style'], staleTokens: [] });
  });

  test('no baseline → reload once, then patches against the new baseline', async () => {
    const file = join(root, 'src', 'pages', 'late.astro'); // never seeded
    const first = await plugin.handleHotUpdate(ctxFor(file, SRC_V1));
    expect(first).toBeUndefined();
    const next = baseModel();
    ((next.root as any).style as any).base.gap = '223px';
    const second = await plugin.handleHotUpdate(ctxFor(file, emit(next as any)));
    expect(second).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  test('same-content write (touch) → swallowed silently, no event', async () => {
    const result = await plugin.handleHotUpdate(ctxFor(join(root, 'src', 'pages', 'index.astro'), SRC_V1));
    expect(result).toEqual([]);
    expect(sent).toEqual([]);
  });

  test('emit-only re-canonicalization (root:true added, model unchanged) → reload, not silent swallow', async () => {
    // A component's structure root carries an emit-only `{ root: true }` the parser
    // drops — but it is render-AFFECTING (instance-class merge). Two sources that
    // parse to the same model can therefore render differently, so this must reload.
    const def = {
      component: {
        interface: { x: { type: 'string', default: '' } },
        structure: { type: 'node', tag: 'div', style: { base: { gap: '8px' } }, children: 'hi' },
      },
    };
    const withRoot = emit(def as any);
    const withoutRoot = withRoot.replace(', { root: true }', '');
    // Sanity: the marker is the ONLY byte difference, and it is what the old emitter omitted.
    expect(withRoot).toContain('root: true');
    expect(withoutRoot).not.toContain('root: true');
    const file = join(root, 'src', 'components', 'C.astro');
    await plugin.handleHotUpdate(ctxFor(file, withoutRoot)); // seed baseline (no prev → undefined)
    sent = [];
    const result = await plugin.handleHotUpdate(ctxFor(file, withRoot)); // bytes differ, models equal
    expect(result).toBeUndefined(); // stock full reload — NOT [] (which would keep the stale module)
    expect(sent).toEqual([]);
  });

  test('files outside src/ are left to stock handling', async () => {
    expect(await plugin.handleHotUpdate(ctxFor(join(root, 'other', 'x.astro'), SRC_V1))).toBeUndefined();
    expect(sent).toEqual([]);
  });

  // --- Vite 6+ `hotUpdate` hook (Astro 6): per-environment [] starves astro:hmr-reload ---
  const optsFor = (file: string, source: string, type: 'update' | 'create' = 'update'): HotOpts => ({
    ...ctxFor(file, source),
    type,
  });

  test('hotUpdate (client env) → same patch + [] as handleHotUpdate', async () => {
    const next = baseModel();
    ((next.root as any).style as any).base.gap = '223px';
    const result = await plugin.hotUpdate.call(
      { environment: { name: 'client' } },
      optsFor(join(root, 'src', 'pages', 'index.astro'), emit(next as any)),
    );
    expect(result).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0].event).toBe(PLAY_PATCH_EVENT);
    expect(sent[0].data.kinds).toEqual(['style']);
  });

  test('hotUpdate → undefined (stock reload) for a structural edit', async () => {
    const added = baseModel();
    ((added.root as any).children as any).push({ type: 'node', tag: 'h2', children: 'new' });
    const result = await plugin.hotUpdate.call(
      { environment: { name: 'client' } },
      optsFor(join(root, 'src', 'pages', 'index.astro'), emit(added as any)),
    );
    expect(result).toBeUndefined();
  });

  test('a patchable edit returns [] in the server envs too (starves astro:hmr-reload), without re-broadcasting', async () => {
    const file = join(root, 'src', 'pages', 'index.astro');
    const next = baseModel();
    ((next.root as any).style as any).base.gap = '223px';
    const src = emit(next as any);
    // A server env BEFORE the client classified this edit: nothing recorded yet → let
    // the reload through (conservative — the client always runs first in real flow).
    expect(await plugin.hotUpdate.call({ environment: { name: 'ssr' } }, optsFor(file, src))).toBeUndefined();
    // Client env classifies (patchable) + broadcasts ONCE.
    sent = [];
    expect(await plugin.hotUpdate.call({ environment: { name: 'client' } }, optsFor(file, src))).toEqual([]);
    expect(sent).toHaveLength(1);
    // Now the ssr AND astro envs return [] (empty their module list → no SSR-only
    // module for astro:hmr-reload → no imperative full-reload) and never re-send.
    sent = [];
    expect(await plugin.hotUpdate.call({ environment: { name: 'ssr' } }, optsFor(file, src))).toEqual([]);
    expect(await plugin.hotUpdate.call({ environment: { name: 'astro' } }, optsFor(file, src))).toEqual([]);
    expect(sent).toEqual([]);
  });

  test('a reload-classified edit returns undefined in the server envs (the full reload proceeds)', async () => {
    const file = join(root, 'src', 'pages', 'index.astro');
    const added = baseModel();
    ((added.root as any).children as any).push({ type: 'node', tag: 'h2', children: 'new' });
    const src = emit(added as any);
    // Client classifies structural → undefined, records "not patchable".
    expect(await plugin.hotUpdate.call({ environment: { name: 'client' } }, optsFor(file, src))).toBeUndefined();
    // Server envs must NOT starve — astro:hmr-reload's full reload is the right outcome.
    expect(await plugin.hotUpdate.call({ environment: { name: 'ssr' } }, optsFor(file, src))).toBeUndefined();
    expect(await plugin.hotUpdate.call({ environment: { name: 'astro' } }, optsFor(file, src))).toBeUndefined();
  });

  test('enforce is post (sorts alongside astro:hmr-reload)', () => {
    expect(plugin.enforce).toBe('post');
  });
});

// ---------------------------------------------------------------------------
// playPatchVitePlugin — authoritative sheets payload (UtilityCssController)
// In Astro 6 dev the SSR HTML serves the utility sheet + theme.css as EMPTY
// <style> placeholders (Vite injects them client-side), so the bridge can't
// recover them from its raw-HTML re-fetch — the server ships them in the payload.
// ---------------------------------------------------------------------------

describe('playPatchVitePlugin — authoritative sheets payload', () => {
  let root: string;
  let plugin: Plugin;
  let sent: any[];
  let rebuilt: number;
  let invalidated: number;

  const UTILITY_CSS = '.g-223px{gap:223px}\n.g-224px{gap:224px}';
  // Minimal UtilityCssController stub: rebuild/current return a fixed sheet; invalidate counts.
  const controller = {
    rebuild: () => {
      rebuilt++;
      return UTILITY_CSS;
    },
    invalidate: () => {
      invalidated++;
    },
  };

  const ctxFor = (file: string, source: string) => ({
    file,
    read: async () => source,
    server: { ws: { send: (p: unknown) => sent.push(p) } },
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'meno-patch-sheets-'));
    tmps.push(root);
    mkdirSync(join(root, 'src', 'pages'), { recursive: true });
    writeFileSync(join(root, 'src', 'pages', 'index.astro'), emit(baseModel() as any), 'utf8');
    sent = [];
    rebuilt = 0;
    invalidated = 0;
    plugin = playPatchVitePlugin(root, controller) as unknown as Plugin;
    plugin.configureServer({ watcher: { on: () => {} } });
  });

  test('style edit ships the freshly rebuilt utility sheet + invalidates in-band', async () => {
    const next = baseModel();
    ((next.root as any).style as any).base.gap = '223px';
    await plugin.handleHotUpdate(ctxFor(join(root, 'src', 'pages', 'index.astro'), emit(next as any)));
    expect(sent).toHaveLength(1);
    expect(sent[0].data.kinds).toContain('style');
    expect(sent[0].data.sheets).toEqual([{ match: 'meno-utilities', css: UTILITY_CSS }]);
    expect(rebuilt).toBeGreaterThan(0);
    expect(invalidated).toBeGreaterThan(0);
  });

  test('theme.css edit ships the regenerated file as the sheet', async () => {
    const themeSrc = ':root { --brand: #f00 }';
    await plugin.handleHotUpdate(ctxFor(join(root, 'src', 'styles', 'theme.css'), themeSrc));
    expect(sent).toHaveLength(1);
    expect(sent[0].data.kinds).toEqual(['style']);
    expect(sent[0].data.sheets).toEqual([{ match: 'styles/theme.css', css: themeSrc }]);
  });

  test('a reload-classified .astro edit still rebuilds + invalidates (reload fallback stays fresh)', async () => {
    const withScript = emit(baseModel() as any) + '\n<script>console.log(1)</script>';
    const result = await plugin.handleHotUpdate(ctxFor(join(root, 'src', 'pages', 'index.astro'), withScript));
    expect(result).toBeUndefined(); // reload
    expect(sent).toEqual([]); // no patch event
    expect(rebuilt).toBeGreaterThan(0);
    expect(invalidated).toBeGreaterThan(0);
  });

  test('without a controller the payload carries no sheets (back-compat)', async () => {
    const noCtl = playPatchVitePlugin(root) as unknown as Plugin;
    noCtl.configureServer({ watcher: { on: () => {} } });
    const next = baseModel();
    ((next.root as any).style as any).base.gap = '221px';
    await noCtl.handleHotUpdate(ctxFor(join(root, 'src', 'pages', 'index.astro'), emit(next as any)));
    expect(sent[0].data.sheets).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PATCH_JS — the restricted client patch against happy-dom
// ---------------------------------------------------------------------------

describe('PATCH_JS (client patch)', () => {
  let win: Window;
  let doc: Document;
  let applyPatch: (
    next: Document,
    kinds: string[],
    staleTokens: string[],
    sheets?: Array<{ match: string; css: string }>,
  ) => void;

  const parse = (html: string): Document =>
    new win.DOMParser().parseFromString(html, 'text/html') as unknown as Document;

  const setup = (bodyHtml: string, headHtml = '') => {
    win = new Window();
    (win as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
    doc = win.document as unknown as Document;
    doc.head.innerHTML = headHtml;
    doc.body.innerHTML = bodyHtml;
    // Inject the X-Ray resolver ahead of PATCH_JS exactly as PLAY_PATCH_BRIDGE_SCRIPT
    // does in production — pairKey resolves identity via identify(), which lives in
    // the resolver. (Evaluating PATCH_JS alone would silently take pairKey's raw-attr
    // fallback and never exercise the real chain-aware pairing.)
    const fns = new Function('document', `${XRAY_RESOLVER_JS}\n${PATCH_JS}\nreturn { applyPatch: applyPatch };`)(
      doc,
    ) as {
      applyPatch: typeof applyPatch;
    };
    applyPatch = fns.applyPatch;
  };

  test('sheet swap: keyed style tags update text; new sheets append; DOM untouched', () => {
    setup(
      '<div data-element-path="0" class="gap-224">x</div>',
      '<style data-vite-dev-id="util.css">.gap-224{gap:224px}</style>',
    );
    const liveDiv = doc.querySelector('div')!;
    applyPatch(
      parse(
        '<html><head><style data-vite-dev-id="util.css">.gap-223{gap:223px}</style>' +
          '<style data-vite-dev-id="extra.css">.x{}</style></head>' +
          '<body><div data-element-path="0" class="gap-223">x</div></body></html>',
      ),
      ['style'],
      ['gap-224'],
    );
    expect(doc.querySelector('style[data-vite-dev-id="util.css"]')!.textContent).toBe('.gap-223{gap:223px}');
    expect(doc.querySelector('style[data-vite-dev-id="extra.css"]')).not.toBeNull();
    expect(doc.querySelector('div')).toBe(liveDiv); // node untouched
    expect(liveDiv.getAttribute('class')).toBe('gap-223');
  });

  test('an EMPTY fetched sheet never wipes a populated live sheet (Astro 6 client-injected CSS)', () => {
    // In Astro 6 dev the SSR HTML serves Vite-processed sheets EMPTY (Vite injects
    // them client-side), so the re-fetched doc's utility <style> is empty. The old
    // syncSheets copied that empty text over the live sheet → wiped all utility CSS.
    setup(
      '<div data-element-path="0" class="g-224px">x</div>',
      '<style data-vite-dev-id="/@id/__x00__virtual:meno-utilities.css">.g-224px{gap:224px}</style>',
    );
    applyPatch(
      parse(
        '<html><head><style data-vite-dev-id="/@id/__x00__virtual:meno-utilities.css"></style></head>' +
          '<body><div data-element-path="0" class="g-223px">x</div></body></html>',
      ),
      ['style'],
      ['g-224px'],
    );
    // The live sheet is preserved (not wiped to empty).
    expect(doc.querySelector('style[data-vite-dev-id*="meno-utilities"]')!.textContent).toBe('.g-224px{gap:224px}');
  });

  test('payload sheet overrides the empty fetched utility sheet (the snap-back fix)', () => {
    setup(
      '<div data-element-path="0" class="g-224px">x</div>',
      '<style data-vite-dev-id="/@id/__x00__virtual:meno-utilities.css">.g-224px{gap:224px}</style>',
    );
    applyPatch(
      parse(
        '<html><head><style data-vite-dev-id="/@id/__x00__virtual:meno-utilities.css"></style></head>' +
          '<body><div data-element-path="0" class="g-223px">x</div></body></html>',
      ),
      ['style'],
      ['g-224px'],
      [{ match: 'meno-utilities', css: '.g-223px{gap:223px}\n.g-224px{gap:224px}' }],
    );
    const sheet = doc.querySelector('style[data-vite-dev-id*="meno-utilities"]')!;
    expect(sheet.textContent).toContain('.g-223px{gap:223px}'); // authoritative new rule arrived
    // element switched to the new class, which the payload sheet defines → no snap-back
    expect(doc.querySelector('div')!.getAttribute('class')).toBe('g-223px');
  });

  test('payload sheet is created when no matching live tag exists', () => {
    setup('<div data-element-path="0" class="g-223px">x</div>', '');
    applyPatch(
      parse('<html><body><div data-element-path="0" class="g-223px">x</div></body></html>'),
      ['style'],
      [],
      [{ match: 'meno-utilities', css: '.g-223px{gap:223px}' }],
    );
    const sheet = doc.querySelector('style[data-vite-dev-id*="meno-utilities"]');
    expect(sheet).not.toBeNull();
    expect(sheet!.textContent).toBe('.g-223px{gap:223px}');
  });

  test('class merge keeps JS-added tokens and retires only stale ones', () => {
    setup('<section data-element-path="0,1" class="gap-224 p-10 embla--active">s</section>');
    const el = doc.querySelector('section')!;
    applyPatch(
      parse('<html><body><section data-element-path="0,1" class="gap-223 p-10">s</section></body></html>'),
      ['style'],
      ['gap-224'],
    );
    const cls = el.getAttribute('class')!.split(' ');
    expect(cls).toContain('gap-223'); // new utility arrived
    expect(cls).toContain('p-10'); // untouched utility kept
    expect(cls).toContain('embla--active'); // JS-added token survives
    expect(cls).not.toContain('gap-224'); // retired
  });

  test('inline style is property-granular: fade.js reveal state survives', () => {
    setup('<div data-element-path="0" fade="0.2">x</div>');
    const el = doc.querySelector('div')! as HTMLElement;
    // fade.js revealed the element at runtime.
    el.setAttribute('style', 'transition: opacity 0.6s ease 0.2s; opacity: 1; transform: none');
    applyPatch(
      parse('<html><body><div data-element-path="0" fade="0.2" style="--gap: 12px">x</div></body></html>'),
      ['style'],
      [],
    );
    const style = el.getAttribute('style')!;
    expect(style).toContain('opacity: 1'); // JS reveal kept
    expect(style).toContain('--gap: 12px'); // server-rendered property applied
  });

  test('text sync patches paired text nodes; skips when counts mismatch', () => {
    setup('<p data-element-path="0,0">Hello world</p><p data-element-path="0,1">stays</p>');
    const p0 = doc.querySelectorAll('p')[0]!;
    // JS inserted an extra element child into p1 — its text counts mismatch.
    const p1 = doc.querySelectorAll('p')[1]!;
    p1.appendChild(doc.createElement('span'));
    p1.appendChild(doc.createTextNode('js-added'));
    applyPatch(
      parse(
        '<html><body><p data-element-path="0,0">Hello edited</p><p data-element-path="0,1">changed</p></body></html>',
      ),
      ['text'],
      [],
    );
    expect(p0.textContent).toBe('Hello edited');
    expect(p1.textContent).toContain('js-added'); // mismatch → safely skipped
  });

  test('instance-chain identity disambiguates same file-local paths; extras are skipped', () => {
    setup(
      '<div data-element-path="0" data-meno-instance="0,0" class="a">first</div>' +
        '<div data-element-path="0" data-meno-instance="0,1" class="a">second</div>',
    );
    const [first, second] = [...doc.querySelectorAll('div')] as HTMLElement[];
    applyPatch(
      parse(
        '<html><body>' +
          '<div data-element-path="0" data-meno-instance="0,0" class="b">first</div>' +
          '<div data-element-path="0" data-meno-instance="0,1" class="c">second</div>' +
          '</body></html>',
      ),
      ['style'],
      ['a'],
    );
    expect(first!.getAttribute('class')).toBe('b');
    expect(second!.getAttribute('class')).toBe('c');
  });

  test('cross-instance isolation: a JS clone in one component never absorbs another component prop edit', () => {
    // The collapsed-tile bug. Two section instances each render a deep child at the
    // SAME file-local path "0,0" — deep component-internal elements carry no instance
    // attr of their own, so a bare path|instance|slot key collides across them.
    // Instance A's component JS-cloned its card, so that shared bare bucket holds
    // [A-card, A-clone, B-pill] live vs [A-card, B-pill] fetched. Occurrence-order
    // pairing on the bare key pairs B's fetched pill against A's live clone and, with
    // a variant-prop edit's whole-project stale set, strips the clone down to B's
    // classes. Chain-aware pairing (identify) puts A's "0,0" and B's "0,0" in separate
    // buckets, so a drift inside A can never mispair B's elements — or vice versa.
    setup(
      // Instance A (data-meno-instance="0,0"): a card + its JS-cloned twin.
      '<section data-element-path="0" data-meno-instance="0,0">' +
        '<div data-element-path="0,0" class="card keep-a">A card</div>' +
        '<div data-element-path="0,0" class="card keep-a">A card clone</div>' +
        '</section>' +
        // Instance B (data-meno-instance="0,1"): the edited CTA pill.
        '<section data-element-path="0" data-meno-instance="0,1">' +
        '<div data-element-path="0,0" class="grid pad keep-b">B pill</div>' +
        '</section>',
    );
    const [aCard, aClone] = [...doc.querySelectorAll('section[data-meno-instance="0,0"] div')] as HTMLElement[];
    const bPill = doc.querySelector('section[data-meno-instance="0,1"] div')! as HTMLElement;
    // Fresh render after B's variant-prop edit: A unchanged (no clone — SSR), B re-rendered.
    applyPatch(
      parse(
        '<html><body>' +
          '<section data-element-path="0" data-meno-instance="0,0">' +
          '<div data-element-path="0,0" class="card keep-a">A card</div>' +
          '</section>' +
          '<section data-element-path="0" data-meno-instance="0,1">' +
          '<div data-element-path="0,0" class="grid pad keep-b">B pill</div>' +
          '</section>' +
          '</body></html>',
      ),
      ['attrs', 'style'],
      ['card', 'keep-a', 'grid', 'pad', 'keep-b'], // the project class vocabulary
    );
    expect(aCard.getAttribute('class')).toBe('card keep-a'); // paired within A — kept
    expect(aClone.getAttribute('class')).toBe('card keep-a'); // bare-key pairing → "grid pad keep-b"
    expect(bPill.getAttribute('class')).toBe('grid pad keep-b'); // B's edit applied, isolated to B
  });

  test('no inserts, no removals: structure-divergent live extras are left alone', () => {
    setup('<div data-element-path="0" class="x">x</div><aside id="js-overlay">runtime</aside>');
    applyPatch(parse('<html><body><div data-element-path="0" class="y">x</div></body></html>'), ['style'], ['x']);
    expect(doc.getElementById('js-overlay')).not.toBeNull(); // never removed
    expect(doc.querySelector('div')!.getAttribute('class')).toBe('y');
  });

  test('attrs sync updates server-rendered attributes, text, inline style; skips control/identity attrs', () => {
    // Same tag + same class on both sides → a pure text/attr prop edit → patch.
    setup(
      '<img data-element-path="0,0" data-meno-instance="0,0" class="c" src="old.jpg" alt="old" style="opacity: 1">',
    );
    const img = doc.querySelector('img')! as HTMLElement;
    img.setAttribute('data-js', 'runtime'); // a live-only attribute JS added
    applyPatch(
      parse(
        '<html><body>' +
          '<img data-element-path="0,0" data-meno-instance="0,0" class="c" src="new.jpg" alt="new" loading="lazy" style="max-width: 50%">' +
          '</body></html>',
      ),
      ['attrs'],
      [],
    );
    expect(img.getAttribute('src')).toBe('new.jpg'); // updated
    expect(img.getAttribute('alt')).toBe('new'); // updated
    expect(img.getAttribute('loading')).toBe('lazy'); // added
    expect(img.getAttribute('class')).toBe('c'); // unchanged class → patched, not reloaded
    expect(img.getAttribute('style')).toContain('max-width: 50%'); // server inline style applied
    expect(img.getAttribute('style')).toContain('opacity: 1'); // live-only inline prop kept
    expect(img.getAttribute('data-meno-instance')).toBe('0,0'); // identity preserved
    expect(img.getAttribute('data-js')).toBe('runtime'); // live-only attr never removed
  });

  test('variant prop patches the class in place via stale tokens (no reload)', () => {
    // A variant prop (align) drives a utility class; the prop edit rides kind
    // 'style' with the project vocabulary as stale tokens, so mergeClasses
    // retires the old class (ta-left) and adds the fresh one — no reload.
    setup('<h1 data-element-path="0,0" class="ta-left fs-67px">Title</h1>');
    const h1 = doc.querySelector('h1')!;
    applyPatch(
      parse('<html><body><h1 data-element-path="0,0" class="ta-center fs-67px">Title</h1></body></html>'),
      ['attrs', 'style'],
      ['ta-left', 'ta-center', 'ta-right'], // the align mapping's full vocabulary
    );
    const cls = h1.getAttribute('class')!.split(' ');
    expect(cls).toContain('ta-center'); // new variant class applied
    expect(cls).toContain('fs-67px'); // untouched class kept
    expect(cls).not.toContain('ta-left'); // old variant class retired
  });

  test('variant prop that changes the tag (size → h1↔h2) patches the class, accepts the stale tag', () => {
    // size drives BOTH the heading tag and the font-size class. We patch the
    // class (the visual) and accept the semantically-stale tag — not structural,
    // so no reload; the tag self-heals on the next reload.
    setup('<h1 data-element-path="0,0" class="fs-67px">Title</h1>');
    const live = doc.querySelector('[data-element-path="0,0"]')! as HTMLElement;
    applyPatch(
      parse('<html><body><h2 data-element-path="0,0" class="fs-56px">Title</h2></body></html>'),
      ['attrs', 'style'],
      ['fs-67px', 'fs-56px'], // the size mapping's font-size vocabulary
    );
    expect(live.getAttribute('class')).toBe('fs-56px'); // class updated → visually h2
    expect(live.tagName.toLowerCase()).toBe('h1'); // tag stays (accepted stale)
  });

  test('attrs kind also syncs text (a scalar prop rendered as a text child)', () => {
    setup('<span data-element-path="0,0">old</span>');
    applyPatch(parse('<html><body><span data-element-path="0,0">new</span></body></html>'), ['attrs'], []);
    expect(doc.querySelector('span')!.textContent).toBe('new');
  });

  test('attrs sync does not stomp form value/checked (user/IDL state)', () => {
    setup('<input data-element-path="0,0" value="default">');
    const input = doc.querySelector('input')! as HTMLElement;
    applyPatch(
      parse('<html><body><input data-element-path="0,0" value="server" checked></body></html>'),
      ['attrs'],
      [],
    );
    expect(input.getAttribute('value')).toBe('default'); // value attr left to reload
    expect(input.hasAttribute('checked')).toBe(false); // checked left to reload
  });

  test('structureDiverged: a prop that grows the server-rendered set throws → bridge reloads', () => {
    // Live has one stamped list item; the fresh render has two (a scalar prop
    // drove a list the model diff could not see) → fetchedCount > liveCount.
    setup('<li data-element-path="0,0">a</li>');
    expect(() =>
      applyPatch(
        parse('<html><body><li data-element-path="0,0">a</li><li data-element-path="0,0">b</li></body></html>'),
        ['attrs'],
        [],
      ),
    ).toThrow();
  });

  test('structureDiverged: a prop that flips a conditional (new identity) throws → reload', () => {
    setup('<div data-element-path="0,0">stays</div>');
    expect(() =>
      applyPatch(
        parse(
          '<html><body><div data-element-path="0,0">stays</div><div data-element-path="0,1">appeared</div></body></html>',
        ),
        ['attrs'],
        [],
      ),
    ).toThrow();
  });

  test('structureDiverged tolerates JS clones (live count > fetched) — patches, never reloads', () => {
    // embla cloned the live slide (two live, one server-rendered) — liveCount >
    // fetchedCount is the tolerated direction; the patch must apply, not throw.
    setup('<div data-element-path="0,0" src="old">a</div>' + '<div data-element-path="0,0" src="old">a-clone</div>');
    const [real, clone] = [...doc.querySelectorAll('div')] as HTMLElement[];
    expect(() =>
      applyPatch(parse('<html><body><div data-element-path="0,0" src="new">a</div></body></html>'), ['attrs'], []),
    ).not.toThrow();
    expect(real!.getAttribute('src')).toBe('new'); // first occurrence patched
    expect(clone!.getAttribute('src')).toBe('old'); // unpaired clone left as-is
  });

  // --- kind 'html': rich-text (set:html) innerHTML re-sync ---

  test('html kind replaces a rich-text leaf innerHTML (text + nested markup)', () => {
    // Heading renders <h1 ...>text <span class=custom-span>x</span> text</h1>;
    // the span is raw set:html, never a stamped meno node.
    setup('<h1 data-element-path="0,0">Build a <span class="hl">great</span> site</h1>');
    applyPatch(
      parse('<html><body><h1 data-element-path="0,0">Build a <span class="hl">better</span> site</h1></body></html>'),
      ['html'],
      [],
    );
    expect(doc.querySelector('h1')!.innerHTML).toBe('Build a <span class="hl">better</span> site');
  });

  test('html kind never innerHTML-replaces an element with a stamped descendant (preserves node identity + JS state)', () => {
    // A component ROOT whose subtree has its own stamped node: an innerHTML replace
    // would destroy/recreate that node (breaking pairing + wiping JS state), so
    // syncHtml must skip the parent. The skipped parent's own text edit (prefix →
    // PREFIX) is left to reload — the accepted tradeoff that keeps the child safe.
    setup('<section data-element-path="0,0">prefix <div data-element-path="0,0,0">slide</div></section>');
    const liveChild = doc.querySelector('[data-element-path="0,0,0"]')! as unknown as { __jsState?: string };
    liveChild.__jsState = 'kept';
    applyPatch(
      parse(
        '<html><body><section data-element-path="0,0">PREFIX <div data-element-path="0,0,0">slide</div></section></body></html>',
      ),
      ['html'],
      [],
    );
    const afterChild = doc.querySelector('[data-element-path="0,0,0"]')! as unknown as { __jsState?: string };
    expect(afterChild).toBe(liveChild); // same node — section was NOT innerHTML-replaced
    expect(afterChild.__jsState).toBe('kept'); // JS state survived
  });

  test('html kind skips a pure-text leaf (no element children) — JS-managed text not clobbered', () => {
    // A counter the page JS animates: no element children → left to syncText, so a
    // rich-text edit elsewhere can never reset it via innerHTML.
    setup('<div data-element-path="0,0">456</div>');
    applyPatch(parse('<html><body><div data-element-path="0,0">123</div></body></html>'), ['html'], []);
    expect(doc.querySelector('div')!.innerHTML).toBe('456'); // untouched
  });

  test('html kind is gated by structureDiverged (a flipped conditional → reload)', () => {
    setup('<h1 data-element-path="0,0">hi <b>x</b></h1>');
    expect(() =>
      applyPatch(
        parse(
          '<html><body><h1 data-element-path="0,0">hi <b>x</b></h1><div data-element-path="0,1">appeared</div></body></html>',
        ),
        ['html'],
        [],
      ),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// PATCH_JS optimistic style preview — resolveTarget + apply + snapshot/restore
// ---------------------------------------------------------------------------

describe('PATCH_JS optimistic style preview', () => {
  let win: Window;
  let doc: Document;
  let applyPatch: (next: Document, kinds: string[], staleTokens: string[]) => void;
  let applyOptimistic: (
    target: { chain: string[]; path: string; item: string; isComponent: boolean },
    css: string,
    media?: string,
  ) => void;
  let getOptimistic: () => Array<{ el: Element; original: string | null }>;

  const parse = (html: string): Document =>
    new win.DOMParser().parseFromString(html, 'text/html') as unknown as Document;

  const setup = (bodyHtml: string, headHtml = '') => {
    win = new Window();
    (win as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
    doc = win.document as unknown as Document;
    doc.head.innerHTML = headHtml;
    doc.body.innerHTML = bodyHtml;
    // resolveTarget lives in XRAY_RESOLVER_JS — the bridge embeds it alongside
    // PATCH_JS, so the test evaluates both in one scope (same as production).
    const fns = new Function(
      'document',
      `${XRAY_RESOLVER_JS}\n${PATCH_JS}\nreturn { applyPatch: applyPatch, applyOptimistic: applyOptimistic, getOptimistic: function () { return optimistic; } };`,
    )(doc) as {
      applyPatch: typeof applyPatch;
      applyOptimistic: typeof applyOptimistic;
      getOptimistic: typeof getOptimistic;
    };
    applyPatch = fns.applyPatch;
    applyOptimistic = fns.applyOptimistic;
    getOptimistic = fns.getOptimistic;
  };

  // A plain root element (no instance chain) — resolveTarget's simplest case.
  const TARGET = { chain: [] as string[], path: '0', item: '', isComponent: false };

  test('applies the declaration inline and snapshots the original (null) style', () => {
    setup('<div data-element-path="0" class="bg-old">x</div>');
    const el = doc.querySelector('div')! as HTMLElement;
    applyOptimistic(TARGET, 'background-color: var(--primary)');
    expect(el.getAttribute('style')).toContain('background-color: var(--primary)');
    const reg = getOptimistic();
    expect(reg).toHaveLength(1);
    expect(reg[0]!.original).toBeNull(); // element had no style attr to begin with
  });

  test('unresolvable target is a no-op (no throw, registry stays empty)', () => {
    setup('<div data-element-path="0">x</div>');
    expect(() => applyOptimistic({ chain: [], path: '9', item: '', isComponent: false }, 'color: red')).not.toThrow();
    expect(getOptimistic()).toHaveLength(0);
  });

  test('empty css is a no-op (bound/_mapping value yields no preview)', () => {
    setup('<div data-element-path="0">x</div>');
    applyOptimistic(TARGET, '');
    expect(getOptimistic()).toHaveLength(0);
  });

  test('repeated edits to the same element keep the FIRST snapshot, apply the latest value', () => {
    setup('<div data-element-path="0" style="margin: 4px">x</div>');
    const el = doc.querySelector('div')! as HTMLElement;
    applyOptimistic(TARGET, 'padding: 10px');
    applyOptimistic(TARGET, 'padding: 20px');
    const reg = getOptimistic();
    expect(reg).toHaveLength(1);
    expect(reg[0]!.original).toBe('margin: 4px'); // snapshot taken once, on first touch
    expect(el.style.getPropertyValue('padding')).toBe('20px'); // latest decl applied
  });

  test('applyPatch clears the optimistic inline (null original → removeAttribute) so the class wins', () => {
    setup('<div data-element-path="0" class="bg-old">x</div>');
    const el = doc.querySelector('div')! as HTMLElement;
    applyOptimistic(TARGET, 'background-color: red');
    expect(el.getAttribute('style')).toContain('background-color: red');
    // Real patch: utility class swaps bg-old → bg-new, no server inline style.
    applyPatch(
      parse('<html><body><div data-element-path="0" class="bg-new">x</div></body></html>'),
      ['style'],
      ['bg-old'],
    );
    expect(el.getAttribute('style')).toBeNull(); // optimistic inline removed
    expect(el.getAttribute('class')).toBe('bg-new'); // canonical class-based styling wins
    expect(getOptimistic()).toHaveLength(0); // registry cleared
  });

  test('applyPatch restores a non-empty snapshot, then server inline (define:vars) re-applies on top', () => {
    setup('<div data-element-path="0" style="--gap: 4px" class="c">x</div>');
    const el = doc.querySelector('div')! as HTMLElement;
    applyOptimistic(TARGET, 'padding: 99px');
    expect(el.style.getPropertyValue('padding')).toBe('99px');
    // Server re-renders --gap: 8px inline (define:vars) and keeps class c.
    applyPatch(
      parse('<html><body><div data-element-path="0" style="--gap: 8px" class="c">x</div></body></html>'),
      ['style'],
      [],
    );
    const style = el.getAttribute('style')!;
    expect(style).not.toContain('padding'); // optimistic padding gone (restored to snapshot)
    expect(style).toContain('--gap: 8px'); // server inline re-applied by mergeInlineStyle
  });

  // matchMedia gate: each design frame iframe is sized to its breakpoint, so the
  // inline preview must only apply where the frame's viewport matches the edited
  // breakpoint (otherwise a base edit bleeds into the tablet/mobile frames).
  const stubMatchMedia = (matches: boolean) => {
    (doc.defaultView as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = (q) => ({
      matches,
      media: q,
    });
  };

  test('media gate: skips when the frame viewport does not match the breakpoint', () => {
    setup('<div data-element-path="0" class="bg-old">x</div>');
    const el = doc.querySelector('div')! as HTMLElement;
    stubMatchMedia(false); // e.g. a base edit (min-width:1025px) in a 768px tablet frame
    applyOptimistic(TARGET, 'color: red', '(min-width: 1025px)');
    expect(getOptimistic()).toHaveLength(0); // not applied
    expect(el.getAttribute('style')).toBeNull();
  });

  test('media gate: applies when the frame viewport matches the breakpoint', () => {
    setup('<div data-element-path="0" class="bg-old">x</div>');
    const el = doc.querySelector('div')! as HTMLElement;
    stubMatchMedia(true); // the matching frame
    applyOptimistic(TARGET, 'color: red', '(min-width: 1025px)');
    expect(el.getAttribute('style')).toContain('color: red');
    expect(getOptimistic()).toHaveLength(1);
  });

  test('empty media applies unconditionally (single-frame / no breakpoints)', () => {
    setup('<div data-element-path="0" class="bg-old">x</div>');
    const el = doc.querySelector('div')! as HTMLElement;
    stubMatchMedia(false); // even if matchMedia would say no, empty media bypasses the gate
    applyOptimistic(TARGET, 'color: red', '');
    expect(el.getAttribute('style')).toContain('color: red');
  });
});

// ---------------------------------------------------------------------------
// PATCH_JS optimistic CSS-variable preview — global :root override + clear
// ---------------------------------------------------------------------------

describe('PATCH_JS optimistic variable preview', () => {
  let win: Window;
  let doc: Document;
  let applyPatch: (next: Document, kinds: string[], staleTokens: string[]) => void;
  let applyVarsPreview: (vars: Record<string, string>, media: string) => void;

  const parse = (html: string): Document =>
    new win.DOMParser().parseFromString(html, 'text/html') as unknown as Document;

  const tag = () => doc.getElementById('meno-vars-preview');

  const setup = (bodyHtml = '<div data-element-path="0">x</div>', headHtml = '') => {
    win = new Window();
    (win as unknown as { SyntaxError: typeof SyntaxError }).SyntaxError = SyntaxError;
    doc = win.document as unknown as Document;
    doc.head.innerHTML = headHtml;
    doc.body.innerHTML = bodyHtml;
    const fns = new Function(
      'document',
      `${XRAY_RESOLVER_JS}\n${PATCH_JS}\nreturn { applyPatch: applyPatch, applyVarsPreview: applyVarsPreview };`,
    )(doc) as { applyPatch: typeof applyPatch; applyVarsPreview: typeof applyVarsPreview };
    applyPatch = fns.applyPatch;
    applyVarsPreview = fns.applyVarsPreview;
  };

  test('applies a single :root override style tag (base, no media)', () => {
    setup();
    applyVarsPreview({ '--primary': '#ff0000' }, '');
    expect(tag()!.textContent).toContain(':root { --primary: #ff0000; }');
    expect(tag()!.textContent).not.toContain('@media');
  });

  test('wraps non-base token edits in @media', () => {
    setup();
    applyVarsPreview({ '--h1-fs': '40px' }, '(max-width: 1024px)');
    expect(tag()!.textContent).toBe('@media (max-width: 1024px) { :root { --h1-fs: 40px; } } ');
  });

  test('merges successive edits into one :root block (edit-all-at-once)', () => {
    setup();
    applyVarsPreview({ '--primary': '#f00' }, '');
    applyVarsPreview({ '--gap': '24px' }, '');
    const css = tag()!.textContent!;
    expect(css).toContain('--primary: #f00;');
    expect(css).toContain('--gap: 24px;');
    // Same var re-set keeps the latest value, no duplicate.
    applyVarsPreview({ '--primary': '#0f0' }, '');
    expect(tag()!.textContent).toContain('--primary: #0f0;');
    expect(tag()!.textContent).not.toContain('#f00');
  });

  test('sanitizes malformed names and CSS-breakout values', () => {
    setup();
    applyVarsPreview({ '--ok': 'red', 'bad name': 'red', '--evil': 'red; } body { x: 1' }, '');
    const css = tag()!.textContent!;
    expect(css).toContain('--ok: red;');
    expect(css).not.toContain('bad name');
    expect(css).not.toContain('--evil');
  });

  test('applyPatch removes the override so the regenerated theme.css wins', () => {
    setup('<div data-element-path="0">x</div>', '<style data-vite-dev-id="theme.css">:root{--primary:#111}</style>');
    applyVarsPreview({ '--primary': '#ff0000' }, '');
    expect(tag()).not.toBeNull();
    // The real patch (theme.css regenerated) lands as a kind:'style' sheet swap.
    applyPatch(
      parse(
        '<html><head><style data-vite-dev-id="theme.css">:root{--primary:#222}</style></head>' +
          '<body><div data-element-path="0">x</div></body></html>',
      ),
      ['style'],
      [],
    );
    expect(tag()).toBeNull(); // optimistic override cleared
    expect(doc.querySelector('style[data-vite-dev-id="theme.css"]')!.textContent).toBe(':root{--primary:#222}');
  });
});

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

describe('bridge contract', () => {
  test('script gate helper and event name are stable', () => {
    expect(PLAY_PATCH_EVENT).toBe('meno:astro:patch');
    expect(PLAY_STYLE_PREVIEW_EVENT).toBe('meno:astro:style-preview');
    expect(PLAY_VARS_PREVIEW_EVENT).toBe('meno:astro:vars-preview');
    expect(extractScriptBlocks('<div>x</div><script>a()</script>')).toBe('<script>a()</script>');
  });

  test('bridge rides vite client hot context with reload fallback, iframe-only', () => {
    expect(PLAY_PATCH_BRIDGE_SCRIPT).toContain(`'${PLAY_PATCH_EVENT}'`);
    expect(PLAY_PATCH_BRIDGE_SCRIPT).toContain("import('/@vite/client')");
    expect(PLAY_PATCH_BRIDGE_SCRIPT).toContain('createHotContext');
    expect(PLAY_PATCH_BRIDGE_SCRIPT).toContain('location.reload');
    expect(PLAY_PATCH_BRIDGE_SCRIPT).toContain('window.self !== window.top');
  });

  test('bridge embeds the X-Ray resolver and listens for optimistic style previews', () => {
    expect(PLAY_PATCH_BRIDGE_SCRIPT).toContain(`'${PLAY_STYLE_PREVIEW_EVENT}'`);
    expect(PLAY_PATCH_BRIDGE_SCRIPT).toContain('resolveTarget'); // from XRAY_RESOLVER_JS
    expect(PLAY_PATCH_BRIDGE_SCRIPT).toContain('applyOptimistic');
    expect(PLAY_PATCH_BRIDGE_SCRIPT).toContain("addEventListener('message'");
  });

  test('bridge listens for optimistic variable previews', () => {
    expect(PLAY_PATCH_BRIDGE_SCRIPT).toContain(`'${PLAY_VARS_PREVIEW_EVENT}'`);
    expect(PLAY_PATCH_BRIDGE_SCRIPT).toContain('applyVarsPreview');
    expect(PLAY_PATCH_BRIDGE_SCRIPT).toContain('meno-vars-preview');
  });
});
