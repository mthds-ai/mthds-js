# Self-hosting the runner

mthds-js targets either the hosted MTHDS API or a runner you boot yourself ([pipelex-api](https://github.com/Pipelex/pipelex-api), open source). The same SDK and CLI drive both — the only difference is the base URL.

## One base URL

There is a single configuration pair. The base URL is the **host only — no version prefix**; the SDK composes every endpoint as `{base}/v1/{endpoint}`:

| Config key | Env var | Default |
|---|---|---|
| `base-url` | `MTHDS_API_URL` | `https://api.pipelex.com` |
| `api-key` | `MTHDS_API_KEY` | (empty) |

`execute` hits `<base>/v1/execute`, `validate` hits `<base>/v1/validate`, and so on. `/health` is the exception — it is origin-level, so it resolves to the origin root (`<scheme>://<host>/health`), not under `/v1`.

The protocol surface (`/v1/execute`, `/v1/start`, `/v1/validate`, `/v1/models`, `/v1/version`) is identical on the hosted API and on a bare runner. Only the hosted extensions differ — the durable run lifecycle (`/v1/runs/*`) and stored methods (`method_id`) — detectable via the `GET /v1/version` handshake.

## Hosted (default)

```bash
mthds config set runner api          # use the HTTP runner (default is the local `pipelex` passthrough)
mthds config set base-url https://api.pipelex.com
mthds config set api-key YOUR_KEY
```

`run pipe` starts a durable run and polls it to completion (survives long runs); `run start` / `run status` / `run result` / `run poll` drive the run lifecycle by id.

## Self-hosted (bare runner, no run store)

The open-source runner is stateless and has no run store. It mounts the same `/v1` paths.

```bash
mthds config set runner api          # use the HTTP runner
mthds config set base-url http://localhost:8081
```

In this mode:

- **`run pipe` / `run bundle`** → blocking `POST <base>/v1/execute` (the `/v1/version` handshake reports `implementation: "pipelex-api"`, so the SDK takes the blocking path). There is no hosted-gateway 30s cap off-platform — but your own reverse proxy (nginx, ALB, Cloud Run, …) typically imposes its own idle timeout (~60s). Raise it for long runs, or use `start` with `callback_urls` (the protocol's fire-and-callback channel).
- **`run start`** → `POST <base>/v1/start` works (fire-and-callback; you may pass your own `pipeline_run_id` — a bare runner accepts it, the hosted API rejects it with 422), but **`run status` / `run result` / `run poll` do not**: the bare runner 404s `/v1/runs/*`, which the SDK surfaces as a clear `RunLifecycleUnavailableError`. The durable poll-by-id lifecycle is a hosted-API extension.

### Minimum server version

The SDK composes every endpoint under `/v1`, which requires a pipelex-api image that mounts its API at `/v1` (the MTHDS Protocol cutover) — older images mounted `/api/v1` and answer 404 on every call, including the `/v1/version` handshake itself. Upgrade your runner image before (or together with) this SDK version.

### Output shape

The self-hosted blocking `run pipe` returns the runner's native `pipe_output`; the hosted durable path returns `main_stuff` + `graph_spec`. For v1 this difference is documented, not normalized (TODO).

## Migrating from the two-URL config

`runnerUrl` / `PIPELEX_RUNNER_URL` and `platformUrl` / `PIPELEX_PLATFORM_URL` (and the older `apiUrl` / `PIPELEX_API_URL`, plus `PIPELEX_API_KEY`) are replaced by the single `MTHDS_API_URL` + `MTHDS_API_KEY` pair. There is no backward compatibility: if a leftover legacy key is detected (env or `~/.mthds/config`) while the api-runner needs a value that was never set under its new name, the SDK fails fast with a one-line migration hint. Migrate with `mthds config set base-url <host>` and `mthds config set api-key <key>`.

## SDK

```typescript
import { MthdsApiClient } from "mthds";

// Hosted
const hosted = new MthdsApiClient({
  baseUrl: "https://api.pipelex.com",
  apiToken: "your-api-key",
});

// Self-hosted (bare runner)
const selfHosted = new MthdsApiClient({
  baseUrl: "http://localhost:8081",
  apiToken: "your-api-key",
});
```

See also the runner's own OpenAPI contract and quickstart in [pipelex-api](https://github.com/Pipelex/pipelex-api) (`docs/index.md`), and the MTHDS Protocol spec (`mthds-protocol.openapi.yaml`) in the mthds standard repo.
