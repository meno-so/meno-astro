import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadI18nConfig } from './loadI18nConfig';
import { DEFAULT_I18N_CONFIG } from 'meno-core/shared';

const tmps: string[] = [];
function projectWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'load-i18n-'));
  tmps.push(dir);
  if (config !== undefined) {
    writeFileSync(join(dir, 'project.config.json'), JSON.stringify(config), 'utf8');
  }
  return dir;
}

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe('loadI18nConfig', () => {
  test('reads a valid modern i18n config', () => {
    const root = projectWith({
      i18n: {
        defaultLocale: 'en',
        locales: [
          { code: 'en', name: 'English', nativeName: 'English', langTag: 'en-US' },
          { code: 'pl', name: 'Polish', nativeName: 'Polski', langTag: 'pl-PL' },
        ],
      },
    });
    const cfg = loadI18nConfig(root);
    expect(cfg.defaultLocale).toBe('en');
    expect(cfg.locales.map((l) => l.code)).toEqual(['en', 'pl']);
    expect(cfg.locales[1].nativeName).toBe('Polski');
  });

  test('missing project.config.json -> DEFAULT_I18N_CONFIG', () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-i18n-empty-'));
    tmps.push(dir);
    expect(loadI18nConfig(dir)).toEqual(DEFAULT_I18N_CONFIG);
  });

  test('config present but no .i18n key -> DEFAULT_I18N_CONFIG', () => {
    const root = projectWith({ siteUrl: 'https://x', breakpoints: {} });
    expect(loadI18nConfig(root)).toEqual(DEFAULT_I18N_CONFIG);
  });

  test('empty i18n object -> DEFAULT_I18N_CONFIG (migrate falls back)', () => {
    const root = projectWith({ i18n: {} });
    expect(loadI18nConfig(root)).toEqual(DEFAULT_I18N_CONFIG);
  });

  test('legacy string[] locales are migrated to LocaleConfig[]', () => {
    const root = projectWith({ i18n: { defaultLocale: 'en', locales: ['en', 'pl'] } });
    const cfg = loadI18nConfig(root);
    expect(cfg.defaultLocale).toBe('en');
    expect(cfg.locales.map((l) => l.code)).toEqual(['en', 'pl']);
    // migrateLocaleString upper-cases name/nativeName and builds a langTag.
    expect(cfg.locales[1]).toMatchObject({ code: 'pl', name: 'PL', nativeName: 'PL' });
    expect(cfg.locales[1].langTag).toBe('pl-PL');
  });

  test('unparseable JSON -> DEFAULT_I18N_CONFIG (never throws)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-i18n-bad-'));
    tmps.push(dir);
    writeFileSync(join(dir, 'project.config.json'), '{ this is not json', 'utf8');
    expect(loadI18nConfig(dir)).toEqual(DEFAULT_I18N_CONFIG);
  });
});
