# Changelog

## [v0.3.0] - 2026-03-30

### Added

- **`mthds-agent upgrade` command** — upgrade the pipelex backend to a specific or latest version via `uv`.
- **`mthds-agent update-check` command** — check for available pipelex updates with snooze and cache support to avoid redundant network calls.
- **Always-on version checks** — `mthds-agent` automatically checks for pipelex updates on every invocation (with snooze/cache to stay fast).
- **Version-aware binary management** — the agent tracks installed pipelex versions and supports auto-upgrade via `uv`.
- **Subprocess execution timeouts** — all subprocess calls now have configurable timeouts to prevent indefinite hangs.

### Changed

- **Update-check errors are now propagated** — previously swallowed errors in version checks are surfaced to the user.
- **Runner-aware pre-flight checks improved** — TOCTOU race fixes and snooze-before-reverify optimization for faster startup.

### Fixed

- **Install/upgrade message text** — corrected misleading messages and tightened post-install verification.
- **Skills repo URL** — updated to `mthds-plugins` and fixed `mthds.ai` links.

## [v0.2.1] - 2026-03-24

### Added

- **`mthds-agent check-model <reference>`** — validate a model reference with fuzzy suggestions. Replaces `assemble` in the Runner interface.
- **`mthds-agent pipe` accepts `type`/`pipe_type` in spec JSON** — the `--type` flag is now optional; pipe type can be provided inside the `--spec` JSON payload as `type` or `pipe_type`. CLI `--type` takes precedence when both are present.

### Changed

- **Refactored agent runner commands** — split runner-aware commands into distinct API and pipelex passthrough implementations for clearer separation of concerns.

### Removed

- **`mthds-agent build` command group** — the `build runner`, `build inputs`, and `build output` subcommands have been removed from the agent CLI.
- **`mthds-agent assemble`** — removed from both the CLI and the `Runner` interface. Use `check-model` for model validation, or build bundles via the `/mthds-build` skill.
- **`Runner.assemble()` interface method** — replaced by `Runner.checkModel()`. SDK consumers must update their `Runner` implementations.

### Fixed

- **`mthds-agent --help` now shows all commands** — runner-aware commands (`validate`, `run`, `models`, etc.) are now visible in help output regardless of the active runner. Previously they were only listed with `--runner=api`.
- **`mthds-agent models` (and other runner-aware commands) now work with pipelex runner** — commands like `models` were silently swallowed by the default action handler instead of being forwarded to `pipelex-agent`.
- **Removed misleading "JSON output only" from help description** — the pipelex runner passes through non-JSON output (TOML, markdown) from `pipelex-agent`.

## [v0.2.0] - 2026-03-24

### Breaking Changes

- **`mthds_contents` is now `string[]` everywhere** — all runner request types (`BuildInputsRequest`, `BuildOutputRequest`, `BuildRunnerRequest`, `ExecuteRequest`, `ValidateRequest`) and `PipelineRequest` now use `mthds_contents: string[]` instead of `mthds_content: string`. `ValidateResponse.mthds_contents` is also `string[]`. Callers that passed a single string must now wrap it in an array (`[content]`). The `ApiRunner.validate()` method no longer wraps the value internally — it passes `request` through directly.
- **Removed `mthds-agent pipelex` and `mthds-agent api` subcommand groups** — runner-aware commands (`concept`, `pipe`, `assemble`, `validate`, `inputs`, `run`, `models`) are now registered at the top level. Use `mthds-agent --runner <type> <command>` to override the runner, or rely on the default runner configured via `mthds-agent runner setup`.

### Added

- **`--runner <type>` global option on `mthds-agent`** — select which runner (`api`, `pipelex`) to use for any command. Applies to all runner-aware commands. Falls back to the default runner from config when omitted.
- **Top-level `mthds-agent concept`** — structure a concept from JSON spec (previously only under `pipelex`/`api` groups).
- **Top-level `mthds-agent pipe`** — structure a pipe from JSON spec (previously only under `pipelex`/`api` groups).
- **Top-level `mthds-agent assemble`** — assemble a `.mthds` bundle from TOML parts (previously only under `pipelex`/`api` groups).
- **Top-level `mthds-agent inputs`** — generate example input JSON for a bundle, pipe, or method (previously only under `pipelex`/`api` groups).
- **Top-level `mthds-agent models`** — list available model presets and talent mappings (previously only under `pipelex`/`api` groups).
- **Unified `mthds-agent run` and `mthds-agent validate`** — now work with both API and pipelex runners. Pipelex runner uses passthrough for full CLI flag compatibility; API runner uses the Runner interface.

