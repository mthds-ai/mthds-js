# Pipe I/O — `POST /v1/pipe-io`

`MthdsApiClient.pipeIo()` returns a method's three I/O artifacts in one call: its pipe I/O contracts, its input form and its output form. The server resolves the closure, selects a pipe and derives the artifacts without a dry run, so a call costs one load and one derivation where `validate` mock-runs every pipe of the method. A caller that shows a method, prepares its inputs or generates a template for it reads this route; a caller that needs the dry-run verdict stays on `validate`.

It is a **Pipelex API extension, not an MTHDS Protocol route**, so it lives in `src/runners/` and never in `src/protocol/`. The artifacts it carries are the standard's own types, imported from `mthds/protocol` (`PipeIOContracts`, `InputForm`, `OutputForm`). It is a method of the concrete client and not of the `Runner` interface: the local pipelex runner shells out to `pipelex-agent` and has no use for it. `@pipelex/sdk` has its own `pipeIo()` with the same wire shape, because that SDK builds on `mthds/protocol` alone and not on this client.

A runner serves the route from `pipelex-api` v0.33.0, and the hosted API proxies it to its runner.

## Request

```typescript
const result = await client.pipeIo({
  files: [{ content: "domain = 'smoke'\nmain_pipe = 'echo'\n…", source: "smoke.mthds" }],
  pipe_ref: "smoke.echo", // optional
});
```

