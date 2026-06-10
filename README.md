# mthds

CLI and SDK for **methods** — reusable workflows for AI coding agents.

The MTHDS open standard is defined at [mthds.ai](https://mthds.ai/latest/). Browse and discover public methods on the hub at [mthds.sh](https://mthds.sh).

## What is a method?

A method is a packaged workflow that an AI agent (like Claude Code) can use. Methods are stored in a registry and installed locally via their unique name.

## Quick Start

1. Browse methods on the hub at [mthds.sh](https://mthds.sh)

2. Install a method:
```bash
mthds install org/repo --method my-method
```

3. Install a runner to execute methods. [Pipelex](https://github.com/Pipelex/pipelex) is the reference runner (Python):
```bash
mthds runner setup pipelex
```

4. Run a method:
```bash
mthds run method my-method
```

For the full CLI reference, see [CLI.md](./CLI.md).

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
3. If `--method <name>` is provided, install only that method (errors if name not found)
4. Ask where to install — **local** (current project) or **global** (your machine)
5. Optionally install a [runner](#runners)
6. Copy all `.mthds` files to `.mthds/methods/<name>/`

You can also install from a local directory:

```bash
npx mthds install --local /path/to/repo
```

### Install locations

| Location | Path |
|----------|------|
| Local | `<cwd>/.mthds/methods/<name>/` |
| Global | `~/.mthds/methods/<name>/` |

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

1. The repository must be **public** on GitHub. You can use `org/repo-name`, `user-name/repo-name`, or the full URL `https://github.com/org/repo-name`
2. The repository must contain a `methods/` folder at its root
3. Inside `methods/`, each subfolder is a **method package**
4. Each method package folder must contain a `METHODS.toml` file that follows the [manifest specification](https://mthds.ai/latest/packages/manifest/)
5. Each method package folder should contain one or more `.mthds` files (the actual method definitions)

### METHODS.toml

The `METHODS.toml` manifest is validated during installation. A minimal valid manifest:

```toml
[package]
name = "your-method"
address = "github.com/your-org/your-repo"
version = "1.0.0"
description = "A short description of what this method does"
```

Optional fields: `display_name`, `authors`, `license`, `mthds_version`.

See the full specification at [mthds.ai/latest/packages/manifest](https://mthds.ai/latest/packages/manifest/).

### Validation

The CLI validates everything during install:

- `METHODS.toml` must parse as valid TOML
- `[package]` section with `name`, `address`, `version` (semver), and `description` are required
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

This prompts for the runner URL, an optional platform URL, and an API key (masked input), and saves them to `~/.mthds/config`.

The runner targets two surfaces, each addressed by its own base URL **including its version prefix**:

- **`runnerUrl` (required)** — the stateless execution engine. Hosted: `https://api.pipelex.com/runner/v1`. Self-hosted: `http://<host>/api/v1`.
- **`platformUrl` (optional)** — the durable run lifecycle (start/status/result/poll). Hosted: `https://api.pipelex.com/platform/v1`. Leave it unset for a self-hosted runner with no run store — `run pipe` then uses the runner's blocking `/pipeline/execute`, and durable run commands report a clear hosted-only error.

You can also set values directly:

```bash
mthds config set api-key YOUR_KEY
# Hosted (default):
mthds config set runner-url https://api.pipelex.com/runner/v1
mthds config set platform-url https://api.pipelex.com/platform/v1
# Self-hosted runner (no platform):
mthds config set runner-url http://localhost:8081/api/v1
```

Configuration is stored in `~/.mthds/config` and shared between mthds-js and mthds-python.

You can also use environment variables (`PIPELEX_API_KEY`, `PIPELEX_RUNNER_URL`, `PIPELEX_PLATFORM_URL`) which take precedence over the config file.

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
  runnerBaseUrl: "https://api.pipelex.com/runner/v1",
  platformBaseUrl: "https://api.pipelex.com/platform/v1",
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

Each base URL includes its version prefix (`/runner/v1`, `/platform/v1`). Runner endpoints are appended to `runnerBaseUrl` (e.g. `<runnerBaseUrl>/pipeline/execute`); `/health` resolves to the runner's origin root.

### Self-hosted API

Point the client at your own [pipelex-api](https://github.com/Pipelex/pipelex-api) instance. The open-source runner is stateless and has no run store, so omit `platformBaseUrl` — durable run-lifecycle methods (`startRun`/`getRun`/`getResult`/`waitForResult`) then throw a clear hosted-only error, and `executePipeline` runs the blocking `/pipeline/execute`:

```typescript
const client = new MthdsApiClient({
  runnerBaseUrl: "http://localhost:8081/api/v1",
  apiToken: "your-api-key",
});
```

> Note: the self-hosted `executePipeline` returns the runner's native `pipe_output`, whereas the hosted durable path returns `main_stuff` + `graph_spec`. Cross-shape normalization is a v1 TODO.

### Environment variables

Instead of passing options to the constructor, you can set environment variables:

| Variable | Description |
|----------|-------------|
| `PIPELEX_RUNNER_URL` | Runner base URL, incl. version prefix (required) |
| `PIPELEX_PLATFORM_URL` | Platform base URL, incl. version prefix (optional) |
| `PIPELEX_API_KEY` | API authentication token |

```typescript
// Reads PIPELEX_RUNNER_URL, PIPELEX_PLATFORM_URL and PIPELEX_API_KEY from the environment
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

Anonymous usage data is collected to help rank methods on the leaderboard. Each `install` event includes the package address, name, version, and manifest metadata. No personal or device information is collected.

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
