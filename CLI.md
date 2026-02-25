# MTHDS CLI Reference (JavaScript)

Command-line interface for the [mthds.ai](https://mthds.ai) open standard. Install methods, execute pipelines, and manage configuration.

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
# Install a method from the hub
mthds install org/repo

# Run a pipeline
mthds run my_pipe_code

# Set up the API runner (interactive)
mthds setup runner api

# Set up the pipelex runner (local)
mthds setup runner pipelex
```

## Global Options

| Option | Description |
|---|---|
| `--runner <type>` | Runner to use for the command (`api` or `pipelex`). Applies to `run`, `validate`, and `build` subcommands. |
| `-d, --directory <path>` | Target package directory (defaults to current directory). Applies to `run`, `validate`, `build`, and `package` subcommands. |
| `--version` | Print the CLI version |
| `--help` | Show help for any command |

When `--runner` is omitted, the CLI uses the runner configured via `mthds config set runner <name>` (default: `api`).

## Runner Passthrough

When using the **pipelex** runner, the `run`, `build`, and `validate` commands act as thin wrappers: they forward all arguments directly to the `pipelex` CLI. This means any pipelex-specific flags (e.g. `--dry-run`, `--mock-inputs`, `--output-dir`) are passed through transparently.

The `--runner` and `-d/--directory` flags are consumed by mthds and not forwarded.

---

## Run

Execute a pipeline via a runner.

### `mthds run`

```bash
mthds run <target> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `target` | string | yes | -- | Pipe code or `.mthds` bundle file |
| `--pipe <code>` | string | no | -- | Pipe code (when target is a bundle) |
| `-i, --inputs <file>` | string | no | -- | Path to JSON inputs file |
| `-o, --output <file>` | string | no | -- | Path to save output JSON |
| `--no-output` | flag | no | -- | Skip saving output to file |
| `--no-pretty-print` | flag | no | -- | Skip pretty printing the output |

With the pipelex runner, additional flags like `--dry-run`, `--mock-inputs`, and `--output-dir` are passed through to pipelex.

**Examples:**

```bash
# Run by pipe code
mthds run my_pipe_code

# Run a .mthds bundle file
mthds run ./bundle.mthds --pipe my_pipe

# Run with inputs and save output
mthds run my_pipe_code --inputs inputs.json --output result.json

# Run with a specific runner
mthds run my_pipe_code --runner pipelex

# Dry run via pipelex
mthds run ./bundle.mthds --inputs inputs.json --dry-run
```

---

## Validate

Validate a bundle via a runner.

### `mthds validate`

```bash
mthds validate <target> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `target` | string | yes | -- | `.mthds` bundle file or pipe code |
| `--pipe <code>` | string | no | -- | Pipe code that must exist in the bundle |
| `--bundle <file>` | string | no | -- | Bundle file path (alternative to positional) |

The target must be a `.mthds` bundle file (either as the positional argument or via `--bundle`).

**Examples:**

```bash
# Validate a bundle file
mthds validate ./bundle.mthds

# Validate a specific pipe within a bundle
mthds validate ./bundle.mthds --pipe my_pipe

# Validate using --bundle flag
mthds validate my_pipe --bundle ./bundle.mthds

# Validate with a specific runner
mthds validate ./bundle.mthds --runner pipelex
```

---

## Build

Generate pipelines, runner code, inputs, and output schemas. Build operations delegate to a runner.

With the pipelex runner, all build subcommands pass arguments through to the `pipelex build` CLI directly.

### `mthds build pipe`

Build a pipeline from a natural-language prompt.

```bash
mthds build pipe <brief> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `brief` | string | yes | -- | Natural-language description of the pipeline |
| `-o, --output <file>` | string | no | -- | Path to save the generated `.mthds` file |

**Examples:**

```bash
# Build a pipeline and print to stdout
mthds build pipe "Extract key facts from a news article"

# Build and save to file
mthds build pipe "Summarize a document" --output summary.mthds
```

### `mthds build runner`

Generate Python runner code for a pipe.

```bash
mthds build runner <target> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `target` | string | yes | -- | Bundle file path |
| `--pipe <code>` | string | no | -- | Pipe code to generate runner for (required for API runner) |
| `-o, --output <file>` | string | no | -- | Path to save the generated Python file |

**Examples:**

```bash
# Generate runner code for a pipe in a bundle
mthds build runner ./bundle.mthds --pipe my_pipe

# Save to file
mthds build runner ./bundle.mthds --pipe my_pipe --output runner.py
```

### `mthds build inputs`

Generate example input JSON for a pipe.

```bash
mthds build inputs <target> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `target` | string | yes | -- | Bundle file path |
| `--pipe <code>` | string | no | -- | Pipe code to generate inputs for (required for API runner) |

**Example:**

```bash
mthds build inputs ./bundle.mthds --pipe my_pipe
```

### `mthds build output`

Generate output representation for a pipe.

```bash
mthds build output <target> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `target` | string | yes | -- | Bundle file path |
| `--pipe <code>` | string | no | -- | Pipe code to generate output for (required for API runner) |
| `--format <format>` | string | no | `schema` | Output format: `json`, `python`, or `schema` |

**Example:**

```bash
mthds build output ./bundle.mthds --pipe my_pipe --format json
```

---

## Config

Manage configuration stored in `~/.mthds/credentials`.

Configuration values are resolved in this order: **environment variables > credentials file > defaults**.

### Valid Configuration Keys

| Key | Environment Variable | Default | Description |
|---|---|---|---|
| `runner` | `MTHDS_RUNNER` | `api` | Default runner (`api` or `pipelex`) |
| `api-url` | `PIPELEX_API_URL` | `https://api.pipelex.com` | MTHDS API base URL |
| `api-key` | `PIPELEX_API_KEY` | (empty) | API authentication key |
| `telemetry` | `DISABLE_TELEMETRY` | `0` | Set to `1` to disable telemetry |

### `mthds config set`

Set a config value.

```bash
mthds config set <key> <value>
```

| Argument | Type | Required | Description |
|---|---|---|---|
| `key` | string | yes | Config key (`runner`, `api-url`, `api-key`, `telemetry`) |
| `value` | string | yes | Value to set |

Validates the value before saving: `runner` must be `api` or `pipelex`, `api-url` must be a valid URL.

**Examples:**

```bash
mthds config set api-key sk-my-api-key
mthds config set runner pipelex
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
# runner = api (default)
```

### `mthds config list`

List all config values.

```bash
mthds config list
```

Displays all configuration keys with their current values and sources (env, file, or default).

---

## Setup

Initialize and configure runners.

### `mthds setup runner`

Initialize a runner and optionally set it as the default.

```bash
mthds setup runner <name>
```

| Argument | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Runner name (`api` or `pipelex`) |

**For `api`:** interactively prompts for the API URL and API key (masked input), then saves them to `~/.mthds/credentials`.

**For `pipelex`:** installs the pipelex CLI if not already present, then runs `pipelex init` (interactive configuration for backends, credentials, routing, etc.).

Both options then offer to set the runner as the default.

**Examples:**

```bash
# Initialize the API runner (enter URL and key interactively)
mthds setup runner api

# Initialize the pipelex runner (install + pipelex init)
mthds setup runner pipelex
```

---

## Set Default

Change the default runner without running any initialization.

### `mthds set-default runner`

```bash
mthds set-default runner <name>
```

| Argument | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Runner name (`api` or `pipelex`) |

**Examples:**

```bash
mthds set-default runner pipelex
mthds set-default runner api
```

---

## Runner Status

Show the current runner configuration: default runner, API URL, masked API key, and pipelex version.

### `mthds runner status`

```bash
mthds runner status
```

**Example output:**

```
Default runner: pipelex

  API runner
    URL:     http://127.0.0.1:8081
    API key: test-*******

  Pipelex runner
    Version: pipelex 0.18.0b4
```

---

## Telemetry

Manage anonymous usage telemetry. Telemetry can also be controlled via the `DISABLE_TELEMETRY=1` environment variable, which takes precedence over the credentials file.

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
| `address` | string | no | -- | Package address (`org/repo` or `org/repo/sub/path`) |
| `--local <path>` | string | no | -- | Install from a local directory |
| `--method <slug>` | string | no | -- | Install only the specified method (by slug) |

You must provide either `address` or `--local`, but not both.

The install flow is interactive:
1. Resolves methods from the address or local directory
2. Prompts you to select an AI agent to install the methods for
3. Prompts for install location (local `.claude/methods/` or global `~/.claude/methods/`)
4. Optionally installs the pipelex runner
5. Optionally installs pipelex skills (check, edit, build, fix)

**Examples:**

```bash
# Install from the hub
mthds install org/repo

# Install from a local directory
mthds install --local ./my-methods

# Install a specific method by slug
mthds install org/repo --method my-method

# Install from a subpath within a repo
mthds install org/repo/methods/specific
```

---

## Package

Manage MTHDS packages: manifests, dependencies, lock files, and installation. All package commands respect the `-d, --directory <path>` global option to target a specific directory.

### `mthds package init`

Interactively create a `METHODS.toml` manifest.

```bash
mthds package init
```

Prompts for address, version, description, authors, and license, then writes `METHODS.toml` in the target directory. If a manifest already exists, asks for confirmation before overwriting.

**Example:**

```bash
mthds package init
mthds package init -d ./my-package
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
mthds package validate -d ./my-package
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

### `mthds package add`

Add a dependency to `METHODS.toml`.

```bash
mthds package add <dep> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `dep` | string | yes | -- | Dependency address (e.g. `github.com/org/repo`) |
| `--alias <alias>` | string | no | derived from address | snake\_case alias for the dependency |
| `--version <constraint>` | string | no | `*` | Version constraint (e.g. `^1.0.0`, `>=2.0.0`) |
| `--path <path>` | string | no | -- | Local path for development (relative to package directory) |

If `--alias` is omitted, the alias is derived from the last segment of the address (hyphens converted to underscores).

When `--path` is provided, the dependency is resolved from the local filesystem instead of being fetched from git. This is useful for developing multiple packages side by side. Local dependencies are excluded from `methods.lock`.

**Examples:**

```bash
# Add a remote dependency
mthds package add github.com/mthds/document-processing --version "^1.0.0"

# Add with explicit alias
mthds package add github.com/mthds/scoring-lib --alias scoring --version ">=0.5.0"

# Add a local dependency for development
mthds package add github.com/mthds/scoring-lib --path ../scoring-lib --version "^1.0.0"
```

### `mthds package lock`

Resolve all dependencies and generate `methods.lock`.

```bash
mthds package lock
```

Reads `METHODS.toml`, resolves all remote dependencies transitively (with cycle detection and diamond constraint handling via Minimum Version Selection), and writes `methods.lock` with pinned versions and SHA-256 integrity hashes.

Local path dependencies are resolved directly but excluded from the lock file.

**Example:**

```bash
mthds package lock
```

### `mthds package install`

Install dependencies from `methods.lock`.

```bash
mthds package install
```

Reads `methods.lock`, fetches any packages not already in the local cache (`~/.mthds/packages/`), and verifies integrity of all cached packages against their lock file hashes.

**Example:**

```bash
mthds package install
```

### `mthds package update`

Re-resolve all dependencies and regenerate `methods.lock`.

```bash
mthds package update
```

Like `mthds package lock`, but ignores the existing lock file and resolves all dependencies from scratch. Use this to pick up new versions within your constraint ranges.

**Example:**

```bash
mthds package update
```
