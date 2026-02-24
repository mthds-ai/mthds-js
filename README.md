# mthds

CLI and SDK for **methods** — reusable workflows for AI coding agents.

The MTHDS open standard is defined at [mthds.ai](https://mthds.ai). Browse and discover public methods on the hub at [mthds.sh](https://mthds.sh).

## What is a method?

A method is a packaged workflow that an AI agent (like Claude Code) can use. Methods are stored in a registry and installed locally via their unique slug.

## CLI Usage

For the full CLI reference, see [CLI.md](./CLI.md).

### Quick Start

```bash
# Set up the API runner (interactive — prompts for URL and key)
mthds setup runner api

# Or set up the pipelex runner (local)
mthds setup runner pipelex

# Run a pipeline
mthds run my_pipe_code

# Validate a bundle
mthds validate ./bundle.mthds

# Install a method from the hub
mthds install org/repo
```

### Install a method

```bash
npx mthds install org/repo-name
```

To install a single method from a multi-method repository:

```bash
npx mthds install org/repo-name --method my-method
```

The CLI will:

1. Fetch the `methods/` folder from the GitHub repository
2. Validate each method's `METHODS.toml` manifest
3. If `--method <slug>` is provided, install only that method (errors if slug not found)
4. Ask which AI agent to install it for (Claude Code, with more coming soon)
5. Ask where to install — **local** (current project) or **global** (your machine)
6. Optionally install a [runner](#runners)
7. Copy all `.mthds` files to `.claude/methods/<slug>/`

You can also install from a local directory:

```bash
npx mthds install --local /path/to/repo
```

### Install locations

| Location | Path |
|----------|------|
| Local | `<cwd>/.claude/methods/<slug>/` |
| Global | `~/.claude/methods/<slug>/` |

## Publishing a method

To make your methods installable via `npx mthds install`, you need a **public GitHub repository** with the right structure.

### Repository structure

```
org/repo-name (or user-name/repo-name)
└── methods/
    ├── my-method/
    │   ├── METHODS.toml
    │   ├── main.mthds
    │   └── helpers/
    │       └── utils.mthds
    └── another-method/
        ├── METHODS.toml
        └── pipeline.mthds
```

### Rules

1. The repository must be **public** on GitHub, with the address format `org/repo-name` or `user-name/repo-name`
2. The repository must contain a `methods/` folder at its root
3. Inside `methods/`, each subfolder is a **method package**. The folder name is the **slug** and **must be kebab-case** (e.g. `my-method`, `legal-tools`)
4. Each method package folder must contain a `METHODS.toml` file that follows the [manifest specification](https://mthds.ai/latest/packages/manifest/)
5. Each method package folder should contain one or more `.mthds` files (the actual method definitions)

### METHODS.toml

The `METHODS.toml` manifest is validated during installation. A minimal valid manifest:

```toml
[package]
address = "github.com/your-org/your-repo"
version = "1.0.0"
description = "A short description of what this method does"
```

Optional fields: `display_name`, `authors`, `license`, `mthds_version`.

See the full specification at [mthds.ai/latest/packages/manifest](https://mthds.ai/latest/packages/manifest/).

### Validation

The CLI validates everything during install:

- Slug must be kebab-case, start with a letter, max 64 characters
- `METHODS.toml` must parse as valid TOML
- `[package]` section with `address`, `version` (semver), and `description` are required
- `address` must include a hostname with a dot (e.g. `github.com/...`)
- Invalid methods are skipped with detailed error messages; valid ones proceed to install

## Runners

To execute a method, you need a **runner**. A runner is the engine that takes a method definition and actually runs it.

### Available runners

| Runner | Description |
|--------|-------------|
| **[Pipelex](https://github.com/Pipelex/pipelex)** (local) | A Python-based runner you install on your machine. Install it with `npx mthds setup runner pipelex`. |
| **Pipelex API** (remote) | An API server that runs methods remotely. You can self-host it using [pipelex-api](https://github.com/Pipelex/pipelex-api) (open source). A public hosted API at `https://api.pipelex.com` is coming soon. |

These are the only runners that exist today. Feel free to create your own runner in a different language!

### Install the local runner

```bash
npx mthds setup runner pipelex
```

### Configure the API runner

The API runner is the default. Set it up interactively:

```bash
mthds setup runner api
```

This prompts for the API URL and API key (masked input) and saves them to `~/.mthds/credentials`.

You can also set values directly:

```bash
mthds config set api-key YOUR_KEY
mthds config set api-url https://your-api-instance.com
```

Credentials are stored in `~/.mthds/credentials` and shared between mthds-js and mthds-python.

You can also use environment variables (`PIPELEX_API_KEY`, `PIPELEX_API_URL`) which take precedence over the credentials file.

See the [SDK Usage](#sdk-usage) section below to connect to a Pipelex API instance programmatically.

## SDK Usage

Install the package:

```bash
npm install mthds
```

### Basic example

```typescript
import { MthdsApiClient } from "mthds";

const client = new MthdsApiClient({
  apiBaseUrl: "https://api.pipelex.com",
  apiToken: "your-api-key",
});

const result = await client.executePipeline({
  pipe_code: "my-pipeline",
  inputs: {
    topic: "quantum computing",
  },
});

console.log(result.pipe_output);
```

### Self-hosted API

Point the client to your own [pipelex-api](https://github.com/Pipelex/pipelex-api) instance:

```typescript
const client = new MthdsApiClient({
  apiBaseUrl: "http://localhost:8081",
  apiToken: "your-api-key",
});
```

### Environment variables

Instead of passing options to the constructor, you can set environment variables:

| Variable | Description |
|----------|-------------|
| `PIPELEX_API_URL` | Base URL of the API |
| `PIPELEX_API_KEY` | API authentication token |

```typescript
// Reads PIPELEX_API_URL and PIPELEX_API_KEY from the environment
const client = new MthdsApiClient();
```

### Methods

| Method | Description |
|--------|-------------|
| `executePipeline(options)` | Execute a pipeline and wait for the result |
| `startPipeline(options)` | Start a pipeline asynchronously |

### Pipeline options

| Option | Type | Description |
|--------|------|-------------|
| `pipe_code` | `string` | Pipeline code to execute |
| `mthds_content` | `string` | Raw method content (alternative to `pipe_code`) |
| `inputs` | `Record<string, string \| string[] \| object>` | Pipeline input variables |
| `output_name` | `string` | Name of the output to return |
| `output_multiplicity` | `boolean \| number` | Expected output multiplicity |
| `dynamic_output_concept_code` | `string` | Dynamic output concept code |

Either `pipe_code` or `mthds_content` must be provided.

## Telemetry

Anonymous usage data is collected to help rank methods on the leaderboard. Each `install` event includes the package address, slug, version, and manifest metadata. No personal or device information is collected.

To opt out:

```bash
mthds telemetry disable
```

## Development

```bash
make install    # install dependencies
make check      # typecheck + build
make dev        # watch mode
make run        # build and run the CLI
make pack       # create tarball for local npx testing
```

## License

MIT
