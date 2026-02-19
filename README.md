# mthds

CLI and SDK for **methods** — reusable workflows for AI coding agents.

The MTHDS open standard is defined at [mthds.ai](https://mthds.ai). Browse and discover public methods on the hub at [mthds.sh](https://mthds.sh).

## What is a method?

A method is a packaged workflow that an AI agent (like Claude Code) can use. Methods are stored in a registry and installed locally via their unique slug.

## CLI Usage

### Install a method

```bash
npx mthds install <slug>
```

The CLI will:

1. Look up the method in the registry
2. Ask which AI agent to install it for (Claude Code, with more coming soon)
3. Ask where to install — **local** (current project) or **global** (your machine)
4. Optionally install a [runner](#runners)
5. Write the method to `.claude/methods/<slug>/METHOD.mthds`

### Install locations

| Location | Path |
|----------|------|
| Local | `<cwd>/.claude/methods/<slug>/` |
| Global | `~/.claude/methods/<slug>/` |

## Runners

To execute a method, you need a **runner**. A runner is the engine that takes a method definition and actually runs it.

### Available runners

| Runner | Description |
|--------|-------------|
| **Pipelex** (local) | A Python-based runner you install on your machine. Install it with `npx mthds setup runner pipelex`. |
| **Pipelex API** (remote) | An API server that runs methods remotely. You can self-host it using [pipelex-api](https://github.com/Pipelex/pipelex-api) (open source). A public hosted API at `https://api.pipelex.com` is coming soon. |

These are the only runners that exist today. Feel free to create your own runner in a different language!

### Install the local runner

```bash
npx mthds setup runner pipelex
```

### Use the API runner

See the [SDK Usage](#sdk-usage) section below to connect to a Pipelex API instance.

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
| `MTHDS_API_BASE_URL` | Base URL of the API |
| `MTHDS_API_KEY` | API authentication token |

```typescript
// Reads MTHDS_API_BASE_URL and MTHDS_API_KEY from the environment
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

Anonymous usage data (method slug + timestamp) is collected to help rank methods on the leaderboard. No personal or device information is collected.

To opt out:

```bash
DISABLE_TELEMETRY=1 npx mthds install <slug>
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
