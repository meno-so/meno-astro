import { test, expect, describe } from 'bun:test';
import { normalizeEnvVars, buildEnvSchema, type EnvFieldFactory } from './loadEnvConfig';

/** A stub envField that records the options it was called with (keyed by maker). */
function recordingEnvField() {
  const calls: { maker: string; opts: Record<string, unknown> }[] = [];
  const make = (maker: string) => (opts: Record<string, unknown>) => {
    calls.push({ maker, opts });
    return { __field: maker, ...opts };
  };
  const envField: EnvFieldFactory = { string: make('string'), number: make('number'), boolean: make('boolean') };
  return { envField, calls };
}

describe('normalizeEnvVars', () => {
  test('keeps only well-formed UPPER_SNAKE_CASE names', () => {
    const out = normalizeEnvVars([
      { name: 'API_URL' },
      { name: 'lowercase' }, // rejected
      { name: '1BAD' }, // rejected (leading digit)
      { name: 'OK_2' },
      { nope: true }, // rejected (no name)
      null,
    ]);
    expect(out.map((v) => v.name)).toEqual(['API_URL', 'OK_2']);
  });

  test('non-array input → empty', () => {
    expect(normalizeEnvVars(undefined)).toEqual([]);
    expect(normalizeEnvVars({})).toEqual([]);
  });
});

describe('buildEnvSchema', () => {
  test('maps type/context/access with sensible defaults', () => {
    const { envField, calls } = recordingEnvField();
    const schema = buildEnvSchema(
      [
        { name: 'PUBLIC_API_URL', context: 'client' },
        { name: 'API_SECRET' }, // server + secret by default
        { name: 'MAX_ITEMS', type: 'number', context: 'server', access: 'public' },
      ],
      envField,
    );
    expect(Object.keys(schema)).toEqual(['PUBLIC_API_URL', 'API_SECRET', 'MAX_ITEMS']);
    // client → always public
    expect(calls[0]).toEqual({ maker: 'string', opts: { context: 'client', access: 'public' } });
    // server → secret by default
    expect(calls[1]).toEqual({ maker: 'string', opts: { context: 'server', access: 'secret' } });
    // explicit number + public server var
    expect(calls[2]).toEqual({ maker: 'number', opts: { context: 'server', access: 'public' } });
  });

  test('client + secret is forced to public (Astro forbids client secrets)', () => {
    const { envField, calls } = recordingEnvField();
    buildEnvSchema([{ name: 'X', context: 'client', access: 'secret' }], envField);
    expect(calls[0]!.opts.access).toBe('public');
  });

  test('optional + default are passed through', () => {
    const { envField, calls } = recordingEnvField();
    buildEnvSchema([{ name: 'FLAG', type: 'boolean', optional: true, default: false }], envField);
    expect(calls[0]).toEqual({
      maker: 'boolean',
      opts: { context: 'server', access: 'secret', optional: true, default: false },
    });
  });
});
