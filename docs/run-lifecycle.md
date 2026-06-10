# Run lifecycle (durable, poll-by-id)

Real pipeline runs take minutes to hours. The API Gateway in front of the hosted platform has a hard 30s response ceiling, so a synchronous "submit and wait for the answer in one HTTP call" is structurally impossible. mthds-js submits a run, then polls a self-healing endpoint by bare `run_id` until the run reaches a terminal state.

Because every bit of run state lives behind the `run_id` (DynamoDB for the immutable facts, Temporal for the live execution state), a caller — including an AI agent — can submit a run, drop the connection, and reconnect hours later with only the `run_id` to get the true outcome.

## Two surfaces

The SDK talks to two distinct API surfaces. They are not interchangeable:

- **Runner** (`/runner/v1/pipeline/*`) — the stateless execution engine. `MthdsApiClient.executePipeline` calls the blocking `/pipeline/execute`; it returns the full result in one call but is subject to the 30s gateway ceiling, so it only suits short runs. When a run exceeds ~30s it raises `PipelineExecuteTimeoutError` (explaining the limit and pointing here), rather than a bare `503`.
- **Platform** (`/platform/v1/runs*`) — the durable run lifecycle. Starting a run here (`POST /platform/v1/runs`) is what creates the RUN row that the self-healing `by-id` endpoints read. Starting via the runner alone would leave nothing to poll.

The run lifecycle methods (`startRun` / `getRun` / `getResult` / `waitForResult`) all use the platform surface.

Each surface is addressed by its own base URL, which **includes its version prefix** — `runnerUrl` (e.g. `https://api.pipelex.com/runner/v1`) and `platformUrl` (e.g. `https://api.pipelex.com/platform/v1`). `platformUrl` is optional: a self-hosted open-source runner has no run store, so when `platformUrl` is unset the platform methods above throw a clear hosted-only error and `run pipe` falls back to the runner's blocking `/pipeline/execute`. See [self-hosting](./self-hosting.md).

## Server endpoints

| Method | Path | Returns |
|---|---|---|
| `POST` | `/platform/v1/runs` | `RunPublic` — the created run (executes asynchronously) |
| `GET` | `/platform/v1/runs/by-id/{run_id}` | `RunRead` — status, self-healing (`degraded` flag + `Retry-After` when Temporal is unreachable) |
| `GET` | `/platform/v1/runs/by-id/{run_id}/result` | `202` still running · `200` result · `409` terminal failure |

The `by-id` read is self-healing: a run that timed out, was terminated, or whose completion callback never landed resolves to its true terminal status the moment anyone reads it — no callback required.

`status` is one of `PENDING`, `STARTED` (deprecated), `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`, `TERMINATED`, `TIMED_OUT`. Only `COMPLETED` has a result; every other terminal status is a failure (`getResult` returns `409`, surfaced as `RunFailedError`).

## SDK — `MthdsApiClient`

```ts
import { MthdsApiClient, RunFailedError, RunTimeoutError } from "mthds";

const client = new MthdsApiClient({ apiBaseUrl, apiToken });

// Submit (returns immediately with a run id)
const run = await client.startRun({
  pipe_code: "my_pipe",              // optional — omit to use the bundle's main_pipe
  mthds_contents: [bundleContents],  // or method_id for a stored method
  inputs: { question: "…" },
  // optional output controls (forwarded to the runner):
  // output_name, output_multiplicity, dynamic_output_concept_ref
});

// Poll to completion
try {
  const result = await client.waitForResult(run.pipeline_run_id, {
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
    // stopped waiting; resume later with client.waitForResult(run_id)
  }
}
```

Lower-level single-shot lookups:

- `getRun(runId)` → `RunRead` (status + `degraded`).
- `getResult(runId)` → a discriminated `RunResultState`: `{ state: "running", retry_after_seconds }`, `{ state: "completed", result }`, or `{ state: "failed", status, message }`. A degraded `503` is treated as `running` (retry) so a poller is never failed by a transient Temporal outage.

## Runner surface

The `Runner` abstraction (what the CLI and agent use) exposes the durable lifecycle as three primitives — `start(options)`, `getRun(runId)`, `getResult(runId)` — plus two composites provided once by `BaseRunner`: `waitForResult(runId)` (poll an already-started run to completion) and `startAndWaitForResult(options)` (start, then wait — the one-call convenience). The API runner (`--runner api`) routes `startAndWaitForResult()` through this durable platform path when a platform is configured, and falls back to the runner's blocking `/pipeline/execute` when self-hosted. The granular durable primitives (`start` / `getRun` / `getResult` / `waitForResult`) are **platform-only** — there is no runner fallback, so without a platform URL they throw a clear hosted-only error (the runner has no run store). The local `pipelex` runner likewise supports only `startAndWaitForResult` (blocking, in-process).

## Agent CLI — `mthds-agent run …`

All commands emit a single JSON envelope via the agent's `agentSuccess` / `agentError` helpers.

```bash
# Submit and return the id without waiting
mthds-agent --runner api run start bundle.mthds --pipe my_pipe -i inputs.json
# → { "pipeline_run_id": "…", "workflow_id": "…", "status": "PENDING", … }

# Single-shot status / result (do not block)
mthds-agent --runner api run status <run_id>
mthds-agent --runner api run result <run_id>   # state: running | completed | failed

# Block until terminal, then print the result
mthds-agent --runner api run poll <run_id> --interval 2 --timeout 1200
```

`run start` also accepts `--method-id <id>` (with `--pipe`) to run a stored method instead of an inline bundle, and `--content <mthds>` / `--inputs-json <json>` for inline content.

**Ctrl-C on `run poll` is safe.** SIGINT stops waiting but does **not** cancel the run — it keeps executing server-side. The command reports the run as resumable:

```json
{ "state": "running", "pipeline_run_id": "…", "resumable": true,
  "hint": "Stopped waiting; the run continues. Resume with: mthds-agent run poll <run_id>" }
```

The local pipelex CLI runner (`--runner pipelex`) runs in-process and has no durable run to poll; the run-lifecycle methods raise a clear "use --runner api" error there.

## Auth note

The platform run routes require an authorized identity. Today they are gated to `Role.ADMIN`; the public, scope-based (`runs:execute`) path for non-admin API keys is a launch-day data change, not a code change. Until then, exercise these against an admin-scoped key.
