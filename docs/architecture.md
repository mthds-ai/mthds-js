# SDK architecture — `protocol/` ⊥ `runners/`

The SDK is split into two layers that mirror `mthds-python` (`mthds/protocol/` ⊥ `mthds/runners/`):

- **`src/protocol/` — the pure MTHDS Protocol.** The interface and wire models, exactly what `mthds-protocol.openapi.yaml` defines — no more, no less. It imports **nothing** from `runners/`, `cli/`, `agent/`, or `config/`. A `.dependency-cruiser.cjs` rule (run in `make check`) enforces that boundary.
- **`src/runners/` — the implementations.** The API client/runner, the local pipelex CLI runner, the shared `Runner` supertype the CLI programs against, and the hosted run-lifecycle extension.

## Module map

```
src/protocol/                 PURE — the MTHDS Protocol mirror (imports nothing from runners/cli/config)
  protocol.ts                 MTHDSProtocol<PipeOutputT> — execute/start/validate/models/version (GENERIC)
  models.ts                   RunResultExecute<T>, RunResultStart, ModelDeck/Info/Category,
                              ValidationResult (ValidationReport | InvalidValidationReport) + ValidationError,
                              VersionInfo, MTHDS_PROTOCOL_VERSION — slim + extension-open
  options.ts                  RunRequest/StartRequest, RunOptions/StartOptions, ExtensionOptions (the arg surface)
  pipeline_inputs.ts          StuffContentOrData, PipelineInputs
  pipe_output.ts              VariableMultiplicity, PipeOutputAbstract<TWorkingMemory>
  concept.ts                  ConceptAbstract + conceptRef()
  stuff.ts                    StuffAbstract<TConcept, TContent>, StuffContentAbstract
  working_memory.ts           WorkingMemoryAbstract<TStuff>
  exceptions.ts               PipelineRequestError (protocol-level base)
src/runners/api/
  client.ts                   MthdsApiClient — IS the api runner: implements Runner (protocol + build extensions)
  models.ts                   DictStuff/DictWorkingMemory/DictPipeOutput + DictRunResultExecute (default binding);
                              PipelexValidationResult (PipelexValidationReport | PipelexInvalidReport) +
                              ValidatedPipeEntry/DryRunStatus + ValidationErrorItem/Category
                              (typed Pipelex-API narrowing of the protocol's ValidationResult union)
  exceptions.ts               ApiResponseError (+ validationErrors), ApiUnreachableError, ClientAuthenticationError,
                              RunStillRunningError, PipelineExecuteTimeoutError
src/runners/pipelex/
  runner.ts                   PipelexRunner (local CLI runner)
src/runners/
  types.ts                    Runner interface (extends MTHDSProtocol<DictPipeOutput>) + Runners enum + build types
  registry.ts                 createRunner() factory
src/index.ts                  public barrel → re-exports protocol/ + runners/
```

## Why the protocol interface is generic

`MTHDSProtocol<PipeOutputT>` is generic so `protocol/` never names a runner-side concrete. `execute` returns `RunResultExecute<PipeOutputT>`; the default `DictPipeOutput` binding — `DictRunResultExecute = RunResultExecute<DictPipeOutput>` — lives in `runners/api/models.ts`, not in the protocol. `Runner` binds it as `MTHDSProtocol<DictPipeOutput>`. The generic is the mechanism that keeps the boundary pure.

## The run response is split

- `execute` → `RunResultExecute<T>{pipeline_run_id, pipe_output}` — a completed run always has output.
- `start` → `RunResultStart{pipeline_run_id}` — a started run has no output yet; how completion is later delivered (polling, callbacks) is implementation-defined and outside the protocol.

Both are extension-open (index signature): anything more an implementation returns (`state`, `created_at`, `main_stuff_name`, …) is preserved but never named by the SDK. The discovery models (`ModelDeck`, `VersionInfo`) and the valid arm `ValidationReport` are slim + extension-open the same way.

## The validate surface is 200-diagnostic

`POST /validate` is a diagnostic endpoint: every produced verdict rides a **200**, discriminated in the body on the mandatory `is_valid` field. The protocol layer models this as `ValidationResult = ValidationReport (is_valid: true) | InvalidValidationReport (is_valid: false)`; non-2xx is reserved for *no-verdict* conditions (a malformed request, an `mthds_sources` length mismatch, auth, a server fault), which throw `ApiResponseError`. The API runner talks to the Pipelex API, which fills both arms with a known body — `runners/api/models.ts` narrows them so consumers (the VS Code extension, `pipelex-app`) don't reach through the index signature:

- **`PipelexValidationResult`** = `PipelexValidationReport | PipelexInvalidReport`, the union `MthdsApiClient.validate()` returns. A caller pattern-matches `is_valid`, never a status code or a thrown error.
- **`PipelexValidationReport`** (`is_valid: true`) — the valid arm (`bundle_blueprint`, `pipe_io_contracts`, `graph_spec`, `validated_pipes`, `pending_signatures`, `is_runnable`, plus the route extras `message`/`mthds_contents` echo). `bundle_blueprint`/`pipe_io_contracts`/`graph_spec` stay opaque transport — their canonical schemas are owned by the runtime and `@pipelex/mthds-ui`. `mthds_sources` (a third, optional, parallel-array arg to `validate()`) names each submitted content so the server threads `blueprint.source` for cross-file diagnostics.
- **`PipelexInvalidReport`** (`is_valid: false`) — the invalid arm (`validation_errors[]`, `pending_signatures`, `is_runnable: false`, `message`; no structural artifacts). `validation_errors[]` is non-empty on every invalid verdict.
- **`ValidationErrorItem`** (+ the closed `ValidationErrorCategory`, incl. `dry_run`) — one structured per-error item. On `/validate` it rides the 200 invalid arm; the same typed item also rides the **build routes'** 422 problem body (parsed onto `ApiResponseError.validationErrors`, `undefined` for any error with no per-error list).
- **`VersionInfo.implementation_version`** — the one well-known `VersionInfo` extension is typed (still optional) so capability gating reads `version().implementation_version` directly.

Token precedence in the constructor: an explicitly-passed `apiToken` wins over `MTHDS_API_KEY` from the environment (`options.apiToken ?? process.env.MTHDS_API_KEY`), so a wrapper (e.g. the VS Code extension's SecretStorage) can override a native env read.

## The API client IS the API runner (D-B)

There is one class, not a client wrapped by a runner. `MthdsApiClient implements Runner`:

- **`pipelex-app`** instantiates it directly and uses its protocol subset (`execute`, `start`, `validate`, `version`).
- **The CLI** gets it via `createRunner('api')`, which wires the config-derived base URL + token, and uses the full `Runner` surface (protocol + build extensions + `health`).

## Run lifecycle lives in `@pipelex/sdk`, not here

The durable run-lifecycle (poll a run by id) is a hosted-API extension, not part of `MTHDSProtocol`, and no longer ships in `mthds-js` — it now lives in the Pipelex runtime SDK (`@pipelex/sdk` / `pipelex-agent`). `mthds-js` keeps the protocol `start` (`POST /v1/start`); how completion is later delivered is implementation-defined. See [`run-lifecycle.md`](./run-lifecycle.md).
