# Self-hosting the runner

mthds-js targets either the Pipelex Hosted API or a runner you boot yourself ([OSS `pipelex-api`](https://github.com/Pipelex/pipelex-api)). The same SDK and CLI drive both — the only difference is the base URL.

## One base URL

There is a single configuration pair. The base URL is the **host only — no version prefix**; the SDK composes every endpoint as `{base}/v1/{endpoint}`:

| Config key | Env var | Default |
|---|---|---|
| `base-url` | `MTHDS_API_URL` | `https://api.pipelex.com` |
| `api-key` | `MTHDS_API_KEY` | (empty) |

`execute` hits `<base>/v1/execute`, `validate` hits `<base>/v1/validate`, and so on. `/health` is the exception — it is origin-level, so it resolves to the origin root (`<scheme>://<host>/health`), not under `/v1`.

The protocol surface (`/v1/execute`, `/v1/start`, `/v1/validate`, `/v1/models`, `/v1/version`) is identical on the Pipelex Hosted API and on a bare runner. Only the hosted extensions differ — e.g. the durable run lifecycle (`/v1/runs/*`), whose client now lives in `@pipelex/sdk` / `pipelex-agent`, not `mthds-js`.

## Hosted (default)

```bash
mthds config set runner api          # use the HTTP runner (default is the local `pipelex` passthrough)
mthds config set base-url https://api.pipelex.com
mthds config set api-key YOUR_KEY
```

`run pipe` / `run bundle` run synchronously via the blocking `POST /v1/execute`; `run start` submits a run and returns its id. The durable poll-by-id lifecycle (`run status` / `run result` / `run poll`) now lives in `@pipelex/sdk` / `pipelex-agent`.

## Self-hosted (bare runner, no run store)

The open-source runner is stateless and has no run store. It mounts the same `/v1` paths.

```bash
mthds config set runner api          # use the HTTP runner
mthds config set base-url http://localhost:8081
```

In this mode:

- **`run pipe` / `run bundle`** → blocking `POST <base>/v1/execute`. There is no hosted-gateway 30s cap off-platform — but your own reverse proxy (nginx, ALB, Cloud Run, …) typically imposes its own idle timeout (~60s). Raise it for long runs, or use `start` (completion delivery is implementation-defined — `pipelex-api` offers HMAC-signed completion webhooks via its `callback_urls` extension arg, passed through `extra`).
- **`run start`** → `POST <base>/v1/start` works (fire-and-callback; you may pass your own `pipeline_run_id` — a bare runner accepts it, the Pipelex Hosted API rejects it with 422). The durable poll-by-id lifecycle (`run status` / `run result` / `run poll`) is a Pipelex Hosted API extension and now lives in `@pipelex/sdk` / `pipelex-agent`, not `mthds-js`; against a bare runner those `/v1/runs/*` routes 404 anyway.

### Minimum server version

The SDK composes every endpoint under `/v1`, which requires a pipelex-api image that mounts its API at `/v1` (the MTHDS Protocol cutover) — older images mounted `/api/v1` and answer 404 on every call, including the `/v1/version` handshake itself. Upgrade your runner image before (or together with) this SDK version.

### Output shape

The blocking `run pipe` (`POST /v1/execute`) returns the runner's native `pipe_output`; the hosted durable path (now in `@pipelex/sdk`) returns `main_stuff` + `graph_spec`. For v1 this difference is documented, not normalized (TODO).

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
