# Run lifecycle (durable, poll-by-id)

Real method runs take minutes to hours. The gateway in front of the hosted MTHDS API has a hard ~30s response ceiling, so a synchronous "submit and wait for the answer in one HTTP call" is structurally impossible. mthds-js submits a run, then polls a self-healing endpoint by bare `pipeline_run_id` until the run reaches a terminal state.

Because every bit of run state lives behind the `pipeline_run_id` (DynamoDB for the immutable facts, Temporal for the live execution state), a caller — including an AI agent — can submit a run, drop the connection, and reconnect hours later with only the `pipeline_run_id` to get the true outcome.

## Protocol vs hosted extension

Everything is served from ONE base URL (`MTHDS_API_URL`, host only); the SDK composes `{base}/v1/{endpoint}`. Two distinct layers share that URL:

- **MTHDS Protocol** (`POST /v1/execute`, `POST /v1/start`, `POST /v1/validate`, `GET /v1/models`, `GET /v1/version`) — works against any MTHDS-compliant runner, hosted or bare. The protocol defines no completion channel for `start` — how completion is delivered (webhooks, polling) is implementation-defined.
- **Run-lifecycle extension** (`GET /v1/runs/{pipeline_run_id}/status`, `GET /v1/runs/{pipeline_run_id}/results`) — the durable polling surface. It is a **hosted-API feature, NOT part of the protocol**. A bare [pipelex-api](https://github.com/Pipelex/pipelex-api) runner has no run store and 404s these routes, which the SDK translates into a clear `RunLifecycleUnavailableError`.

The `GET /v1/version` handshake (`VersionInfo.implementation`) tells the SDK which deployment it is talking to.

## Server endpoints

| Method | Path | Returns |
|---|---|---|
| `POST` | `/v1/start` | `202 StartAck` — the authoritative `pipeline_run_id` (executes asynchronously) |
| `GET` | `/v1/runs/{pipeline_run_id}/status` | `RunRead` — status, self-healing (`degraded` flag + `Retry-After` when Temporal is unreachable) |
| `GET` | `/v1/runs/{pipeline_run_id}/results` | `202` still running · `200` result · `409` terminal failure |

The status read is self-healing: a run that timed out, was terminated, or whose completion callback never landed resolves to its true terminal status the moment anyone reads it — no callback required.

`status` is one of `PENDING`, `STARTED` (deprecated), `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`, `TERMINATED`, `TIMED_OUT`. Only `COMPLETED` has a result; every other terminal status is a failure (`getRunResult` returns `409`, surfaced as `RunFailedError`).

Server-specific extension args ride the generic `extra` option and merge into the request body — the server you call defines and handles them (see its API documentation). A client-supplied `pipeline_run_id` is bare-runner-only — the hosted API rejects it with 422 (the `StartAck.pipeline_run_id` is always authoritative).

## SDK — `MthdsApiClient`

```ts
import { MthdsApiClient, RunFailedError, RunTimeoutError } from "mthds";

const client = new MthdsApiClient({ baseUrl: "https://api.pipelex.com", apiToken });

// Submit (returns immediately with the authoritative run id)
const ack = await client.start({
  pipe_code: "my_pipe",              // optional — omit to use the bundle's main_pipe
  mthds_contents: [bundleContents],
  inputs: { question: "…" },
  // optional output controls (forwarded to the runner):
  // output_name, output_multiplicity, dynamic_output_concept_ref
  // server-specific extension args ride `extra` (a client-supplied run id,
  // where a server supports one, is such an extension), e.g. extra: { … }
});

// Or do the whole lifecycle in one call:
// const result = await client.startAndWait({ mthds_contents: [bundleContents], inputs: { … } });

// Poll to completion
try {
  const result = await client.waitForResult(ack.pipeline_run_id, {
    intervalMs: 2000,     // base poll interval; server Retry-After overrides when larger
    timeoutMs: 1_200_000, // give up after 20 min (the run keeps executing server-side)
    signal: abortController.signal,
    onPoll: ({ attempt, elapsedMs }) => spinner.update(`polling… (${attempt})`),
  });
  console.log(result.main_stuff, result.graph_spec);
} catch (err) {
  if (err instanceof RunFailedError) {
    // run reached a terminal non-COMPLETED status (err.status)
  } else if (err instanceof RunTimeoutError) {
    // stopped waiting; resume later with client.waitForResult(pipeline_run_id)
  }
}
```

Lower-level single-shot lookups:

- `getRunStatus(runId)` → `RunRead` (status + `degraded`).
- `getRunResult(runId)` → a discriminated `RunResultState`: `{ state: "running", retry_after_seconds }`, `{ state: "completed", result }`, or `{ state: "failed", status, message }`. A degraded `503` is treated as `running` (retry) so a poller is never failed by a transient Temporal outage.

Both throw `RunLifecycleUnavailableError` when `MTHDS_API_URL` points at a bare runner (route-absent 404, distinguished from the platform's structured run-not-found 404 by the missing `code` field).

The blocking `execute()` path may also throw `RunStillRunningError`: the protocol permits an implementation to degrade a synchronous `/execute` into `202 + StartAck` when it cannot hold the connection open. The error carries the `pipeline_run_id`, the `Retry-After` hint, and the `Location` header — resume by id.

## Runner surface

The `Runner` abstraction (what the CLI and agent use) extends `MTHDSProtocol` (execute / start / validate / models / version) with the build extensions and the durable lifecycle: two primitives — `getRunStatus(runId)`, `getRunResult(runId)` — plus two composites provided once by `BaseRunner`: `waitForResult(runId)` (poll an already-started run to completion) and `startAndWaitForResult(options)` (start, then wait — the one-call convenience). The API runner (`--runner api`) routes `startAndWaitForResult()` through the durable path when the `/v1/version` handshake reports a hosted deployment, and falls back to the blocking `POST /v1/execute` against a bare runner (which has no gateway cap off-platform and returns the native `pipe_output`). The local `pipelex` runner likewise supports only `startAndWaitForResult` (blocking, in-process).

## Agent CLI — `mthds-agent run …`

All commands emit a single JSON envelope via the agent's `agentSuccess` / `agentError` helpers.

```bash
# Submit and return the id without waiting
mthds-agent --runner api run start bundle.mthds --pipe my_pipe -i inputs.json
# → { "pipeline_run_id": "…", "state": "STARTED", "created_at": "…" }

# Single-shot status / result (do not block)
mthds-agent --runner api run status <pipeline_run_id>
mthds-agent --runner api run result <pipeline_run_id>   # state: running | completed | failed

# Block until terminal, then print the result
mthds-agent --runner api run poll <pipeline_run_id> --interval 2 --timeout 1200
```

`run start` also accepts `--method-id <id>` to run a stored method instead of an inline bundle, and `--content <mthds>` / `--inputs-json <json>` for inline content.

**Ctrl-C on `run poll` is safe.** SIGINT stops waiting but does **not** cancel the run — it keeps executing server-side. The command reports the run as resumable:

```json
{ "state": "running", "pipeline_run_id": "…", "resumable": true,
  "hint": "Stopped waiting; the run continues. Resume with: mthds-agent run poll <pipeline_run_id>" }
```

The local pipelex CLI runner (`--runner pipelex`) runs in-process and has no durable run to poll; the run-lifecycle methods raise a clear "use --runner api" error there.

## Auth note

The hosted run routes require an authorized identity. Today they are gated to `Role.ADMIN`; the public, scope-based (`runs:execute`) path for non-admin API keys is a launch-day data change, not a code change. Until then, exercise these against an admin-scoped key.