### Changed

- **Runner resolution** — all runner-aware commands now resolve the runner dynamically: `--runner` flag → default runner from config. No more hardcoded runner per command group.
- **`PipelexRunner` writes `mthds_contents` array to temp files** — new `writeMthdsContents()` helper writes the first element as `bundle.mthds` and additional elements as `extra_N.mthds`, with `-L tmp` for library resolution.

## [v0.1.3] - 2026-03-18

### Added

- **Release skill** — new `/release` Claude Code skill that guides through version bumping, changelog updates, branch management, checks, and commit in 8 interactive steps.

### Fixed

- **`--log-level` flag** — fixed empty string injection when `--log-level` has no value, and corrected argument ordering for log level passthrough.

## [v0.1.2] - 2026-03-04

### Added

- **`mthds publish`** — new interactive CLI command to publish methods to mthds.sh. Resolves methods from GitHub or local directory, displays a summary, lets the user select which methods to publish (multiselect), sends `method_publish` telemetry for public GitHub repos, and prints success. No files are written, no runner is installed.
- **`mthds share`** — new interactive CLI command to share methods on social media. Resolves methods, lets the user pick which ones to share and which platforms (X/Twitter, Reddit, LinkedIn), then opens browser tabs with pre-filled posts.
- **`mthds-agent publish`** — non-interactive agent CLI for publishing. Returns JSON with `published_methods` and `address`.
- **`mthds-agent share`** — non-interactive agent CLI for sharing. Returns JSON with `share_urls` for each platform. Supports `--platform <name>` (repeatable) to request specific platforms (x, reddit, linkedin). Defaults to all.
- **`trackPublish()` telemetry** — new `method_publish` PostHog event, same shape as `method_install`.
- **Social media share URLs** — `buildShareUrls()` generates pre-filled post URLs for X (Twitter Web Intent), Reddit (text post), and LinkedIn (feed share). Single-method posts include the full description; multi-method posts list names with truncated descriptions (15 words).
- **Multiselect retry UX** — when the user selects 0 items in a multiselect (methods or platforms), a yellow warning is shown and the prompt is re-presented. On a second empty selection, the command exits gracefully.

## [v0.1.1] - 2026-03-03

### Added

- **`mthds login`** — new command that opens the browser for Pipelex Gateway OAuth login (GitHub or Google) and saves the API key to `~/.pipelex/.env`. Installs pipelex automatically if needed.
- **`mthds-agent pipelex login`** — new agent CLI passthrough that forwards to `pipelex login --no-logo` for browser-based Gateway authentication. Unlike other pipelex passthroughs (which go to `pipelex-agent`), this targets the interactive `pipelex` binary since login requires browser interaction.
- **`pipelex` binary in auto-install registry** — the passthrough layer can now auto-install `pipelex` (not just `pipelex-agent`) when `--auto-install` is set.

## [v0.1.0] - 2026-03-02

### Breaking Changes

- **Method names: strict snake_case** — the `name` field now enforces snake_case only (pattern `[a-z][a-z0-9_]{1,24}`). Hyphens are no longer allowed — names like `my-method` must become `my_method`.
- **`methodNameToDir()` removed** — method name is now used directly as the directory name with no conversion. The resolver expects the directory name to match the `name` field exactly.

### Changed

- **Pipelex runner: health uses `pipelex doctor -g`** — replaced `pipelex --version` (which could hang on fresh installs) with `pipelex doctor -g`, with a 10s timeout.
- **GitHub resolver uses async `gh api` calls** — replaced `execFileSync` with `execFileAsync` for `gh api` to stop blocking the event loop (which froze spinners during install).
- **Telemetry: `version` renamed to `package_version`** — avoids PostHog's reserved `version` property mapping that hid the method version under "App version".

