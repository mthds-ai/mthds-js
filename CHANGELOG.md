# Changelog

## [v0.0.6] - 2026-02-23

### Breaking Changes

- `mthds install` now takes a GitHub address (`org/repo`) or `--dir <path>` instead of a Supabase slug
- `InstallContext` no longer carries `method`/`content`; it now carries a `ResolvedPackage`
- `trackMethodInstall` signature changed from `(slug)` to `(address, version)`

### Added

- **METHODS.toml-based package resolution** — packages are resolved from GitHub repos or local directories, validated against the spec, and all `.mthds` files are installed
- `src/resolver/` module with:
  - `types.ts` — Core types (`MethodsManifest`, `ResolvedPackage`, `ParsedAddress`, etc.)
  - `address.ts` — Address parser (`org/repo[/subpath]`), strips `github.com/` prefix with warning
  - `validate.ts` — TOML manifest validator (reports all errors at once)
  - `github.ts` — GitHub resolver with layered auth (GITHUB_TOKEN env, `gh` CLI, unauthenticated)
  - `local.ts` — Local directory resolver
  - `index.ts` — Barrel re-exports
- `smol-toml` dependency for TOML parsing
- `--dir <path>` option for installing from local directories
- Parallel `.mthds` file downloads from GitHub (batches of 5)
- Package summary displayed before installation (address, version, description, file count)

### Changed

- `mthds install` rewritten to resolve → display summary → agent selection → install flow
- Claude Code agent handler now writes `METHODS.toml` + all `.mthds` files preserving directory structure
- CLI banner updated with new `install <address>` usage and examples
- Telemetry now tracks `address` and `version` instead of slug

## [v0.0.5] - 2026-02-19

- Add SDK usage documentation to README
- Add Runners section explaining how methods are executed
- Update pipelex installer to use https://pipelex.com/install.sh (mac/linux) and install.ps1 (windows)
- Remove uv dependency for pipelex installation
- Auto-publish to npm and create GitHub release on merge to main
- Fix repository URL for npm provenance
- Update project description

## [v0.0.4] - 2026-02-19

- Fix Readme
- Fix deploy scripts

## [v0.0.3] - 2026-02-12

- Add runner management CLI
- Change repo

## [v0.0.2] - 2026-02-11

- Fix PostHog telemetry
- Add Pipelex install skills when installing methods

## [v0.0.1] - 2026-02-11

- Initial commit!
