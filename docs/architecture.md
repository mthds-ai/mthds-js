# SDK architecture — `protocol/` ⊥ `runners/`

The SDK is split into two layers that mirror `mthds-python` (`mthds/protocol/` ⊥ `mthds/runners/`):

- **`src/protocol/` — the pure MTHDS Protocol.** The interface and wire models, exactly what `mthds-protocol.openapi.yaml` defines — no more, no less. It imports **nothing** from `runners/`, `cli/`, `agent/`, or `config/`. A `.dependency-cruiser.cjs` rule (run in `make check`) enforces that boundary.
- **`src/runners/` — the implementations.** The API client/runner, the local pipelex CLI runner, the shared `Runner` supertype the CLI programs against, and the hosted run-lifecycle extension.

## Module map

```
src/protocol/                 PURE — the MTHDS Protocol mirror (imports nothing from runners/cli/config)
  protocol.ts                 MTHDSProtocol<PipeOutputT> — execute/start/validate/models/version (GENERIC)
  models.ts                   RunResultExecute<T>, RunResultStart, ModelDeck/Info/Category,
                              ValidationReport, VersionInfo, MTHDS_PROTOCOL_VERSION — slim + extension-open
  options.ts                  RunRequest/StartRequest, RunOptions/StartOptions, ExtensionOptions (the arg surface)
  pipeline_inputs.ts          StuffContentOrData, PipelineInputs
  pipe_output.ts              VariableMultiplicity, PipeOutputAbstract<TWorkingMemory>
  concept.ts                  ConceptAbstract + conceptRef()
  stuff.ts                    StuffAbstract<TConcept, TContent>, StuffContentAbstract
  working_memory.ts           WorkingMemoryAbstract<TStuff>
  exceptions.ts               PipelineRequestError (protocol-level base)
src/runners/api/
  client.ts                   MthdsApiClient — IS the api runner: extends BaseRunner implements Runner
  runs.ts                     run-lifecycle TYPES + the pollUntilResult loop (RunStatus/RunRead/RunResults/…)
  models.ts                   DictStuff/DictWorkingMemory/DictPipeOutput + DictRunResultExecute (default binding);
                              PipelexValidationReport/ValidatedPipeEntry/DryRunStatus + ValidationErrorItem/Category
                              (typed Pipelex-API extensions over the protocol's ValidationReport)
  exceptions.ts               ApiResponseError (+ validationErrors), ApiUnreachableError, ClientAuthenticationError,
                              RunFailedError, RunTimeoutError, RunStillRunningError,
                              RunLifecycleUnavailableError, PipelineExecuteTimeoutError
src/runners/pipelex/
  runner.ts                   PipelexRunner (local CLI runner)
src/runners/
  types.ts                    Runner interface (extends MTHDSProtocol<DictPipeOutput>) + Runners enum + build types
  base-runner.ts              lifecycle COMPOSITES (waitForResult, startAndWaitForResult)
  registry.ts                 createRunner() factory
src/index.ts                  public barrel → re-exports protocol/ + runners/
```

## Why the protocol interface is generic

`MTHDSProtocol<PipeOutputT>` is generic so `protocol/` never names a runner-side concrete. `execute` returns `RunResultExecute<PipeOutputT>`; the default `DictPipeOutput` binding — `DictRunResultExecute = RunResultExecute<DictPipeOutput>` — lives in `runners/api/models.ts`, not in the protocol. `Runner` binds it as `MTHDSProtocol<DictPipeOutput>`. The generic is the mechanism that keeps the boundary pure.

## The run response is split

- `execute` → `RunResultExecute<T>{pipeline_run_id, pipe_output}` — a completed run always has output.
- `start` → `RunResultStart{pipeline_run_id}` — a started run has no output yet; how completion is later delivered (polling, callbacks) is implementation-defined and outside the protocol.

Both are extension-open (index signature): anything more an implementation returns (`state`, `created_at`, `main_stuff_name`, …) is preserved but never named by the SDK. The discovery models (`ModelDeck`, `VersionInfo`, `ValidationReport`) are slim + extension-open the same way.

## Typed Pipelex-API extensions over the validate surface

The protocol's `ValidationReport` and `VersionInfo` stay slim, but the API runner talks to the Pipelex API, which fills them with a known body. `runners/api/models.ts` types those extensions so consumers (the VS Code extension, `pipelex-app`) don't reach through the index signature:

- **`PipelexValidationReport`** — the typed 200 body of `POST /v1/validate` for a valid bundle (`bundle_blueprint`, `pipe_io_contracts`, `graph_spec`, `validated_pipes`, `pending_signatures`, `is_runnable`, plus the route extras `success`/`message`). `bundle_blueprint`/`pipe_io_contracts`/`graph_spec` stay opaque transport — their canonical schemas are owned by the runtime and `@pipelex/mthds-ui`. `validate()` returns this type; `mthds_names` (a third, optional, parallel-array arg) names each submitted content so the server threads `blueprint.source` for cross-file diagnostics.
- **`ValidationErrorItem`** (+ `ValidationErrorCategory`) — one structured per-error item on an invalid-bundle 422. The list rides the `application/problem+json` envelope as a top-level `validation_errors[]` and is parsed onto `ApiResponseError.validationErrors`. Throw-on-422 is unchanged — an invalid bundle is still an `ApiResponseError`; the caller reads the typed field. `undefined` for any non-validation error (auth, transport, a request-shape 422).
- **`VersionInfo.implementation_version`** — the one well-known `VersionInfo` extension is typed (still optional) so capability gating reads `version().implementation_version` directly.

Token precedence in the constructor: an explicitly-passed `apiToken` wins over `MTHDS_API_KEY` from the environment (`options.apiToken ?? process.env.MTHDS_API_KEY`), so a wrapper (e.g. the VS Code extension's SecretStorage) can override a native env read.

## The API client IS the API runner (D-B)

There is one class, not a client wrapped by a runner. `MthdsApiClient extends BaseRunner implements Runner`:

- **`pipelex-app`** instantiates it directly and uses its protocol subset (`start`, `validate`, `version`) plus the run-lifecycle extension (`getRunResult`).
- **The CLI** gets it via `createRunner('api')`, which wires the config-derived base URL + token, and uses the full `Runner` surface (build extensions, `health`, the lifecycle composites).

The lifecycle composites (`waitForResult`, `startAndWaitForResult`) come from `BaseRunner` so they can never drift between runtimes. `MthdsApiClient` overrides `startAndWaitForResult` only to add the bare-runner blocking-execute fallback: a `/v1/version` handshake decides whether the server serves the durable run lifecycle; a bare `pipelex-api` runner (no run store) 404s `/v1/runs/*`, which surfaces as `RunLifecycleUnavailableError`.

## Run lifecycle is NOT the protocol

`getRunStatus`/`getRunResult`/`waitForResult` and the `runs.ts` models are a hosted-API extension, not part of `MTHDSProtocol`. They live under `runners/api/`, served only by a deployment that includes the platform block. See [`run-lifecycle.md`](./run-lifecycle.md).
