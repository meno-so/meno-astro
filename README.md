# meno-astro

[![npm](https://img.shields.io/npm/v/meno-astro.svg)](https://www.npmjs.com/package/meno-astro)

Runtime helpers + the round-trippable `.astro` dialect (`emit`/`parse`) that lets
[Meno](https://github.com/meno-so) use Astro files as a project's source-of-truth
format. This is the package that Meno-generated Astro projects depend on at build
and runtime.

It provides:

- **`meno-astro/integration`** — the Astro integration that maps a project's i18n
  config into Astro's native i18n routing and injects the locale middleware.
- **`meno-astro/components`** — shared `.astro` components (`BaseLayout`, `Link`, …).
- **`meno-astro/runtime/localeMiddleware`** — the per-render locale context.
- **`meno-astro`** / **`meno-astro/dialect`** — runtime helpers (`style`, `richText`,
  `resolveProps`, the client form handler, …) and the dialect codec.

## Install

```sh
npm install meno-astro
```

## Usage

```js
// astro.config.mjs
import { defineConfig } from 'astro/config';
import meno from 'meno-astro/integration';

export default defineConfig({
  integrations: [meno()],
});
```

Requires `astro` (peer) and pulls in [`meno-core`](https://www.npmjs.com/package/meno-core).

## Build & test

```sh
bun install
bun run build   # esbuild → dist/ (the published artifact)
bun test
```

## About this repository

This is the **public, runtime-only mirror** of `meno-astro`. Active development
happens upstream in the Meno monorepo; this repository is regenerated from it on
each release (it contains the runtime surface published to npm — not Meno's
build-time JSON→`.astro` converter, which depends on closed internals). The
authoritative test suite runs upstream. Issues and discussion are welcome here.

## License

[MIT](./LICENSE) © Meno
