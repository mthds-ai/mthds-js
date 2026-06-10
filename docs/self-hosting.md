# Self-hosting the runner

mthds-js targets either the hosted Pipelex API or a runner you boot yourself ([pipelex-api](https://github.com/Pipelex/pipelex-api), open source). The same SDK and CLI drive both — the only difference is configuration.

## Two base URLs

The SDK addresses two surfaces, each by its own base URL that **already includes its version prefix**:

| Config key | Env var | Surface | Required |
|---|---|---|---|
| `runnerUrl` | `PIPELEX_RUNNER_URL` | Stateless execution engine — `/pipeline/execute`, `/pipeline/start`, `/validate`, `/build/*`, `/models`, `/pipelex_version` | yes |
| `platformUrl` | `PIPELEX_PLATFORM_URL` | Durable run lifecycle — `/runs`, `/runs/by-id/{id}`, `/runs/by-id/{id}/result` | no |

Endpoints are appended to the base **without re-adding a version prefix**: `executePipeline` hits `<runnerUrl>/pipeline/execute`. `/health` is the exception — it is origin-level, so it resolves to the runner's origin root (`<scheme>://<host>/health`), not under the version prefix.

## Hosted (default)

```bash
mthds config set runner api          # use the HTTP runner (default is the local `pipelex` passthrough)
mthds config set runner-url https://api.pipelex.com/runner/v1
mthds config set platform-url https://api.pipelex.com/platform/v1
mthds config set api-key YOUR_KEY
```

`run pipe` starts a durable run on the platform and polls it to completion (survives long runs); `run start` / `run status` / `run result` / `run poll` drive the run lifecycle by id.

## Self-hosted (runner only, no platform)

The open-source runner is stateless and has no run store. The runner's standard prefix is `/api/v1`.

```bash
mthds config set runner api          # use the HTTP runner
mthds config set runner-url http://localhost:8081/api/v1
# do NOT set platform-url
```

Pointing `runnerUrl` at a non-hosted URL **automatically disables the platform** — when you haven't explicitly set `platformUrl`, it is present only while the runner is the hosted Pipelex runner. So you never have to clear it manually, and you can't accidentally poll the hosted platform for a run that executed on your local runner. (If you previously set `platform-url` explicitly, clear it with `mthds config set platform-url ""`.)

In this mode:

- **`run pipe` / `run bundle`** → blocking `POST <runnerUrl>/pipeline/execute`. There is no hosted-gateway 30s cap off-platform — but your own reverse proxy (nginx, ALB, Cloud Run, …) typically imposes its own idle timeout (~60s). Raise it for long runs, or use the async lifecycle below.
- **`run start` / `run status` / `run result` / `run poll`** → the runner serves the async lifecycle itself (`POST <runnerUrl>/runs`, then `GET <runnerUrl>/runs/by-id/{id}` and `.../result`). The SDK drives it against the runner with no platform configured — start a run, poll by id, fetch the result. State is kept in an in-process store (no Temporal/database); it is single-process and lost on restart. The hosted Pipelex Platform is the durable, multi-tenant version of the same surface — set `platformUrl` to use it instead.

The run-lifecycle base resolves to `platformUrl` when set, otherwise to `runnerUrl`, so the same `run start`/`poll` code drives either tier.

### Output shape

The self-hosted `run pipe` returns the runner's native `pipe_output`; the hosted durable path returns `main_stuff` + `graph_spec`. For v1 this difference is documented, not normalized (TODO).

## Migrating from `apiUrl`

The single `apiUrl` / `PIPELEX_API_URL` key has been replaced by `runnerUrl` + `platformUrl`. There is no backward compatibility: if a leftover legacy `apiUrl` is detected while the api-runner needs a URL and `runnerUrl` was never set, the SDK fails fast with a migration hint. Set `runnerUrl` (and optionally `platformUrl`) as above.

## SDK

```typescript
import { MthdsApiClient } from "mthds";

// Hosted
const hosted = new MthdsApiClient({
  runnerBaseUrl: "https://api.pipelex.com/runner/v1",
  platformBaseUrl: "https://api.pipelex.com/platform/v1",
  apiToken: "your-api-key",
});

// Self-hosted (no platform store)
const selfHosted = new MthdsApiClient({
  runnerBaseUrl: "http://localhost:8081/api/v1",
  apiToken: "your-api-key",
});
```

See also the runner's own OpenAPI contract and quickstart in [pipelex-api](https://github.com/Pipelex/pipelex-api) (`docs/index.md`).