### Added

- **`mthds run bundle`** — new subcommand to run a `.mthds` bundle file directly via the pipelex runner (passthrough to `pipelex run bundle`).
- **`mthds validate bundle`** — new subcommand to validate a `.mthds` bundle file directly via the pipelex runner (passthrough to `pipelex validate bundle`).
- **`mthds-agent run method|pipe|bundle`** — new `run` command group for the agent CLI. All three subcommands are pipelex-only passthroughs.
- **`mthds-agent validate bundle`** — new subcommand for the agent CLI to validate bundles via pipelex.

## [v0.0.15] - 2026-03-01

### Added

- **Method validation during install** — `mthds install` now validates each method's pipes using `pipelex validate method <url> --pipe <pipe_code>` before installing. If `main_pipe` is set, only that pipe is validated; otherwise all exported pipes are validated individually. If any pipe fails, install is aborted.
- **Runner health check before install** — verifies the configured runner before proceeding. If no runner is available, validation is skipped with a warning.
- **Immediate spinner on install** — spinner starts right after `mthds install` banner, before address parsing, so there's no blank pause while resolving methods from GitHub.
- **`--runner <type>` option on install** — pass `--runner pipelex` or `--runner api` to override the configured runner.
- **Manifest validation: exports required** — `[exports]` section must define at least one domain with pipes; manifests with no exports now fail validation.
- **Manifest validation: main_pipe in exports** — if `main_pipe` is set, it must be listed in one of the `[exports]` domains.
- **`collectAllExportedPipes()` helper** — recursively walks the hierarchical `ExportNode` tree to collect all pipe names from exports.
- **`method_url` and `pipe_code` on `ValidateRequest`** — runner interface now accepts a GitHub URL or local path for validation, with optional pipe targeting.
- **`mthds validate method` accepts URLs** — `<target>` can now be a GitHub URL, local path, or method name.

### Changed

- **Pipelex runner: validate uses `pipelex validate method <url>`** — replaced the broken `pipelex validate --bundle <tmpfile>` with the correct CLI command.
- **Pipelex runner: validation streams output** — validation uses `execStreaming` so pipelex progress is visible in real-time.
- **"Install pipelex?" prompt only when not installed** — no longer asks to install pipelex if it's already available.

## [v0.0.14] - 2026-02-27

### Changed

- **`mthds-agent pipelex run`** — Added `bundle` as a recognized subcommand alongside `pipe` and `method`.

## [v0.0.13] - 2026-02-27

### Added

- **`mthds-agent runner setup pipelex`** — Non-interactive command to install the Pipelex runtime binary. Returns structured JSON. Does not initialize configuration — use `mthds-agent pipelex init` for that.
- **`mthds-agent runner setup api`** — Non-interactive command to set up the API runner with `--api-key` and optional `--api-url`.
- **`mthds-agent pipelex init`** — Passthrough to `pipelex-agent init` for non-interactive Pipelex configuration (backends, gateway terms, telemetry).
- **`--no-logo` global option** — Suppress the ASCII logo on the `mthds` CLI. Applies to all commands.
- **Agent CLI docs in CLI.md** — Added `mthds-agent` section documenting `runner setup pipelex`, `runner setup api`, and `pipelex init`.

### Changed

- **New ASCII logo** — Updated the `mthds` CLI banner with a new block-style logo.
- **`mthds-agent package` `-C` option** — Moved `-C, --package-dir` from the parent `package` command to each subcommand (`init`, `list`, `validate`) for correct option parsing.

### Removed

- **`mthds run bundle`** — Reverted the `run bundle` subcommand. `mthds run pipe` accepts both pipe codes and `.mthds` bundle files again (auto-detected). `PipelexRunner.execute()` reverted to `run <target>` form.

## [v0.0.12] - 2026-02-26

### Added

