# Contributing to meno-astro

Thanks for your interest! A note on how this repository works:

`meno-astro` is developed **upstream**, inside the [Meno](https://github.com/meno-so)
monorepo. This repository is a **regenerated, runtime-only mirror** of that package —
it's what publishes to npm, but it is not where day-to-day development happens. As a
result, code changes are integrated upstream and synced back here on each release.

## How to help

- **Bugs & feature requests:** please [open an issue](https://github.com/meno-so/meno-astro/issues).
  Clear reproductions (a minimal Astro project, the `meno-astro` version, and expected
  vs. actual behaviour) are hugely appreciated.
- **Pull requests:** welcome for docs, types, and self-contained runtime fixes. Because
  the source is synced from upstream, a maintainer may re-apply your change there so it
  survives the next sync — your authorship is preserved.

## Local development

```sh
bun install
bun run build   # esbuild → dist/ (the published artifact)
bun test
```

The build marks `meno-core` external, so it runs without a local checkout of Meno's
core. Tests run against `meno-core` + `astro` installed from npm.

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](./LICENSE).
