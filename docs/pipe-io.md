# Pipe I/O — `POST /v1/pipe-io`

`MthdsApiClient.pipeIo()` returns a method's three I/O artifacts in one call: its pipe I/O contracts, its input form and its output form. The server loads the method, selects a pipe and derives the artifacts without a dry run, so a call costs one load and one derivation where `validate` mock-runs every pipe of the method. A caller that shows a method, prepares its inputs or generates a template for it reads this route; a caller that needs the dry-run verdict stays on `validate`.

It is a **Pipelex API extension, not an MTHDS Protocol route**, so it lives in `src/runners/` and never in `src/protocol/`. The artifacts it carries are the standard's own types, imported from `mthds/protocol` (`PipeIOContracts`, `InputForm`, `OutputForm`). It is a method of the concrete client and not of the `Runner` interface: the local pipelex runner shells out to `pipelex-agent` and has no use for it. `@pipelex/sdk` has its own `pipeIo()` over the same route, because that SDK builds on `mthds/protocol` alone and not on this client.

A runner serves the route from `pipelex-api` v0.33.0, and the hosted API proxies it to its runner. The route takes the method's tree, as below, from the `pipelex-api` release that follows 0.88.0; an older runner takes a list of `.mthds` files and refuses the map.

## Request

```typescript
import { listMethodTree } from "mthds";

const tree = await listMethodTree("./my_method");
const result = await client.pipeIo({
  tree,
  pipe_ref: "smoke.echo", // optional
});
```

