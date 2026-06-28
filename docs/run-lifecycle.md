# Run lifecycle (durable, poll-by-id) — moved out of `mthds-js`

The durable run lifecycle — submit a run, then poll a self-healing endpoint by bare `pipeline_run_id` until it reaches a terminal state — is a **hosted-API extension, NOT part of the MTHDS Protocol**. It no longer ships in `mthds-js`.

It now lives in the Pipelex runtime SDK (`@pipelex/sdk` / `pipelex-agent`), whose client carries `getRunStatus` / `getRunResult` / `waitForResult` / `startAndWaitForResult` and the `/v1/runs/*` wire surface. Use that SDK (or `pipelex-agent`) when you need durable poll-by-id runs.

## What `mthds-js` still provides

`mthds-js`'s `MthdsApiClient` (and the `mthds` / `mthds-agent` CLIs) keep the MTHDS Protocol surface and the Pipelex build extensions:

- `execute(options)` → `POST /v1/execute` — run a method synchronously and wait for the result (blocking; behind the hosted gateway this is capped at ~30s, after which it raises `PipelineExecuteTimeoutError`). On the protocol's optional 202 degrade it raises `RunStillRunningError` carrying the `pipeline_run_id` / `Retry-After` / `Location` — resume by id via the durable run API above.
- `start(options)` → `POST /v1/start` — submit a run and return its authoritative `pipeline_run_id` (no output yet). How completion is later delivered is implementation-defined and outside this client.
- `validate` / `models` / `version`, plus the `/v1/build/*` build helpers.

Everything is served from one base URL (`MTHDS_API_URL`, host only); the SDK composes `{base}/v1/{endpoint}`. The protocol surface works against any MTHDS-compliant runner, hosted or bare.
