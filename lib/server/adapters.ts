/**
 * SSR adapter registry — the single source of truth mapping a Meno "output mode + adapter"
 * choice to the Astro adapter integration package + npm deps it needs. Parallel to
 * `islandFrameworks.ts`. Used by:
 *   - the `meno()` integration (`astro:config:setup`) to set `output: 'server'` and
 *     auto-register the `@astrojs/<adapter>` integration (which sets itself as the adapter
 *     via its own `astro:config:done` hook) — so a converted project's astro.config stays
 *     exactly `integrations: [meno()]`, NEVER importing the adapter directly;
 *   - `convertProject` to add the adapter dep to a converted project's `package.json`;
 *   - the play-runtime provisioner (via `MENO_ASTRO_ADAPTER`) to install the adapter package.
 *
 * An adapter is only installed when the project opts into SSR (`output: 'server'` with an
 * adapter); static projects (the default) carry none.
 */

export type AstroAdapter = 'node' | 'netlify' | 'vercel' | 'cloudflare';

export const ASTRO_ADAPTERS: readonly AstroAdapter[] = ['node', 'netlify', 'vercel', 'cloudflare'];

export function isAstroAdapter(value: string): value is AstroAdapter {
  return (ASTRO_ADAPTERS as readonly string[]).includes(value);
}

export interface AdapterSpec {
  /** The adapter integration package (`@astrojs/<name>`). */
  package: string;
  /** npm deps to install for this adapter (Astro 6). */
  deps: Record<string, string>;
}

/**
 * Adapter integration package + deps per adapter (Astro 6).
 *
 * Version majors VERIFIED against `astro@^6` (each adapter's `peerDependencies.astro`):
 *   - `@astrojs/node@^10`        (peer astro ^6.3.0)
 *   - `@astrojs/vercel@^10`      (peer astro ^6.0.0)
 *   - `@astrojs/netlify@^7`      (peer astro ^6.0.0)
 *   - `@astrojs/cloudflare@^13`  (peer astro ^6.3.0)
 *
 * Bump here when a new Astro major lands (same contract the island-framework specs +
 * `menoAstroVersion` follow). A wrong range only affects the SSR opt-in (gated behind the
 * Studio output toggle), never static projects.
 */
export const ASTRO_ADAPTER_SPECS: Record<AstroAdapter, AdapterSpec> = {
  node: { package: '@astrojs/node', deps: { '@astrojs/node': '^10' } },
  netlify: { package: '@astrojs/netlify', deps: { '@astrojs/netlify': '^7' } },
  vercel: { package: '@astrojs/vercel', deps: { '@astrojs/vercel': '^10' } },
  cloudflare: { package: '@astrojs/cloudflare', deps: { '@astrojs/cloudflare': '^13' } },
};

/** Every adapter integration package — reserved by the runtime store (never project-installed). */
export const ALL_ADAPTER_PACKAGES: readonly string[] = ASTRO_ADAPTERS.map((a) => ASTRO_ADAPTER_SPECS[a].package);

/** The npm deps for one adapter, or `{}` for none/unknown. */
export function adapterDeps(adapter: string | undefined | null): Record<string, string> {
  if (!adapter || !isAstroAdapter(adapter)) return {};
  return { ...ASTRO_ADAPTER_SPECS[adapter].deps };
}
