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
mthds run pipe my_pipe_code

# Set up the API runner (interactive)
mthds runner setup api

# Set up the pipelex runner (local)
mthds runner setup pipelex
```

## Global Options

| Option | Description |
|---|---|
| `--runner <type>` | Runner to use for the command (`api` or `pipelex`). Applies to `run`, `validate`, and `build` subcommands. |
| `-L, --library-dir <dir>` | Additional library directory (can be repeated). Applies to `run`, `validate`, and `build` subcommands. |
| `--version` | Print the CLI version |
| `--help` | Show help for any command |

When `--runner` is omitted, the CLI uses the runner configured via `mthds config set runner <name>` (default: `api`).

## Runner Passthrough

When using the **pipelex** runner, the `run`, `build`, and `validate` commands act as thin wrappers: they forward all arguments directly to the `pipelex` CLI. This means any pipelex-specific flags (e.g. `--dry-run`, `--mock-inputs`, `--output-dir`) are passed through transparently.

The `--runner` flag is consumed by mthds and not forwarded. The `-L/--library-dir` flags are forwarded to pipelex.

---

## Run

Execute a pipeline via a runner.

### `mthds run method`

Run an installed method by name.

```bash
mthds run method <name> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | yes | -- | Name of the installed method |
| `--pipe <code>` | string | no | -- | Pipe code (overrides method's main_pipe) |
| `-i, --inputs <file>` | string | no | -- | Path to JSON inputs file |
| `-o, --output <file>` | string | no | -- | Path to save output JSON |
| `--no-output` | flag | no | -- | Skip saving output to file |
| `--no-pretty-print` | flag | no | -- | Skip pretty printing the output |

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

With the pipelex runner, additional flags like `--dry-run`, `--mock-inputs`, and `--output-dir` are passed through to pipelex.

**Examples:**

```bash
# Run an installed method
mthds run method my-method
mthds run method my-method -L methods/

# Run by pipe code
mthds run pipe my_pipe_code

# Run a .mthds bundle file
mthds run pipe ./bundle.mthds --pipe my_pipe

# Run with inputs and save output
mthds run pipe my_pipe_code --inputs inputs.json --output result.json

# Dry run via pipelex
mthds run pipe ./bundle.mthds --inputs inputs.json --dry-run
```

---

## Validate

Validate a method or bundle via a runner.

### `mthds validate method`

Validate an installed method by name.

```bash
mthds validate method <name> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` | string | yes | -- | Name of the installed method |
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

**Examples:**

```bash
# Validate an installed method
mthds validate method my-method
mthds validate method my-method -L methods/

# Validate a bundle file
mthds validate pipe ./bundle.mthds

# Validate a specific pipe within a bundle
mthds validate pipe ./bundle.mthds --pipe my_pipe
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

### `mthds build runner method|pipe`

Generate Python runner code for a pipe.

```bash
mthds build runner method <name> [OPTIONS]
mthds build runner pipe <target> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` / `target` | string | yes | -- | Method name or bundle file path |
| `--pipe <code>` | string | no | -- | Pipe code to generate runner for (required for API runner) |
| `-o, --output <file>` | string | no | -- | Path to save the generated Python file |

**Examples:**

```bash
mthds build runner method my-method
mthds build runner pipe ./bundle.mthds --pipe my_pipe --output runner.py
```

### `mthds build inputs method|pipe`

Generate example input JSON for a pipe.

```bash
mthds build inputs method <name> [OPTIONS]
mthds build inputs pipe <target> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` / `target` | string | yes | -- | Method name or bundle file path |
| `--pipe <code>` | string | no | -- | Pipe code to generate inputs for (required for API runner) |

**Examples:**

```bash
mthds build inputs method my-method
mthds build inputs pipe ./bundle.mthds --pipe my_pipe
```

### `mthds build output method|pipe`

Generate output representation for a pipe.

```bash
mthds build output method <name> [OPTIONS]
mthds build output pipe <target> [OPTIONS]
```

| Argument / Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `name` / `target` | string | yes | -- | Method name or bundle file path |
| `--pipe <code>` | string | no | -- | Pipe code to generate output for (required for API runner) |
| `--format <format>` | string | no | `schema` | Output format: `json`, `python`, or `schema` |

**Examples:**

```bash
mthds build output method my-method --format schema
mthds build output pipe ./bundle.mthds --pipe my_pipe --format json
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

**For `api`:** interactively prompts for the API URL and API key (masked input), then saves them to `~/.mthds/credentials`.

**For `pipelex`:** installs the pipelex CLI if not already present, then runs `pipelex init` (interactive configuration for backends, credentials, routing, etc.).

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

Show the current runner configuration: default runner, API URL, masked API key, and pipelex version.

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
| `--method <name>` | string | no | -- | Install only the specified method (by name) |

You must provide either `address` or `--local`, but not both.

The install flow is interactive:
1. Resolves methods from the address or local directory
2. Displays a summary of found methods
3. Prompts for install location (local `.mthds/methods/` or global `~/.mthds/methods/`)
4. Writes method files to the selected location
5. Optionally installs the pipelex runner
6. Optionally installs MTHDS skills (includes agent selection)

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

