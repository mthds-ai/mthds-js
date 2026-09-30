# Pipe I/O — `POST /v1/pipe-io`

`MthdsApiClient.pipeIo()` returns a method's three I/O artifacts in one call: its pipe I/O contracts, its input form and its output form. The server resolves the closure, selects a pipe and derives the artifacts without a dry run, so a call costs one load and one derivation where `validate` mock-runs every pipe of the method. A caller that shows a method, prepares its inputs or generates a template for it reads this route; a caller that needs the dry-run verdict stays on `validate`.

It is a **Pipelex API extension, not an MTHDS Protocol route**, so it lives in `src/runners/` beside the build wrappers and never in `src/protocol/`. The artifacts it carries are the standard's own types, imported from `mthds/protocol` (`PipeIOContracts`, `InputForm`, `OutputForm`). Like `uploadFile`, it is a method of the concrete client and not of the `Runner` interface: the local pipelex runner shells out to `pipelex-agent` and has no use for it. `@pipelex/sdk` has its own `pipeIo()` with the same wire shape, because that SDK builds on `mthds/protocol` alone and not on this client.

A runner serves the route from `pipelex-api` v0.33.0; the hosted API serves it once its platform proxy lists it.

## Request

```typescript
const result = await client.pipeIo({
  files: [{ content: "domain = 'smoke'\nmain_pipe = 'echo'\n…", source: "smoke.mthds" }],
  pipe_ref: "smoke.echo", // optional
});
```

- **The closure is exactly one of three selectors.** `files` (inline `.mthds` files, each `{ content, source? }`) or `method_ref` (a published method's address, `github.com/<owner>/<repo>[/<selector>][@<tag>]`, which the server fetches), as on the build routes; or `method_id`, a stored method's catalog id (`mt_…`). Only a hosted API resolves a `method_id`: its platform looks the id up in the caller's organization and forwards the stored files as `files` before the runner sees the request, so a bare runner refuses a request whose only selector is a `method_id`. The client posts the request as given and leaves the exclusivity to the server, which refuses neither or several with a `422`.
- **`pipe_ref`** is the qualified `domain.pipe_code` of the pipe to describe. Omit it and the server's selection chain decides: a fetched package's manifest `main_pipe`, else the closure's single `main_pipe` declaration.
- **`all_pipes: true`** describes every pipe the closure loads instead of the selected one, and never refuses for want of an entry pipe.
- **`include_files: true`** echoes the resolved closure's `.mthds` files on the valid arm as `files`, in the request's own shape.

**The request budget.** An inline closure or a `method_id` gets the static-route budget of thirty seconds. A `method_ref` gets three minutes, because the server may have to clone the repository before it answers. The hosted gateway caps a response at about thirty seconds whatever the client allows, so a cold `method_ref` clone there can answer a `502` that a retry clears once the runner has cached the clone.

## The verdict rides `is_valid`

A produced verdict is a **200** discriminated on `is_valid`:

```typescript
if (!result.is_valid) {
  for (const err of result.validation_errors) console.error(err.message);
  return;
}
const descriptor = result.input_form[result.pipe_ref!];
```

- **The valid arm** carries `pipe_ref` (the qualified ref the selection resolved, never the request's spelling; `null` only under `all_pipes` when nothing resolves), the three maps `pipe_io_contracts`, `input_form` and `output_form` sharing one key set (the resolved `pipe_ref` alone by default, every pipe under `all_pipes`), `default_pipe_ref` (the method's own entry pipe, not `validate`'s run default), `pending_signatures`, `is_runnable`, and `files` when asked. `is_valid: true` means the closure parsed, loaded and passed static validation; no dry run backs it.
- **The invalid arm** is `CrateInvalidReport`, the same `is_valid: false` + `validation_errors[]` + `message` the build routes answer, with no artifact and no selection.

A throw means no verdict could be produced. Over HTTP it is an `ApiResponseError` (see [errors.md](./errors.md#apiresponseerror)):

- a `422` for a malformed body, a wrong number of selectors, an over-limit file, or a **refused pipe selection**;
- the `method_ref` fetch outcomes: `404` when no package at the address matches, `422` for a reference that does not parse or a fetch the server cannot accept, `501` for a registry-form reference;
- a `500` when an artifact cannot be derived for a pipe;
- `401`, `403` and `413` as on every route.

An unreachable server is an `ApiUnreachableError`.

**A refused pipe selection is told apart by `errorType`, never by the message.** The runner types it `EntryPipeNotFoundError` (a `pipe_ref` that names no pipe, a manifest `main_pipe` the closure lacks, or no `pipe_ref` and no `main_pipe`) or `EntryPipeAmbiguousError` (a bare code matching pipes in several domains, or no `pipe_ref` and several `main_pipe` declarations), while a malformed request keeps `ValidationError`. The two strings are exported as `PIPE_SELECTION_ERROR_TYPES`. The candidates a caller could choose from appear only in the message. `pipelex-api` v0.33.0 still types a selection refusal `ValidationError`; the typed refusals ship from v0.33.1.

## `mthds-agent inputs` reads it

On the API runner, `mthds-agent inputs bundle|pipe|method` reads the pipe's input form from this route and projects the fill-in template locally with `projectInputsTemplate` and `renderInputsTemplate` from `mthds/protocol` (see [architecture.md](./architecture.md#the-inputs-template-is-projected-from-the-descriptor-not-fetched)). Both rendering axes are therefore the client's own: `--format json|toml` and `--explicit` are honoured on the API runner as `pipelex-agent` honours them on the pipelex runner, and the template's bytes are those of the projection corpus `mthds-python` shares. `mthds build inputs pipe` on the API runner reads it the same way. Neither calls `POST /v1/build/inputs` any more; `buildInputs()` stays on the client for other callers until that route is retired.

- `inputs bundle` and `inputs pipe` send the bundle file as `files`.
- `inputs method <target>` sends a `method_id` when the target is a catalog id (`mt_…`) and a `method_ref` when it is an address (it contains a `/`). A local path (one starting with `.`, `/` or `~`, ending in `.mthds`, or existing on disk) and a bare name are refused with an `ArgumentError`: the first belongs to `inputs bundle`, and the second names an installed method, which only the pipelex runner can read.

A refused selection comes back as an `ArgumentError` whose message is the runner's own sentence, against a runner that types it (v0.33.1 or later; an older one's refusal is a `RunnerError`); any other refusal is a `RunnerError`, and an invalid closure is the `ValidateBundleError` verdict, as on `validate`. The command reference is in [CLI.md](../CLI.md#mthds-agent-inputs-bundlepipemethod).

## See also

- [build-routes.md](./build-routes.md) — the shared `files[]` envelope and `method_ref` resolution, which this route shares.
- [architecture.md](./architecture.md) — the protocol/runner split, and the inputs-template projection.
- [errors.md](./errors.md) — `ApiResponseError` and its problem members.
