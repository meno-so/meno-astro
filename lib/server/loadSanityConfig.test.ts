import { test, expect, describe, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSanityConfig } from './loadSanityConfig';

const tmps: string[] = [];
function projectWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'load-sanity-'));
  tmps.push(dir);
  if (config !== undefined) {
    writeFileSync(join(dir, 'project.config.json'), JSON.stringify(config), 'utf8');
  }
  return dir;
}

afterEach(() => {
  while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true });
});

describe('loadSanityConfig', () => {
  test('reads a configured projectId + dataset and fills defaults', () => {
    const cfg = loadSanityConfig(
      projectWith({ integrations: { sanity: { projectId: 'abc123', dataset: 'production' } } }),
    );
    expect(cfg).toEqual({ projectId: 'abc123', dataset: 'production', apiVersion: '2024-01-01', useCdn: true });
  });

  test('honors an explicit apiVersion + useCdn:false', () => {
    const cfg = loadSanityConfig(
      projectWith({
        integrations: { sanity: { projectId: 'p', dataset: 'd', apiVersion: '2021-10-21', useCdn: false } },
      }),
    );
    expect(cfg).toEqual({ projectId: 'p', dataset: 'd', apiVersion: '2021-10-21', useCdn: false });
  });

  test('trims surrounding whitespace on projectId/dataset', () => {
    const cfg = loadSanityConfig(projectWith({ integrations: { sanity: { projectId: '  p  ', dataset: ' d ' } } }));
    expect(cfg).toMatchObject({ projectId: 'p', dataset: 'd' });
  });

  test('missing project.config.json -> null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-sanity-empty-'));
    tmps.push(dir);
    expect(loadSanityConfig(dir)).toBeNull();
  });

  test('no integrations.sanity -> null', () => {
    expect(loadSanityConfig(projectWith({ i18n: {} }))).toBeNull();
    expect(loadSanityConfig(projectWith({ integrations: {} }))).toBeNull();
  });

  test('missing/empty projectId or dataset -> null', () => {
    expect(loadSanityConfig(projectWith({ integrations: { sanity: { projectId: 'p' } } }))).toBeNull();
    expect(loadSanityConfig(projectWith({ integrations: { sanity: { dataset: 'd' } } }))).toBeNull();
    expect(loadSanityConfig(projectWith({ integrations: { sanity: { projectId: '', dataset: 'd' } } }))).toBeNull();
    expect(loadSanityConfig(projectWith({ integrations: { sanity: { projectId: 'p', dataset: '   ' } } }))).toBeNull();
  });

  test('non-string projectId/dataset -> null', () => {
    expect(loadSanityConfig(projectWith({ integrations: { sanity: { projectId: 42, dataset: 'd' } } }))).toBeNull();
  });

  test('unparseable JSON -> null (never throws)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-sanity-bad-'));
    tmps.push(dir);
    writeFileSync(join(dir, 'project.config.json'), '{ not json', 'utf8');
    expect(loadSanityConfig(dir)).toBeNull();
  });
});