- **The method is exactly one of three selectors.** Its tree, `method_ref` (a published method's address, `github.com/<owner>/<repo>[/<selector>][@<tag>]`, which the server fetches) or `method_id`, a stored method's catalog id (`mt_…`). The tree and `method_ref` are the selector the crate routes share (`CrateRequestBase`, the runner's `MethodTreeRequest`). Only a hosted API resolves a `method_id`: its platform looks the id up in the caller's organization and forwards the stored method as `files` before the runner sees the request, so a bare runner refuses a request whose only selector is a `method_id`. The client leaves the exclusivity of the three to the server, which refuses neither or several with a `422`.
- **The tree travels as it does on `validate` and the runs.** Give it as `tree`, a `MethodTreeSource` such as the `MethodTree` the lister returns, which the client sends as the protocol's `files` map, inline or by hash after uploading the blobs the runner lacks (see [api-runner.md](./api-runner.md#sending-a-methods-tree)), or as `files`, a ready map from tree path to file entry, posted as given. The two together, and an empty tree, are refused before anything is sent. The runner reads the map as `/v1/validate` reads it: a key or entry the tree's rule refuses is a `422` problem, `method.package_invalid` naming the rule and the path at fault or `request.invalid` for an entry of the wrong shape, a hash it does not hold a `422` `request.blobs_missing` listing it in `missing_blobs`, and a tree past its limits a `422` `method.package_invalid` naming the `limit`, the last two of which the client answers once, as it does on a run. Each item names its file by tree path in its `location.file`; a graph-level fault has no single owning file, which is why `location.file` is optional.
- **`dependencies`, `resources` and `read_scope`** accompany the tree and are posted as given: the method packages the method calls by address that the runner cannot fetch, each a map of file entries keyed by its address; files the steps read, keyed by their path from the tree's root, in Base64; and the scope a hash entry resolves in, whose blob store records the tree read.
- **`method_ref` has two forms.** The address form is fetched by the server at its tag, the package's whole tree read from its commit. Any other reference is the registry form, which stays reserved and answers `501` until a method registry exists.
- **`pipe_ref`** is the qualified `domain.pipe_code` of the pipe to describe. Omit it and the server's selection chain decides: the `main_pipe` of the `METHODS.toml` at the tree's root, else the tree's single `main_pipe` declaration. A qualified ref is never ambiguous, where a bare code that two domains declare is refused.
- **`all_pipes: true`** describes every pipe the method loads instead of the selected one, and never refuses for want of an entry pipe.
- **`include_files: true`** echoes the text of the method's own `.mthds` bundles on the valid arm as `files`, a map from tree path to text: the bundles of the tree the request sent, whatever entry carried them, or those of the fetched package for a `method_ref`. The tree's other files and its dependencies are not echoed.

**The request budget.** A tree or a `method_id` gets the static-route budget of thirty seconds, counted from the request itself, after any upload. A `method_ref` gets three minutes, because the server may have to clone the repository before it answers. The hosted gateway caps a response at about thirty seconds whatever the client allows, so a cold `method_ref` clone there can answer a `502` that a retry clears once the runner has cached the clone.

## The verdict rides `is_valid`

A produced verdict is a **200** discriminated on `is_valid`:

```typescript
if (!result.is_valid) {
  for (const item of result.errors) console.error(`${item.code}: ${item.detail}`);
  return;
}
const descriptor = result.input_form[result.pipe_ref!];
```

- **The valid arm** carries `pipe_ref` (the qualified ref the selection resolved, never the request's spelling; `null` only under `all_pipes` when nothing resolves), the three maps `pipe_io_contracts`, `input_form` and `output_form` sharing one key set (the resolved `pipe_ref` alone by default, every pipe under `all_pipes`), `default_pipe_ref` (the method's own entry pipe, not `validate`'s run default), `pending_signatures`, `is_runnable`, and `files` when asked. `is_valid: true` means the method parsed, loaded and passed static validation; no dry run backs it.
- **The invalid arm** is `CrateInvalidReport`: `is_valid: false` and `errors[]`, one problem item per fault (`ProblemItem`: `code`, `detail`, `params`, `location`, `suggested_fix`), with no artifact and no selection. The client refuses an invalid arm whose items are not of that shape as `client.response_unreadable`.

A throw means no verdict could be produced. Over HTTP it is an `ApiResponseError` carrying the runner's problem (see [errors.md](./errors.md#apiresponseerror)):

- a `422` for a malformed body, a wrong number of selectors, a tree the runner refuses (`method.package_invalid`, `request.blobs_missing` once the client has answered it), or a **refused pipe selection**;
- the `method_ref` fetch outcomes: `404` when no package at the address matches, `422` for a reference that does not parse or a fetch the server cannot accept, `501` for a registry-form reference;
- a `500` when an artifact cannot be derived for a pipe;
- `401`, `403` and `413` as on every route.

An unreachable server is an `ApiTransportError` of `client.unreachable`.

**A refused pipe selection is told apart by its code, never by the message.** It is `request.pipe_not_found` (a `pipe_ref` that names no pipe, or a manifest `main_pipe` the method lacks; its `suggestions` parameter lists the likeliest pipes), `request.pipe_ambiguous` (a bare code matching pipes in several domains, or several `main_pipe` declarations; its `candidates` parameter lists them) or `request.pipe_unspecified` (no `pipe_ref` and no `main_pipe`; its `candidates` parameter lists the pipes to choose from). These codes are exported as `PIPE_SELECTION_CODES`.

## `mthds-agent inputs` reads it

On the API runner, `mthds-agent inputs bundle|pipe|method` reads the pipe's input form from this route and projects the fill-in template locally with `projectInputsTemplate` and `renderInputsTemplate` from `mthds/protocol` (see [architecture.md](./architecture.md#the-inputs-template-is-projected-from-the-descriptor-not-fetched)). Both rendering axes are therefore the client's own: `--format json|toml` and `--explicit` are honoured on the API runner as `pipelex-agent` honours them on the pipelex runner, and the template is the one in the projection corpus `mthds-python` shares: `--format toml` prints its bytes exactly, and the JSON envelope carries it as a value, where a decimal placeholder prints as `0` because JSON has one number type. `mthds build inputs pipe` on the API runner reads it the same way.

- `inputs bundle` and `inputs pipe` send the method's tree as `validate` sends it (`resolveMethodTarget` in `src/runners/method-target.ts`, described in [api-runner.md](./api-runner.md#sending-a-methods-tree)): a directory's tree, a `.mthds` file in its manifest's tree, alone, or in the tree of the `-L` directory holding it, and `--content` as a one-file tree, with the same membership rule and the same refusals. Without `--pipe`, a named bundle or `--content` asks for its own `main_pipe` qualified with its own domain (`entryPipeRef`), so a tree where two domains declare the same pipe code is never ambiguous, and a directory, or a named bundle declaring no `main_pipe`, leaves the pipe to the route's selection chain, whose answer names the pipe it chose. `mthds build inputs pipe` sends its target the same way.
- `inputs method <target>` sends a `method_id` when the target is a catalog id (`mt_…`) and a `method_ref` when it is an address (it contains a `/`). A local path (one starting with `.`, `/` or `~`, ending in `.mthds`, or existing on disk) and a bare name are refused as `client.argument_invalid`: the first belongs to `inputs bundle`, and the second names an installed method, which only the pipelex runner can read.

A refusal, a refused selection included, is the runner's problem relayed whole, its code and parameters kept, and an invalid method is the `method.invalid` problem holding the verdict's items, as on `validate`. The command reference is in [CLI.md](../CLI.md#mthds-agent-inputs-bundlepipemethod).

## See also

- [architecture.md](./architecture.md) — the protocol/runner split, and the inputs-template projection.
- [errors.md](./errors.md) — the problem document, `ApiResponseError`, and how an answer is read.
