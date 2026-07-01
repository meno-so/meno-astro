import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSitemapMeta } from './loadSitemapMeta';

const tmps: string[] = [];

/** A scratch project with the given i18n config + `src/pages/<name>.astro` files (frontmatter meta). */
function project(i18n: unknown, pages: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'load-sitemap-'));
  tmps.push(dir);
  writeFileSync(join(dir, 'project.config.json'), JSON.stringify({ i18n }), 'utf8');
  const pagesDir = join(dir, 'src', 'pages');
  for (const [name, meta] of Object.entries(pages)) {
    const file = join(pagesDir, `${name}.astro`);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, `---\nconst meta = ${JSON.stringify(meta)};\n---\n<div></div>\n`, 'utf8');
  }
  return dir;
}

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

const EN_PL = { defaultLocale: 'en', locales: [{ code: 'en' }, { code: 'pl' }] };
const EN_ONLY = { defaultLocale: 'en', locales: [{ code: 'en' }] };

describe('loadSitemapMeta', () => {
  test('single-locale: keys by route path; index → "" ; pages without meta absent', () => {
    const map = loadSitemapMeta(
      project(EN_ONLY, {
        index: { sitemap: { priority: 1, changefreq: 'daily' } },
        about: { sitemap: { exclude: true } },
        plain: { title: 'Plain' }, // no sitemap meta
      }),
    );
    expect(map.get('')).toEqual({ priority: 1, changefreq: 'daily' });
    expect(map.get('about')).toEqual({ exclude: true });
    expect(map.has('plain')).toBe(false);
  });

  test('multi-locale: enumerates the localized route paths (translated slug + prefix-swap fallback)', () => {
    const map = loadSitemapMeta(
      project(EN_PL, {
        index: { sitemap: { priority: 0.9 } },
        about: { sitemap: { exclude: true }, slugs: { en: 'about', pl: 'o-nas' } },
        contact: { sitemap: { changefreq: 'monthly' } }, // no slugs → prefix-swap
      }),
    );
    // index → '' and 'pl'
    expect(map.get('')).toEqual({ priority: 0.9 });
    expect(map.get('pl')).toEqual({ priority: 0.9 });
    // about → 'about' and the translated 'pl/o-nas'
    expect(map.get('about')).toEqual({ exclude: true });
    expect(map.get('pl/o-nas')).toEqual({ exclude: true });
    // contact (no slugs) → 'contact' and prefix-swapped 'pl/contact'
    expect(map.get('contact')).toEqual({ changefreq: 'monthly' });
    expect(map.get('pl/contact')).toEqual({ changefreq: 'monthly' });
  });

  test('invalid values are dropped (out-of-range priority, unknown changefreq, exclude:false)', () => {
    const map = loadSitemapMeta(
      project(EN_ONLY, {
        a: { sitemap: { priority: 5, changefreq: 'often', exclude: false } }, // all invalid/no-op
        b: { sitemap: { priority: 0.5, changefreq: 'weekly' } },
      }),
    );
    expect(map.has('a')).toBe(false); // nothing valid → no entry
    expect(map.get('b')).toEqual({ priority: 0.5, changefreq: 'weekly' });
  });

  test('no pages dir → empty map (never throws)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-sitemap-empty-'));
    tmps.push(dir);
    writeFileSync(join(dir, 'project.config.json'), JSON.stringify({ i18n: EN_ONLY }), 'utf8');
    expect(loadSitemapMeta(dir).size).toBe(0);
  });
});
