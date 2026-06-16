/**
 * Client-side CMS filtering runtime — the meno-astro twin of meno-core's
 * `menoFilterScript` (`packages/core/lib/client/meno-filter/script.generated.ts`).
 *
 * MenoFilter is a declarative, data-attribute-driven library: a `[data-meno-filter]`
 * wrapper around filter controls (`data-meno-filter-field`/`-value`, `data-meno-search`,
 * `data-meno-sort`, range/pagination inputs, …) and a `[data-meno-list]` container of
 * CMS cards. The converter already round-trips every one of those attributes (see
 * dialect/emit), so a converted page carries the full filter UI — it just needs this
 * runtime to wire the behaviour.
 *
 * Two data modes, both handled by this one script (it auto-detects on init):
 *   - **DOM-only** (Tier 1) — no embedded data. Filters/searches/sorts/paginates by
 *     reading each SSR card's `data-<field>` attributes. Covers category/string filters,
 *     text search, sort, and pagination off the markup alone.
 *   - **JSON data** (Tier 2/3) — reads `<script type="application/json" id="meno-cms-<id>">`
 *     (inline) or fetches `/data/<id>/index.json` (static). Unlocks type coercion
 *     (`data-meno-types`), numeric/date range filters, facet + total counts, and
 *     `<template data-meno-item>` rendering for items not server-rendered. It reuses
 *     the SSR cards by `data-id`, so the static HTML stays the SEO/no-JS baseline.
 *
 * Kept HERE (re-bundled from meno-core's source by `scripts/build-meno-filter.mjs`,
 * NOT imported from meno-core) for the same reason as `formHandlerScript` /
 * `toHtmlString` / `richText`: it must ship inside the locally-rebuilt play runtime,
 * and a converted project depends only on `meno-astro` + `astro` (not `meno-core`), so
 * a meno-core import would not resolve at the user's build. The generated string is in
 * `menoFilterScript.generated.ts`; regenerate it with `bun run build:filter` whenever
 * meno-core's meno-filter source changes.
 *
 * BaseLayout.astro injects it before `</body>` inside `<script is:inline>`. The bundle
 * self-gates — its auto-init queries `[data-meno-filter]` and is a no-op when the page
 * has none — so injecting it unconditionally (like `formHandlerScript`) is harmless.
 */
export { menoFilterScript } from './menoFilterScript.generated';