- **Binary recovery metadata** — shared `BINARY_RECOVERY` registry (`binaries.ts`) with install commands and URLs for `pipelex-agent` and `plxt`
- **Enriched error output** — missing-binary errors now include recovery hints (install command, documentation URL) in structured JSON output
- **`--auto-install` flag** — passthrough commands (`pipelex-agent`, `plxt`) automatically install missing binaries when this flag is set
- **`mthds-agent doctor`** — health-check command that reports binary dependencies (installed, version, path), configuration state, and actionable issues with severity levels
- **`mthds-agent package init`** — initialize a METHODS.toml manifest with name, display name, and main pipe validation; supports `--display-name` flag
- **`mthds-agent package list`** — list all methods in a package directory with structured JSON output
- **`mthds-agent package validate`** — validate METHODS.toml with actionable error hints and consistent manifest shape (authors/exports always present)

### Fixed

- **Duplicate doctor diagnostic** — when `runner=pipelex` and `pipelex-agent` is missing, doctor now emits a single error instead of both a warning and an error
- **Windows Python compatibility** — `installPlxtSync()` uses `python` on Windows instead of hardcoded `python3` which doesn't exist on that platform
- **Shared install helper** — extracted `runPipelexInstallSync()` to deduplicate pipelex installation logic between interactive and sync paths
- **Portable pip invocation** — use `python3 -m pip` instead of bare `pip` for plxt installation
- **Package validate error handling** — `readFileSync` moved inside try block for proper error reporting when METHODS.toml is missing
- **Test isolation** — added `beforeEach` mock reset in `check.test.ts` to prevent cross-block state leakage

## [v0.0.11] - 2026-02-25

### Fixed

- **Pipelex installation URL** — updated install scripts from `pipelex.com` to `pipelex-website.vercel.app`
- **Pipelex install verification** — installation now verifies that `pipelex` is actually available in PATH after running the install script, instead of silently reporting success
- **Pipelex install error visibility** — changed `stdio` from `"ignore"` to `"pipe"` so install script errors are captured and reported
- **Runner setup resilience** — `mthds runner setup pipelex` now re-checks availability after installation and exits with a clear error if pipelex is still not reachable

## [v0.0.10] - 2026-02-25

### Fixed

- Quick start doc

## [v0.0.9] - 2026-02-25

### Changed

- **Mask API key in `config list` / `config get`** — API key now shows only the first 5 characters followed by stars instead of the full value.
- **`maskApiKey` moved to shared utils** — extracted from `setup.ts` to `cli/commands/utils.ts` so it can be reused across commands.
- **Banner updated** — reflects actual CLI commands (`run method|pipe`, `validate method|pipe`, `runner setup|set-default|status`); removed stale examples; added link to CLI.md.

### Removed

- **`package add`, `package lock`, `package install`, `package update`** — removed unimplemented dependency management commands and their source files. Only `package init`, `package list`, and `package validate` remain.

### Docs

- **CLI.md** — removed `package add/lock/install/update` sections; updated Package section intro.

## [v0.0.8] - 2026-02-24

### Breaking Changes

- **CLI restructure: `method` / `pipe` subcommands** — `mthds run`, `mthds validate`, and all `mthds build` subcommands (`runner`, `inputs`, `output`) now require an explicit `method` or `pipe` keyword. For example: `mthds run method my-method` or `mthds run pipe scoring.compute`. The old `mthds run <target>` form is no longer supported.
- **`[dependencies]` removed from METHODS.toml** — the `dependencies` field has been removed from the Zod schema and TypeScript types. A `[dependencies]` section in METHODS.toml now causes a validation error.
- **`.plx` → `.mthds`** — all file extensions, variable names, and user-facing strings now use `.mthds` instead of `.plx`. Bundle detection (`target.endsWith(...)`) updated across `run`, `build`, and `validate` commands.
- **`plx_content` → `mthds_content`** — all request/response interfaces and runner implementations renamed.
- **`validatePlx` → `validateBundle`** — function renamed.

### Added

