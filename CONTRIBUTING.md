# Contributing

Thanks for taking a look. This is a small, dependency-light plugin; the most
useful contributions are bug reports with a reproducible state and focused
patches.

## Requirements

- Node.js `^22.19 || >=24` (CI runs 22.19 and 24).
- npm (the repository ships a `package-lock.json`).
- dsh-TUI 0.17.0 for a real end-to-end check.

## Setup

```sh
git clone https://github.com/Ding-Kyoma/dsh-tui-workspace-sidebar.git
cd dsh-tui-workspace-sidebar
npm ci
```

## Checks

```sh
npm test                 # node --test
npm run check:manifest   # offline package/manifest release guard
npm pack --dry-run       # inspect the published surface
```

There is no build step: the package publishes the ESM sources in place. Tests
use temporary directories and never read or write the real `~/.dsh-tui` state.

## Pull requests

- Keep the change focused; include a regression test for a behavior change.
- Do not commit `node_modules/`, logs, `.DS_Store`, `.env*`, keys or local state.
- Do not add a dependency when a Node built-in will do. `@deepseek-ai/schemastery`
  is the only runtime dependency, and it exists to expose the Cordis `Config`
  contract.
- Commit messages follow the existing style: `fix(scope): ...`,
  `feat(scope): ...`, `docs: ...`, `chore: ...`.
- Run `npm test` and `npm run check:manifest` before opening the PR.
- By contributing you agree that your contribution is licensed under MIT.

## Releasing

The repository is tag-driven:

1. Update `package.json`, `dsh-plugin.json` and `CHANGELOG.md` to the same
   version, then run the checks.
2. Configure npm trusted publishing for the repository (or add an `NPM_TOKEN`
   secret) if this is the first release.
3. Push a `vX.Y.Z` tag whose version equals `package.json`. The `publish`
   workflow verifies the tag, packs the package and runs
   `npm publish --provenance --access public`.

Never push a `v*` tag just to test CI; the publish workflow will attempt a
release. Use a branch push or a manual workflow dispatch instead.