- **The closure is exactly one of three selectors.** `files` (inline `.mthds` files, each `{ content, source? }`) or `method_ref` (a published method's address, `github.com/<owner>/<repo>[/<selector>][@<tag>]`, which the server fetches), the envelope the crate-family routes share; or `method_id`, a stored method's catalog id (`mt_…`). Only a hosted API resolves a `method_id`: its platform looks the id up in the caller's organization and forwards the stored files as `files` before the runner sees the request, so a bare runner refuses a request whose only selector is a `method_id`. The client posts the request as given and leaves the exclusivity to the server, which refuses neither or several with a `422`.
- **`method_ref` has two forms.** The address form is fetched by the server at its tag: the package inside the repository is located by its manifest identity, and its `.mthds` files become the closure with their real relative paths as per-file `source` labels. Any other reference is the registry form, which stays reserved and answers `501` until a method registry exists.
- **`source` is a provenance label**, not a path the server reads. The server threads it onto the diagnostics it can attribute to that file, so an invalid verdict points at the file that caused it. The server names that file in each item's `location.file`. The attribution is best-effort: a graph-level fault has no single owning file, which is why `location.file` is optional.
- **`pipe_ref`** is the qualified `domain.pipe_code` of the pipe to describe. Omit it and the server's selection chain decides: a fetched package's manifest `main_pipe`, else the closure's single `main_pipe` declaration.
- **`all_pipes: true`** describes every pipe the closure loads instead of the selected one, and never refuses for want of an entry pipe.
- **`include_files: true`** echoes the resolved closure's `.mthds` files on the valid arm as `files`, in the request's own shape.

**The request budget.** An inline closure or a `method_id` gets the static-route budget of thirty seconds. A `method_ref` gets three minutes, because the server may have to clone the repository before it answers. The hosted gateway caps a response at about thirty seconds whatever the client allows, so a cold `method_ref` clone there can answer a `502` that a retry clears once the runner has cached the clone.

## The verdict rides `is_valid`

A produced verdict is a **200** discriminated on `is_valid`:

```typescript
if (!result.is_valid) {
  for (const item of result.errors) console.error(`${item.code}: ${item.detail}`);
  return;
}
const descriptor = result.input_form[result.pipe_ref!];
```

- **The valid arm** carries `pipe_ref` (the qualified ref the selection resolved, never the request's spelling; `null` only under `all_pipes` when nothing resolves), the three maps `pipe_io_contracts`, `input_form` and `output_form` sharing one key set (the resolved `pipe_ref` alone by default, every pipe under `all_pipes`), `default_pipe_ref` (the method's own entry pipe, not `validate`'s run default), `pending_signatures`, `is_runnable`, and `files` when asked. `is_valid: true` means the closure parsed, loaded and passed static validation; no dry run backs it.
- **The invalid arm** is `CrateInvalidReport`: `is_valid: false` and `errors[]`, one problem item per fault (`ProblemItem`: `code`, `detail`, `params`, `location`, `suggested_fix`), with no artifact and no selection. The client refuses an invalid arm whose items are not of that shape as `client.response_unreadable`.

A throw means no verdict could be produced. Over HTTP it is an `ApiResponseError` carrying the runner's problem (see [errors.md](./errors.md#apiresponseerror)):

- a `422` for a malformed body, a wrong number of selectors, an over-limit file, or a **refused pipe selection**;
- the `method_ref` fetch outcomes: `404` when no package at the address matches, `422` for a reference that does not parse or a fetch the server cannot accept, `501` for a registry-form reference;
- a `500` when an artifact cannot be derived for a pipe;
- `401`, `403` and `413` as on every route.

An unreachable server is an `ApiTransportError` of `client.unreachable`.

**A refused pipe selection is told apart by its code, never by the message.** It is `request.pipe_not_found` (a `pipe_ref` that names no pipe, or a manifest `main_pipe` the closure lacks; its `suggestions` parameter lists the likeliest pipes), `request.pipe_ambiguous` (a bare code matching pipes in several domains, or several `main_pipe` declarations; its `candidates` parameter lists them) or `request.pipe_unspecified` (no `pipe_ref` and no `main_pipe`; its `candidates` parameter lists the pipes to choose from). The three codes are exported as `PIPE_SELECTION_CODES`.

## `mthds-agent inputs` reads it

On the API runner, `mthds-agent inputs bundle|pipe|method` reads the pipe's input form from this route and projects the fill-in template locally with `projectInputsTemplate` and `renderInputsTemplate` from `mthds/protocol` (see [architecture.md](./architecture.md#the-inputs-template-is-projected-from-the-descriptor-not-fetched)). Both rendering axes are therefore the client's own: `--format json|toml` and `--explicit` are honoured on the API runner as `pipelex-agent` honours them on the pipelex runner, and the template is the one in the projection corpus `mthds-python` shares: `--format toml` prints its bytes exactly, and the JSON envelope carries it as a value, where a decimal placeholder prints as `0` because JSON has one number type. `mthds build inputs pipe` on the API runner reads it the same way.

- `inputs bundle` and `inputs pipe` send the bundle's closure as `files`: the named file, or a directory's entry file, first, then every other `.mthds` file of the directory and of each `-L` directory (`resolveBundleClosure` in `src/runners/bundle.ts`). When the closure holds several files and `--pipe` is omitted, they send the entry's own `main_pipe` as `pipe_ref` (`closureEntryPipeRef`), because the route's selection chain refuses a closure declaring a `main_pipe` in several domains. `mthds build inputs pipe` sends its bundle file and its `-L` directories the same way.
- `inputs method <target>` sends a `method_id` when the target is a catalog id (`mt_…`) and a `method_ref` when it is an address (it contains a `/`). A local path (one starting with `.`, `/` or `~`, ending in `.mthds`, or existing on disk) and a bare name are refused as `client.argument_invalid`: the first belongs to `inputs bundle`, and the second names an installed method, which only the pipelex runner can read.

A refusal, a refused selection included, is the runner's problem relayed whole, its code and parameters kept, and an invalid closure is the `method.invalid` problem holding the verdict's items, as on `validate`. The command reference is in [CLI.md](../CLI.md#mthds-agent-inputs-bundlepipemethod).

## See also

- [architecture.md](./architecture.md) — the protocol/runner split, and the inputs-template projection.
- [errors.md](./errors.md) — the problem document, `ApiResponseError`, and how an answer is read.