- **Runner passthrough** — `run` and all `build` subcommands now pass arguments directly to the `pipelex` CLI when using the pipelex runner. No temp files, no file roundtrips. Pipelex-specific flags (e.g. `--dry-run`, `--mock-inputs`, `--output-dir`) are forwarded transparently.
- **`mthds setup runner api`** — interactive setup for the API runner. Prompts for API URL (pre-filled with current value) and API key (masked input). Saves to `~/.mthds/credentials`.
- **`Runners` enum** — added `Runners` const object and `RUNNER_NAMES` array in `types.ts`. All runner type string literals replaced with `Runners.API` / `Runners.PIPELEX` across the codebase.
- **`buildPassthrough()`** — new method on `PipelexRunner` that forwards `build <subcommand> <args>` to pipelex.
- **`runPassthrough()`** — new method on `PipelexRunner` that forwards `run <args>` to pipelex.
- **`.allowUnknownOption()` + `.allowExcessArguments(true)`** — on `run` and all `build` subcommands so runner-specific flags pass through Commander.js without error.
- **`name` field in manifest** — optional method identifier (2-25 lowercase chars, regex `^[a-z][a-z0-9_-]{1,24}$`).
- **`main_pipe` field in manifest** — optional default pipe code (must be snake_case).
- **Agent CLI restructure** — `mthds-agent run`, `validate`, and `build` commands mirror the same `method`/`pipe` subcommand structure with JSON output.
- **`validatePassthrough()`** — new method on `PipelexRunner` for forwarding validate commands to the pipelex CLI.

### Changed

- **`--pipe` now optional** — relaxed from `requiredOption` to `option` on `build inputs` and `build output`. Validated at handler level only for the API runner.
- **`mthds setup runner`** — now accepts both `api` and `pipelex` (previously rejected `api` as unknown).
- **API key input** — `setup runner api` uses `p.password()` with masked input. Existing key shown as first 5 chars + stars.
- **CLI descriptions** — updated help text to use `.mthds` everywhere, `<target>` descriptions changed from ".plx bundle file" to "Bundle file path".
- **Banner** — updated examples to use `.mthds` extension and "Validate a bundle" instead of "Validate PLX content".

### Docs

- **CLI.md** — fully rewritten: all `.plx` → `.mthds`, added "Runner Passthrough" section, documented `setup runner api`, updated all examples, `--pipe` marked optional where applicable.
- **README.md** — quick start updated to use `mthds setup runner api`, all `.plx` → `.mthds`, API runner section updated.

## [v0.0.7] - 2026-02-23

### Fixed

- **Install path** — methods now install to `methods/<slug>/` instead of `methods/<org>/<repo>/<slug>/`
- **Path traversal guard** — added trailing separator to `startsWith` check to prevent sibling directory prefix bypass
- **Cross-platform basename** — use `basename()` from `node:path` instead of `split("/").pop()` in local resolver
- **Reserved prefix validation** — `startsWith()` instead of exact match, so `native-utils` is correctly rejected
- **`.env.local` parser** — now handles quoted values (`"1"`, `'1'`), whitespace, and comments
- **Telemetry enable UX** — shows either success or warning about env override, never both

### Changed

- **Runner prompt** — now says "Do you want to install the pipelex runner?" with link to GitHub repo
- **Skills prompt** — only shown when user says yes to the runner prompt, not based on whether pipelex is already installed
- **Public-repo-only telemetry** — CLI checks GitHub API `private` field; no telemetry sent for private repos or `--dir` installs
- **`ResolvedRepo.isPublic`** — new flag set by GitHub resolver

## [v0.0.6] - 2026-02-23

### Breaking Changes

- Telemetry event renamed from `method_installed` to `install`
- `trackMethodInstall` renamed to `trackInstall` with enriched payload
- Supabase types rewritten: `methods` table → `packages` table, `Method` → `Package`
- `fetchMethodBySlug` replaced by `fetchPackageByAddressAndSlug` (queries by `address` + `slug`)
- Install path changed from `<dir>/<repo>/<slug>/` to `<dir>/<org>/<repo>/<slug>/` to avoid collisions

### Added

- **`--method <slug>` option** — install a single method from a multi-method repository
- **Enriched telemetry** — `install` event now includes full manifest data: description, display_name, authors, license, mthds_version, exports, dependencies, and raw METHODS.toml
- **Public-repo-only telemetry** — telemetry is only sent for public GitHub repositories; local installs and private repos send nothing
- **Repository visibility check** — `ResolvedRepo.isPublic` flag, set by querying the GitHub API
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
- Pipelex skills prompt now says "For a better experience using the pipelex runner, install the skills"
- Install path uses `org/repo` as directory name instead of just `repo`

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
