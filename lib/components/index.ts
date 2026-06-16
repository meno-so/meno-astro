/**
 * meno-astro/components — the runtime `.astro` components emitted pages/components import.
 *
 * Emitted markup uses `import { BaseLayout, Link, Embed, LocaleList } from
 * 'meno-astro/components'` (see dialect/emit/frontmatter.ts component-import lines). This
 * barrel re-exports each `.astro` file as a named export so those imports resolve.
 *
 * NOTE: these are `.astro` modules — they are compiled by Astro's Vite plugin at build
 * time, not by `tsc`. This barrel is the resolution surface; type-checking of the
 * components themselves happens under `astro check`, not this package's `tsc` run.
 */

export { default as BaseLayout } from './BaseLayout.astro';
export { default as Link } from './Link.astro';
export { default as Embed } from './Embed.astro';
export { default as LocaleList } from './LocaleList.astro';
