/**
 * Typed environment variables (`astro:env`) from a Meno project's `project.config.json`.
 *
 * A project may declare an `env` array of variable definitions. The integration maps these
 * to Astro's native `env.schema` (via `envField`) so the project can read typed, validated
 * env vars through `astro:env/client` and `astro:env/server`. Values themselves live in the
 * standard `.env` file / deploy platform — Meno only models the SCHEMA (name, type, where it's
 * readable, and whether it's a public or secret value).
 *
 * `buildEnvSchema` takes the `envField` factory as a parameter so the mapping is unit-testable
 * without importing the real `astro/config` (which the integration passes at runtime).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MenoEnvVar {
  /** The env var name. Convention: UPPER_SNAKE_CASE (validated). */
  name: string;
  /** Value type. Defaults to `'string'`. */
  type?: 'string' | 'number' | 'boolean';
  /** Where it can be read: `'client'` (bundled into the browser) or `'server'`. Default `'server'`. */
  context?: 'client' | 'server';
  /** `'public'` (readable value) or `'secret'` (server-only). Client vars are always public. */
  access?: 'public' | 'secret';
  /** When true, the var is optional (no value required at build). */
  optional?: boolean;
  /** A default value used when the var is unset. */
  default?: string | number | boolean;
}

/**
 * A minimal structural shape of `astro/config`'s `envField` factory (the three makers we call).
 * `opts` is `any` so the real `envField` (with its precise per-type input types) is assignable —
 * we always pass a plain options object built below.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EnvFieldFactory = Record<'string' | 'number' | 'boolean', (opts: any) => unknown>;

/** Read + validate the `env` array from a project's `project.config.json` (never throws). */
export function loadEnvConfig(projectRoot: string): MenoEnvVar[] {
  const path = join(projectRoot, 'project.config.json');
  if (!existsSync(path)) return [];
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as { env?: unknown };
    return normalizeEnvVars(cfg.env);
  } catch {
    return [];
  }
}

/** Keep only well-formed entries with a valid UPPER_SNAKE_CASE name. Exported for tests. */
export function normalizeEnvVars(raw: unknown): MenoEnvVar[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (v): v is MenoEnvVar =>
      !!v &&
      typeof v === 'object' &&
      typeof (v as MenoEnvVar).name === 'string' &&
      /^[A-Z][A-Z0-9_]*$/.test((v as MenoEnvVar).name),
  );
}

/**
 * Map Meno env var definitions → an Astro `env.schema` object using the given `envField`
 * factory. Pure; the integration passes the real `envField` from `astro/config`.
 * Astro forbids a `client` + `secret` combination, so a client var is always `public`.
 */
export function buildEnvSchema(vars: MenoEnvVar[], envField: EnvFieldFactory): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  for (const v of vars) {
    if (!v.name) continue;
    const type = v.type ?? 'string';
    const context = v.context ?? 'server';
    const access = context === 'client' ? 'public' : (v.access ?? 'secret');
    const opts: Record<string, unknown> = { context, access };
    if (v.optional) opts.optional = true;
    if (v.default !== undefined) opts.default = v.default;
    const make = envField[type] ?? envField.string;
    schema[v.name] = make(opts);
  }
  return schema;
}
