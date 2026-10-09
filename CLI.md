# MTHDS CLI Reference (JavaScript)

Command-line interface for the [mthds.ai](https://mthds.ai/latest/) open standard. Install methods, execute pipelines, and manage configuration.

## Installation

```bash
# Global install
npm install -g mthds

# Run without installing
npx mthds

# For development
npm install
npm run build
```

After installation the `mthds` command is available on your PATH.

## Quick Start

```bash
# Get a Pipelex API key for runs on the hosted Pipelex API (opens a browser)
mthds login

# Install a method from the hub
mthds install org/repo

# Run a pipeline
mthds run pipe my_pipe_code

# Set up the API runner (interactive)
mthds runner setup api

# Set up the pipelex runner (installs pipelex, then runs pipelex init)
mthds runner setup pipelex
```

## Global Options

| Option | Description |
|---|---|
| `--runner <type>` | Runner to use for the command (`api` or `pipelex`). Applies to `run`, `validate`, and `build` subcommands. |
| `-L, --library-dir <dir>` | Additional library directory (can be repeated). Applies to `run`, `validate`, and `build` subcommands. |
| `--no-logo` | Suppress the ASCII logo |
| `--version` | Print the CLI version |
| `--help` | Show help for any command; a path naming a command that does not exist fails with `unknown command` instead |

When `--runner` is omitted, the CLI uses the runner configured via `mthds config set runner <name>` (default: `pipelex`).

## Runner Passthrough

When using the **pipelex** runner, `run method`, `validate` and `build` act as thin wrappers: they forward their arguments to the `pipelex` CLI, so pipelex's own flags reach it (for `run method`: `--dry-run`, `--mock-inputs`, `--output-dir` and `--hosted`/`--local`, for instance).

`run pipe` and `run bundle` do not forward their arguments. They build their own `pipelex run` command from the target, `--pipe`, `--inputs` and `-L`, and add the pipelex flags they declare: `--dry-run`, `--mock-inputs`, `--hosted` and `--local`. They refuse any other flag as an unknown option, on either runner, rather than drop it and run anyway.

The `--runner` flag is consumed by mthds and not forwarded. The `-L/--library-dir` flags are forwarded to pipelex. With the API runner, `validate pipe` and `build inputs pipe` send every `.mthds` file of each `-L` directory beside the bundle file, so a method split across files validates and gets its inputs template as it does on the pipelex runner.

### Where the pipelex runner executes a run

The pipelex runner hands each run to the `pipelex` CLI on this machine, and pipelex executes it where its `[run] execution` setting says: `local`, its default, runs the method on this machine with your own provider keys, and `hosted` runs it on the hosted Pipelex API with the Pipelex API key in `PIPELEX_API_KEY`, the key [`mthds login`](#login) saves. `pipelex init` writes the setting from its answer to "Where should your runs execute?", whose default is the hosted API. A single `pipelex run` can go the other way with `--hosted` or `--local`, and `mthds run method`, `run pipe` and `run bundle` pass either flag on to it. pipelex refuses `--dry-run` and `--mock-inputs` on a hosted run, so on a machine set to `hosted`, a dry run needs `--local` as well.

A hosted run sends the method's `.mthds` files only, so a method whose pipes call custom Python (`funcs/*.py`) cannot run that way, and it reads only `PIPELEX_API_KEY`, never the API runner's `api-key`.

Hosted runs, the `[run] execution` setting, `--hosted`/`--local` and `pipelex login` need pipelex 0.79.0 or later. `mthds` and `mthds-agent` accept an older pipelex and do not upgrade it to that version: upgrade it with `uv tool install --upgrade "pipelex>=0.79.0"`.

---

## Login

Get a Pipelex API key through the browser, for runs on the hosted Pipelex API. Forwards to `pipelex login`.

### `mthds login`

```bash
mthds login
```

Runs `pipelex login`, which opens the Pipelex app in your browser. Once you are signed in, the app creates a Pipelex API key (it starts with `plx_sk_`) and hands it back to the command, which checks it against the hosted API and saves it as `PIPELEX_API_KEY` in pipelex's home `.env` file: `~/.pipelex/.env`, or the `.env` in `PIPELEX_HOME` when that is set. The key is never printed. `PIPELEX_APP_URL` points the command at another Pipelex app, and `PIPELEX_BASE_URL` at another hosted API.

The key serves pipelex's own hosted runs: a `pipelex run` or `pipelex-agent run` that executes on the hosted API, with `--hosted` or under `[run] execution = "hosted"`, including those made through the pipelex runner (see [Where the pipelex runner executes a run](#where-the-pipelex-runner-executes-a-run)). The API runner does not read it: it uses its own `api-key` (`MTHDS_API_KEY`) from `~/.mthds/config`, set with `mthds runner setup api` or `mthds config set api-key`. Setting one key does not set the other.

If pipelex is not installed, the command installs it first. The command needs pipelex 0.79.0 or later, the first release with `pipelex login`, and it does not upgrade a pipelex that is already installed: with an older one, `pipelex` refuses `login` as an unknown command and `mthds login` fails. Upgrade it with `uv tool install --upgrade "pipelex>=0.79.0"`.

`mthds login` takes no options. On a machine with no browser, run pipelex's own paste form, `pipelex login --paste`, and paste a key created in the Pipelex app.

**Examples:**

```bash
# Get a Pipelex API key through the browser
mthds login

# On a machine with no browser, paste a key created in the Pipelex app
pipelex login --paste
```

---

## Run

Execute a pipeline via a runner.

### `mthds run method`

Run an installed method by name. Only supported with the pipelex runner, which forwards every argument to `pipelex run method`: the options are that command's own, and `pipelex run method --help` lists them all.

```bash
mthds run method <name> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | yes | -- | Name of the installed method; `pipelex run method` also takes a method address (`github.com/<owner>/<repo>[/<name>][@<tag>]`) or a GitHub URL |
| `--pipe <code>` | string | no | -- | Pipe code (overrides method's main_pipe) |
| `-i, --inputs <file>` | string | no | -- | Path to JSON inputs file |
| `-o, --output-dir <dir>` | string | no | -- | Base directory for the run's outputs (working memory, main stuff, graphs) |
| `--no-pretty-print` | flag | no | -- | Skip pretty printing the output |
| `--dry-run` | flag | no | -- | Run without inference calls, on this machine only |
| `--mock-inputs` | flag | no | -- | Generate mock data for missing required inputs (requires `--dry-run`) |
| `--hosted` / `--local` | flag | no | pipelex's `[run] execution` | Run on the hosted Pipelex API, with the key in `PIPELEX_API_KEY`, or on this machine |

`mthds run method --help` also lists `-o, --output <file>` and `--no-output`, which `pipelex run method` does not have: `-o` reaches it as its `--output-dir`, and `--output` or `--no-output` is refused as an unknown option.

### `mthds run pipe`

Run a pipe by code or bundle file.

```bash
mthds run pipe <target> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `target` | string | yes | -- | Pipe code or `.mthds` bundle file |
| `--pipe <code>` | string | no | -- | Pipe code (when target is a bundle) |
| `-i, --inputs <file>` | string | no | -- | Path to JSON inputs file |
| `-o, --output <file>` | string | no | -- | Path to save output JSON |
| `--no-output` | flag | no | -- | Skip saving output to file |
| `--no-pretty-print` | flag | no | -- | Skip pretty printing the output |
| `--dry-run` | flag | no | -- | Run without inference calls; pipelex runner only |
| `--mock-inputs` | flag | no | -- | Generate mock data for missing required inputs (requires `--dry-run`); pipelex runner only |
| `--hosted` / `--local` | flag | no | pipelex's `[run] execution` | Have pipelex run it on the hosted Pipelex API or on this machine; pipelex runner only |

`run pipe` refuses any other flag as an unknown option. With the API runner, the run is a blocking `POST /v1/execute`, which has no dry run: `--dry-run`, `--mock-inputs`, `--hosted` and `--local` are refused before anything is sent, and `mthds validate bundle` checks a bundle without running it. With the pipelex runner, the run is a `pipelex run` that executes where pipelex is set to execute it, unless `--hosted` or `--local` says otherwise (see [Where the pipelex runner executes a run](#where-the-pipelex-runner-executes-a-run)).

### `mthds run bundle`

Run a `.mthds` bundle file or a method directory directly. Like `run pipe`, it refuses any flag not listed below, and the API runner refuses its pipelex runner flags before anything is sent.

```bash
mthds run bundle <target> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `target` | string | yes | -- | `.mthds` bundle file or method directory |
| `--pipe <code>` | string | no | -- | Pipe code to run within the bundle |
| `-i, --inputs <file>` | string | no | -- | Path to JSON inputs file |
| `-o, --output <file>` | string | no | -- | Path to save output JSON |
| `--no-output` | flag | no | -- | Skip saving output to file |
| `--no-pretty-print` | flag | no | -- | Skip pretty printing the output |
| `--dry-run` | flag | no | -- | Run without inference calls; pipelex runner only |
| `--mock-inputs` | flag | no | -- | Generate mock data for missing required inputs (requires `--dry-run`); pipelex runner only |
| `--hosted` / `--local` | flag | no | pipelex's `[run] execution` | Have pipelex run it on the hosted Pipelex API or on this machine; pipelex runner only |

**Examples:**

```bash
# Run an installed method
mthds run method my-method
mthds run method my-method -L methods/

# Run by pipe code
mthds run pipe my_pipe_code

# Run a .mthds bundle file
mthds run pipe ./bundle.mthds --pipe my_pipe

# Run a bundle directly
mthds run bundle ./bundle.mthds --pipe my_pipe

# Dry-run a bundle on this machine, with mock data for the missing inputs
mthds run bundle ./bundle.mthds --dry-run --mock-inputs --local

# Run with inputs and save output
mthds run pipe my_pipe_code --inputs inputs.json --output result.json

# Run an installed method on the hosted Pipelex API, whatever pipelex's default
mthds run method my-method --inputs inputs.json --hosted
```

---

## Validate

Validate a method or bundle via a runner.

### `mthds validate method`

Validate a method by name, GitHub URL, or local path. With the pipelex runner, all arguments are forwarded to `pipelex validate method`.

```bash
mthds validate method <target> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `target` | string | yes | -- | Method name, GitHub URL, or local path |
| `--pipe <code>` | string | no | -- | Pipe code to validate (overrides method's main_pipe) |

### `mthds validate pipe`

Validate a pipe by code or bundle file.

```bash
mthds validate pipe <target> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `target` | string | yes | -- | `.mthds` bundle file or pipe code |
| `--pipe <code>` | string | no | -- | Pipe code that must exist in the bundle |
| `--bundle <file>` | string | no | -- | Bundle file path (alternative to positional) |

With the API runner, the bundle file is sent first, followed by every `.mthds` file of each `-L` directory, and `--pipe` is ignored, since the runner validates every pipe of what it receives.

### `mthds validate bundle`

Validate a `.mthds` bundle file directly. Only supported with the pipelex runner.

```bash
mthds validate bundle <target> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `target` | string | yes | -- | `.mthds` bundle file |
| `--pipe <code>` | string | no | -- | Pipe code to validate within the bundle |

**Examples:**

```bash
# Validate a method from GitHub
mthds validate method https://github.com/Pipelex/methods/methods/cv-analyzer/

# Validate an installed method by name
mthds validate method my-method
mthds validate method my-method -L methods/

# Validate a local method directory
mthds validate method ./methods/my-method

# Validate a bundle file
mthds validate pipe ./bundle.mthds

# Validate a specific pipe within a bundle
mthds validate pipe ./bundle.mthds --pipe my_pipe

# Validate a bundle directly
mthds validate bundle ./bundle.mthds
mthds validate bundle ./bundle.mthds --pipe my_pipe
```

---

## Build

The `build` group has one command, `build inputs`, and delegates it to a runner. With the pipelex runner, it passes its arguments through to the `pipelex build` CLI directly.

A pipe's output representation is generated by the `pipelex` CLI itself, with `pipelex build output`, and `mthds` has no command for it. For the typed structures of a method's concepts, use `pipelex codegen types`; its agent-facing equivalent is [`mthds-agent codegen types`](#mthds-agent-codegen-typescheck), which forwards to `pipelex-agent codegen types` with the pipelex runner.

### `mthds build inputs method|pipe`

Generate an example inputs template for a pipe.

```bash
mthds build inputs method <name> [OPTIONS]
mthds build inputs pipe <target> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` / `target` | string | yes | -- | Method name or bundle file path |
| `--pipe <ref>` | string | no | the closure's `main_pipe` | Qualified pipe ref (`domain.pipe_code`) to generate inputs for |
| `--format <format>` | string | no | `json` | Template format: `json` or `toml` (`pipe` only) |
| `--explicit` | flag | no | -- | Keep the `{concept, content}` envelope on every input (`pipe` only) |

With the API runner, `build inputs pipe` reads the pipe's input form from `POST /v1/pipe-io` and projects the template locally, and `build inputs method` is not available. It sends the bundle file first, followed by every `.mthds` file of each `-L` directory, and when those are several and `--pipe` is omitted it asks for the bundle file's own `main_pipe`, the pipe the pipelex runner templates. With the pipelex runner, both forward to `pipelex`.

**Examples:**

```bash
mthds build inputs method my-method
mthds build inputs pipe ./bundle.mthds --pipe my_domain.my_pipe --format toml
```

---

## Config

Manage configuration stored in `~/.mthds/config`.

Configuration values are resolved in this order: **environment variables > config file > defaults**.

### Valid Configuration Keys

| Key | Environment Variable | Default | Description |
|---|---|---|---|
| `runner` | `MTHDS_RUNNER` | `pipelex` | Default runner (`api` or `pipelex`) |
| `base-url` | `MTHDS_BASE_URL` | `https://api.pipelex.com` | API base URL — host only, no version prefix; endpoints compose as `{base}/v1/{endpoint}` |
| `api-key` | `MTHDS_API_KEY` | (empty) | The API runner's authentication key. The pipelex runner never reads it: pipelex's hosted runs use `PIPELEX_API_KEY`, which [`mthds login`](#login) saves |
| `telemetry` | `DISABLE_TELEMETRY` | `0` | Set to `1` to disable telemetry |

### `mthds config set`

Set a config value.

```bash
mthds config set <key> <value>
```

| Argument | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes | Config key (`runner`, `base-url`, `api-key`, `telemetry`) |
| `value` | string | yes | Value to set |

Validates the value before saving: `runner` must be `api` or `pipelex`; `base-url` must be a valid URL (host only — no version prefix).

**Examples:**

```bash
mthds config set api-key sk-my-api-key
mthds config set runner pipelex
# Self-hosted bare runner:
mthds config set base-url http://localhost:8081
mthds config set telemetry 1
```

### `mthds config get`

Get a config value.

```bash
mthds config get <key>
```

| Argument | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes | Config key |

**Example:**

```bash
mthds config get runner
# runner = pipelex (default)
```

### `mthds config list`

List all config values.

```bash
mthds config list
```

Displays all configuration keys with their current values and sources (env, file, or default).

---

## Runner

Manage runners: setup, set default, and check status.

### `mthds runner setup`

Initialize a runner and optionally set it as the default.

```bash
mthds runner setup <name>
```

| Argument | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Runner name (`api` or `pipelex`) |

**For `api`:** interactively prompts for the API base URL (host only, e.g. `https://api.pipelex.com` or `http://localhost:8081`) and API key (masked input), then saves them to `~/.mthds/config`. This key is the API runner's own: it does not reach the pipelex runner, whose hosted runs use `PIPELEX_API_KEY` (see [Login](#login)).

**For `pipelex`:** installs the pipelex CLI if not already present, then runs `pipelex init`, pipelex's interactive setup. When it sets up inference, `pipelex init` first asks where runs should execute, and its default answer, taken by pressing Enter, is the hosted Pipelex API: it then gets a Pipelex API key through the browser, unless one is already set, and configures no provider of your own. To run methods on this machine with your own provider keys, answer `2` (this machine) instead, and `pipelex init` goes on to the backends and their credentials. Either way, the answer becomes pipelex's `[run] execution` setting (see [Where the pipelex runner executes a run](#where-the-pipelex-runner-executes-a-run)).

Both options then offer to set the runner as the default.

**Examples:**

```bash
# Initialize the API runner (enter URL and key interactively)
mthds runner setup api

# Initialize the pipelex runner (install + pipelex init)
mthds runner setup pipelex
```

### `mthds runner set-default`

Change the default runner without running any initialization.

```bash
mthds runner set-default <name>
```

| Argument | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Runner name (`api` or `pipelex`) |

**Examples:**

```bash
mthds runner set-default pipelex
mthds runner set-default api
```

### `mthds runner status`

Show the current runner configuration: default runner, API base URL, masked API key, and pipelex version.

```bash
mthds runner status
```

**Example output:**

```
Default runner: pipelex

  API runner
    Base URL: http://127.0.0.1:8081
    API key:  test-*******

  Pipelex runner
    Version: pipelex 0.18.0b4
```

---

## Telemetry

Manage anonymous usage telemetry. Telemetry can also be controlled via the `DISABLE_TELEMETRY=1` environment variable, which takes precedence over the config file.

### `mthds telemetry enable`

```bash
mthds telemetry enable
```

### `mthds telemetry disable`

```bash
mthds telemetry disable
```

### `mthds telemetry status`

Show whether telemetry is currently enabled or disabled, and its source (env, file, or default).

```bash
mthds telemetry status
```

---

## Install (JS-only)

Install method packages from the [mthds.sh](https://mthds.sh) hub or from a local directory. This command is **only available in mthds-js** and is not present in mthds-python.

### `mthds install`

```bash
mthds install [address] [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `address` | string | no | -- | GitHub repo (`org/repo`, `org/repo/sub/path`, or full `https://github.com/...` URL) |
| `--local <path>` | string | no | -- | Install from a local directory |
| `--method <name>` | string | no | -- | Install only the specified method (by name) |

You must provide either `address` or `--local`, but not both.

The install flow is interactive:
1. Resolves methods from the address or local directory
2. Displays a summary of found methods
3. Checks that the configured runner is healthy, then validates each method with it (`pipelex validate bundle` on the pipelex runner, `POST /v1/validate` on the API runner). If validation fails, the install is aborted. If the health check fails, the install goes on without validating and prints `No runner configured — skipping pipe validation`. On the pipelex runner, the health check currently always fails, because it runs `pipelex doctor -g` and `pipelex doctor` has no `-g` option, so methods are installed unvalidated.
4. Prompts for install location (local `.mthds/methods/` or global `~/.mthds/methods/`)
5. Writes method files to the selected location
6. Optionally installs the pipelex runner (only if not already installed)

**Examples:**

```bash
# Install from the hub
mthds install org/repo

# Install from a local directory
mthds install --local ./my-methods

# Install a specific method by name
mthds install org/repo --method my-method

# Install from a subpath within a repo
mthds install org/repo/methods/specific
```

---

## Publish

Publish method packages to [mthds.sh](https://mthds.sh). Sends `method_publish` telemetry for public GitHub repos. No files are written, no runner is installed.

### `mthds publish`

```bash
mthds publish [address] [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `address` | string | no | -- | GitHub repo (`org/repo` or full URL) |
| `--local <path>` | string | no | -- | Publish from a local directory |
| `--method <name>` | string | no | -- | Publish only the specified method (by name) |

You must provide either `address` or `--local`, but not both.

The publish flow is interactive:
1. Resolves methods from the address or local directory
2. Displays a summary of found methods (valid/skipped)
3. If multiple methods: lets you select which ones to publish (multiselect)
4. Sends `method_publish` telemetry (public GitHub repos only)
5. Prints success

**Examples:**

```bash
# Publish from the hub
mthds publish org/repo

# Publish from a local directory
mthds publish --local ./my-methods

# Publish a specific method
mthds publish org/repo --method my-method
```

---

## Share

Share method packages on social media. Opens browser tabs with pre-filled posts for X (Twitter), Reddit, and LinkedIn.

### `mthds share`

```bash
mthds share [address] [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `address` | string | no | -- | GitHub repo (`org/repo` or full URL) |
| `--local <path>` | string | no | -- | Share from a local directory |
| `--method <name>` | string | no | -- | Share only the specified method (by name) |

You must provide either `address` or `--local`, but not both.

The share flow is interactive:
1. Resolves methods from the address or local directory
2. If multiple methods: lets you select which ones to share (multiselect)
3. Lets you select platforms to share on (X, Reddit, LinkedIn — multiselect)
4. Opens browser tabs with pre-filled posts

**Examples:**

```bash
# Share from the hub
mthds share org/repo

# Share from a local directory
mthds share --local ./my-methods

# Share a specific method
mthds share org/repo --method my-method
```

---

## Package

Manage MTHDS packages: manifests and validation. All package commands respect the `-C, --package-dir <path>` option to target a specific directory.

### `mthds package init`

Interactively create a `METHODS.toml` manifest.

```bash
mthds package init
```

Prompts for address, version, description, authors, and license, then writes `METHODS.toml` in the target directory. If a manifest already exists, asks for confirmation before overwriting.

**Example:**

```bash
mthds package init
mthds package init -C ./my-package
```

### `mthds package validate`

Validate the `METHODS.toml` manifest.

```bash
mthds package validate
```

Checks that the manifest has valid TOML syntax and passes all validation rules: required fields (`address`, `version`, `description`), valid semver version, valid address format, snake\_case dependency aliases, snake\_case pipe names, valid domain paths, no reserved domains in exports, valid version constraints, and no unknown top-level sections.

Exits with code 1 on failure.

**Examples:**

```bash
mthds package validate
mthds package validate -C ./my-package
```

### `mthds package list`

Display the contents of `METHODS.toml`.

```bash
mthds package list
```

Shows package metadata (address, version, description, authors, license), dependencies with their version constraints, and exported domains with their pipes.

**Example:**

```bash
mthds package list
```

---

## Agent CLI (`mthds-agent`)

Machine-oriented CLI for AI agents. Output goes to stdout on success and to stderr on failure, with no interactive prompts. Native commands print structured JSON; a command forwarded to `pipelex-agent` prints what `pipelex-agent` prints, which is Markdown by default for the commands that take `--format`, and JSON with `--format json`.

A path naming a command `mthds-agent` does not register on the active runner, such as `mthds-agent concept`, fails on both runners with an `ArgumentError` (`Unknown command: concept. …`), whether it is run or asked for its help, and nothing is forwarded to `pipelex-agent`.

When the API runner refuses a call, the error envelope carries what the runner's problem document said: its `error_domain` (`input`, `config` or `runtime`) in place of the command's own, its next step as the `hint`, `retryable: true` when a retry can succeed, the `request_id` to hand to support, and, when the runner refused an invalid method (`run start` answered with a 422, for one), the bundle's `validation_errors`, each item whole with its locators and its `suggested_fix`. See [docs/errors.md → "What the CLIs print for a runner's refusal"](docs/errors.md#what-the-clis-print-for-a-runners-refusal).

### `mthds-agent runner setup pipelex`

Install the Pipelex runtime. Does **not** initialize configuration — use `mthds-agent init` for that.

```bash
mthds-agent runner setup pipelex
```

When pipelex is missing, or older than the version `mthds-agent` requires, installs or upgrades it with `uv tool install --upgrade "pipelex<constraint>"`, the constraint being that minimum version. Returns JSON indicating whether pipelex was already installed, upgraded or freshly installed.

**Example output:**

```json
{ "success": true, "already_installed": true, "message": "pipelex is already installed and up to date" }
```

### `mthds-agent runner setup api`

Set up the API runner (non-interactive).

```bash
mthds-agent runner setup api --api-key <key> [--base-url <url>]
```

| Option | Type | Required | Description |
|---|---|---|---|
| `--api-key <key>` | string | yes | API key for the Pipelex API |
| `--base-url <url>` | string | no | API base URL — host only, no version prefix (uses the hosted default if omitted) |

The key is saved as the API runner's `api-key` in `~/.mthds/config`. The pipelex runner does not read it: its hosted runs use `PIPELEX_API_KEY` from pipelex's own `.env` (see [Login](#login)).

**Examples:**

```bash
# Hosted (defaults)
mthds-agent runner setup api --api-key sk-my-api-key

# Self-hosted bare runner
mthds-agent runner setup api --api-key sk-my-api-key --base-url http://localhost:8081
```

### `mthds-agent init`

Initialize Pipelex configuration (non-interactive). Forwards to `pipelex-agent init`.

```bash
mthds-agent init [OPTIONS]
```

All options are forwarded directly to `pipelex-agent init`:

| Option | Description |
|---|---|
| `--config, -c <json>` | Inline JSON string or path to a JSON file. Schema: `{"execution": "hosted" \| "local", "backends": list[str], "primary_backend": str}`. All fields optional. Telemetry is seeded from a template, not from `--config`. |
| `--global, -g` | Force the home configuration directory (`~/.pipelex/`, or `PIPELEX_HOME`). Without this flag, targets project-level `.pipelex/`. |
| `--format <fmt>` | Success output format: `markdown` (default) or `json` |
| `--error-format <fmt>` | Failure output format: `markdown` or `json` (defaults to `--format`) |

`execution` says where runs execute by default, and `init` writes it to pipelex's `[run] execution` setting (see [Where the pipelex runner executes a run](#where-the-pipelex-runner-executes-a-run)):

- `local`, the default when `execution` is omitted, runs methods on this machine with bring-your-own-keys backends. Name the backends to enable, such as `openai`, `anthropic`, `mistral`, `google` and `openrouter`, and give each one its key in the environment or in a `.env` file (`OPENAI_API_KEY` for `openai`, `ANTHROPIC_API_KEY` for `anthropic`, and so on). `init` does not write those keys. With one backend named, it routes to that backend every model the backend supports. With two or more, `primary_backend` names the one tried first and is required. With no `backends` at all, `init` keeps the template's backends and its routing profile, which routes among every backend it enables.
- `hosted` runs methods on the hosted Pipelex API, with the Pipelex API key in `PIPELEX_API_KEY`, and configures no backend: `backends` and `primary_backend` are refused beside it with an `ArgumentError`. `init` does not get the key, since an agent cannot sign in through a browser: the user runs `mthds login` or `pipelex login` in their own terminal, or sets `PIPELEX_API_KEY`. The JSON output's `api_key_set` says whether a key was found.

The JSON output reports the `execution` written, beside the `backends_enabled` of a local setup.

**Typical agent workflow:**

```bash
# Step 1: Install pipelex if needed
mthds-agent runner setup pipelex

# Step 2: Initialize configuration on one backend, here OpenAI, whose one key covers every default model
mthds-agent init --config '{"backends": ["openai"]}'

# Step 2 (global variant, several backends, OpenAI tried first):
mthds-agent init -g --config '{"backends": ["openai", "anthropic", "mistral"], "primary_backend": "openai"}'

# Step 2 (global variant, keeping the template's backends and routing profile):
mthds-agent init -g

# Step 2 (global variant, runs on the hosted Pipelex API; the user then runs `mthds login`):
mthds-agent init -g --config '{"execution": "hosted"}'
```

### `mthds-agent publish`

Publish methods to mthds.sh (non-interactive). Sends `method_publish` telemetry for public GitHub repos. No files are written.

```bash
mthds-agent publish [address] [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `address` | string | no | -- | GitHub repo (`org/repo` or full URL) |
| `--local <path>` | string | no | -- | Publish from a local directory |
| `--method <name>` | string | no | -- | Publish only the specified method (by name) |

**Example output:**

```json
{
  "success": true,
  "published_methods": ["contract-analysis"],
  "address": "mthds-ai/contract-analysis"
}
```

**Examples:**

```bash
mthds-agent publish org/repo
mthds-agent publish --local ./my-methods
mthds-agent publish org/repo --method my-method
```

### `mthds-agent share`

Get social media share URLs for a method package (non-interactive). Returns pre-filled URLs for X (Twitter), Reddit, and LinkedIn. Use `--platform` to select specific platforms.

```bash
mthds-agent share [address] [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `address` | string | no | -- | GitHub repo (`org/repo` or full URL) |
| `--local <path>` | string | no | -- | Share from a local directory |
| `--method <name>` | string | no | -- | Share only the specified method (by name) |
| `--platform <name>` | string | no | all | Platform to share on (`x`, `reddit`, `linkedin`). Can be repeated for multiple platforms. |

**Example output:**

```json
{
  "success": true,
  "methods": ["contract-analysis"],
  "address": "mthds-ai/contract-analysis",
  "share_urls": {
    "x": "https://twitter.com/intent/tweet?text=...",
    "reddit": "https://www.reddit.com/submit?type=TEXT&title=...&text=...",
    "linkedin": "https://www.linkedin.com/feed/?shareActive=true&text=..."
  }
}
```

**Examples:**

```bash
# Get all share URLs
mthds-agent share org/repo

# Get only X and LinkedIn URLs
mthds-agent share org/repo --platform x --platform linkedin

# Share a specific method on Reddit
mthds-agent share org/repo --method my-method --platform reddit

# Share from a local directory
mthds-agent share --local ./my-methods --platform x
```

### `mthds-agent run method|pipe|bundle`

Execute a pipeline via the pipelex runner. All three subcommands are passthroughs that forward every argument to `pipelex-agent run`, except `--runner`, which `mthds-agent` keeps for itself, so the options are `pipelex-agent run`'s own, and `pipelex-agent run bundle <target> --help` lists them all. On the API runner, `run method` answers `UnsupportedError`, `run pipe` and `run bundle` do not exist, and `run start` submits a run and returns its id.

```bash
mthds-agent run method <name> [OPTIONS]
mthds-agent run pipe <pipe_code> [OPTIONS]
mthds-agent run bundle <target> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` (`method`) | string | yes | -- | Installed method name, method address (`github.com/<owner>/<repo>[/<name>][@<tag>]`) or GitHub URL; on a hosted run, also a catalog id (`mt_…`) |
| `pipe_code` (`pipe`) | string | yes | -- | Pipe code to run |
| `target` (`bundle`) | string | yes | -- | `.mthds` bundle file or method directory |
| `--pipe <code>` | string | no | -- | Pipe code (overrides the method's or bundle's main_pipe; `method` and `bundle` only) |
| `-i, --inputs <file\|json>` | string | no | -- | Path to a JSON inputs file, or inline JSON |
| `-L, --library-dir <dir>` | path, repeatable | no | -- | Directory to search for `.mthds` files |
| `--dry-run` | flag | no | -- | Run without inference calls; on this machine only |
| `--mock-inputs` | flag | no | -- | Generate mock data for missing required inputs (requires `--dry-run`); on this machine only |
| `--with-memory` | flag | no | -- | Print the whole working memory beside the main output |
| `--graph` / `--no-graph` | flag | no | `--graph` | Write the execution graph next to the output |
| `--costs` / `--no-costs` | flag | no | `--costs` | Emit usage (cost) tracing events |
| `--format <fmt>` | string | no | `markdown` | Success output format: `markdown` or `json` |
| `--error-format <fmt>` | string | no | `--format` | Failure output format: `markdown` or `json` |
| `--hosted` / `--local` | flag | no | pipelex's `[run] execution`, else local | Run on the hosted Pipelex API, with the key in `PIPELEX_API_KEY`, or on this machine |
| `--base-url <url>` | string | no | `https://api.pipelex.com` | Origin of the hosted API a hosted run calls (overrides `PIPELEX_BASE_URL`); refused on a local run |

`pipelex-agent run` also takes `--runner local|hosted`, but that option cannot pass through `mthds-agent`, which reads `--runner` as its own runner choice and refuses `--runner hosted` or `--runner local` with `Unknown runner`. Choose where pipelex executes a run with `--hosted` or `--local`, which pass through unchanged.

A run that executes on the hosted API refuses `--dry-run` and `--mock-inputs` with an `ArgumentError`: pass `--local` to dry-run on this machine. It writes nothing to disk, and with `--with-memory` its output carries the run's `pipeline_run_id` on the hosted API, with empty `markdown` and `html` renderings of the main output. If no Pipelex API key is set, or the hosted API refuses it, the run fails and the error's hint says to run `pipelex login`, which the user does in their own terminal. `mthds-agent doctor` does not check any of this: on the pipelex runner it reports a healthy setup whether or not runs execute hosted and a key is set. Run `pipelex-agent doctor` directly for that: it reports the `execution` and, for a hosted setup, a `pipelex_api_key` check.

**Examples:**

```bash
mthds-agent run method my_method
mthds-agent run pipe my_pipe_code --inputs inputs.json
mthds-agent run bundle ./bundle.mthds --pipe my_pipe

# Dry run on this machine, whatever pipelex's default execution
mthds-agent run bundle ./my_method/ --dry-run --mock-inputs --local

# Run on the hosted Pipelex API
mthds-agent run bundle ./my_method/ --inputs inputs.json --hosted
```

### `mthds-agent validate bundle`

Validate a method bundle: a `.mthds` file, a directory, or inline content.

```bash
mthds-agent validate bundle [target] [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `target` | string | unless `--content` | -- | `.mthds` bundle file or directory |
| `--content <mthds>` | string | no | -- | Bundle content as a string, in place of `target` |
| `-L, --library-dir <dir>` | path, repeatable | no | -- | Directory whose `.mthds` files join the bundle; may be written before or after the subcommand |
| `--allow-signatures` | flag | no | -- | Tolerate unimplemented pipe signatures |
| `--format <fmt>` | string | no | `markdown` | Success output format: `markdown` or `json` |
| `--error-format <fmt>` | string | no | `--format` | Failure output format: `markdown` or `json` |
| `--pipe <code>` | string | no | -- | Pipe code to validate within the bundle (pipelex runner only) |
| `-g, --graph`, `-f, --graph-format <fmt>`, `--view`, `--direction <dir>` | | no | -- | Draw the method's graph (pipelex runner only) |

With the **pipelex runner**, every argument is forwarded to `pipelex-agent validate bundle`.

With the **API runner**, the command posts the whole bundle to `POST /v1/validate`, the way the pipelex runner loads it, so a method split across several `.mthds` files validates there too:

- a directory target sends every `.mthds` file under it, its entry file first, chosen as the pipelex runner chooses it: `bundle.mthds` at its root, else the only `.mthds` file there. A directory with several root files and no `bundle.mthds`, or none at its root, is refused, as it is by the pipelex runner;
- a `.mthds` file target sends that file first, and its sibling files only through `-L`, as on the pipelex runner;
- each `-L` directory adds every `.mthds` file under it, and a file reached twice, as in `validate bundle <file> -L <its dir>/`, is sent once;
- a directory walk skips the folders pipelex's library scan skips (`venv/`, `.venv/`, `env/`, `virtualenv/`, `results/`, `node_modules/`, `.git/` and the Python caches), so a virtual environment holding pipelex's own `.mthds` files is never sent, and it skips a folder you may not list, as pipelex does;
- each file is named by its path, so a diagnostic's `source` says which file it is about.

The graph options are not applied, because the graph is drawn locally by the pipelex runner. The bundle is still validated, and after a valid verdict a warning on stderr (`{"warning": true, "message": …}`) names the options that were not applied; the JSON verdict (`--format json`) carries the method's graph as `graph_spec`. `--pipe` is ignored, since the runner validates every pipe it receives. A target that is neither a `.mthds` file nor a directory whose entry file can be chosen is an `ArgumentError`, and an unreadable file, target directory or `-L` directory is an `IOError`.

`validate pipe <file>`, `inputs bundle` and `inputs pipe` send the same closure on the API runner, and take `-L` in the same two positions. When the closure holds several files, the template is for the entry's own `main_pipe` (the named file's, or the directory's entry file's) unless `--pipe` says otherwise, which is the pipe the pipelex runner templates.

**Examples:**

```bash
mthds-agent validate bundle ./my_method/
mthds-agent validate bundle ./my_method/child.mthds -L ./my_method/ --allow-signatures
mthds-agent validate bundle ./bundle.mthds --pipe my_pipe
```

### `mthds-agent inputs bundle|pipe|method`

Generate an example inputs template for a pipe: the fill-in document a person or an agent completes and hands back as the pipe's inputs.

```bash
mthds-agent inputs bundle [target] [OPTIONS]
mthds-agent inputs pipe <target> [OPTIONS]
mthds-agent inputs method <target> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `target` | string | see below | -- | A `.mthds` bundle file or a method directory (`bundle`), a `.mthds` bundle file (`pipe`), or a method (`method`) |
| `--pipe <ref>` | string | no | the method's entry pipe | Qualified pipe ref (`domain.pipe_code`) |
| `--content <mthds>` | string | no | -- | Bundle content as a string, in place of a file (`bundle` only) |
| `-L, --library-dir <dir>` | string | no | -- | Library directory whose `.mthds` files join the bundle, repeatable (`bundle`, `pipe`) |
| `--format <fmt>` | string | no | `json` | `json` prints the result envelope; `toml` prints the raw TOML template on stdout |
| `--explicit` | flag | no | -- | Keep the `{concept, content}` envelope on every input instead of the light values |

With the **API runner**, the command reads the pipe's input form from `POST /v1/pipe-io` and projects the template locally with the `mthds` package's projection, whose TOML output `mthds-python` reproduces byte for byte. `bundle` and `pipe` send the bundle's whole closure, as `validate bundle` does above, and pick the entry's own `main_pipe` when `--pipe` is omitted and the closure holds several files. The `method` target is a published method's address (`github.com/<owner>/<repo>[/<selector>][@<tag>]`), which the runner fetches, or a hosted catalog id (`mt_…`), which only a hosted API resolves; a bare name or a local path is refused with an `ArgumentError`. With the **pipelex runner**, every subcommand forwards to `pipelex-agent inputs`, where the `method` target is an installed method's name.

The JSON output is `{ "success": true, "pipe_ref": "<domain.pipe_code>", "inputs": { … } }`, where `pipe_ref` is the pipe the runner resolved. A pipe that declares no inputs prints `inputs: {}`, or a TOML comment saying so.

Failures print the JSON error envelope on stderr and exit 1:

- a `--pipe` the method does not declare, or no `--pipe` when the method declares no entry pipe or several, is an `ArgumentError` carrying the runner's message, which lists the candidates (against `pipelex-api` v0.33.1 or later; an older runner's refusal is a `RunnerError`);
- an invalid method is a `ValidateBundleError` carrying `is_valid: false` and `validation_errors`, as on `validate`;
- any other refusal from the runner, or a runner that cannot be reached, is a `RunnerError`.

**Examples:**

```bash
mthds-agent --runner api inputs bundle ./bundle.mthds --pipe my_domain.my_pipe
mthds-agent --runner api inputs pipe ./bundle.mthds --format toml --explicit
mthds-agent --runner api inputs bundle ./my_method/child.mthds -L ./my_method/
mthds-agent --runner api inputs method github.com/Pipelex/methods/documents@v0.1.0
```

### `mthds-agent codegen types|check`

Codegen passthrough via the pipelex runner: `types` projects the resolved method library (the normalized crate) into typed artifacts for a target flavor, `check` verifies generated artifacts are current offline (pure hashing over `codegen.lock` — no engine, no API key).

```bash
mthds-agent codegen types [paths...] --target <flavor> [OPTIONS]
mthds-agent codegen check [root] [OPTIONS]
```

All arguments are forwarded to `pipelex-agent codegen`; the output contract (two-stream `--format` / `--error-format` markdown|json envelopes, `0/1/2` verdict exit codes) is defined there. Requires the pipelex runner. `codegen` shipped in pipelex 0.39.0, below the version floor mthds-agent already enforces on `pipelex-agent`, so an install old enough to lack it is upgraded or refused with an `InstallError` before the command is forwarded. On the API runner the commands error cleanly as `UnsupportedError` — there are no codegen routes yet.

**Example:**

```bash
mthds-agent codegen types ./my_pipes/ --target python-pydantic -o ./generated/
mthds-agent codegen check ./generated/ --format json
```
