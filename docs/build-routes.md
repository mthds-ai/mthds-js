# Build routes — `/v1/build/*`

The per-pipe projection `buildInputs`: given a closure of `.mthds` files and a pipe inside it, it returns an example inputs template for that pipe.

These are **Pipelex API extensions, not MTHDS Protocol routes.** The protocol fixes `execute` / `start` / `validate` / `models` / `version`; everything here is Pipelex's own surface, which is why the request types live in `src/runners/types.ts` (the runner layer) rather than in `src/protocol/`. A third-party MTHDS runner is not obliged to serve them.

**This package's CLIs no longer call `buildInputs`.** `mthds-agent inputs` and `mthds build inputs` on the API runner read the pipe's input form from `POST /v1/pipe-io` and project the template locally (see [pipe-io.md](./pipe-io.md)). `buildInputs()` stays on the client for other callers until the route is retired. `pipeIo()` shares the closure envelope below, `files[]` XOR `method_ref`, and adds a hosted `method_id`.

## The shared envelope

It takes a closure + pipe selector:

```typescript
const result = await runner.buildInputs({
  files: [{ content: "domain = 'smoke'\nmain_pipe = 'echo'\n…", source: "smoke.mthds" }],
  pipe_ref: "smoke.echo", // optional
});
```

**`files[]` XOR `method_ref`.** Supply the closure inline as `files`, or name a published method with `method_ref` — never both.

An **address-form** `method_ref` (`github.com/<owner>/<repo>[/<selector>][@<tag>]`) is resolved by the API as of pipelex-api 0.21.0: the repository is fetched at the tag, the package inside it is located by manifest identity, and its `.mthds` files become the closure with their real relative paths as per-file `source` labels. The **registry form** — any reference that is not an address — stays reserved and answers `501` until a method registry exists.

Omitting `pipe_ref` on an address-form request defaults to the fetched manifest's `main_pipe`, the way a run by address does — but only on a server **newer than pipelex-api 0.21.0**. 0.21.0 resolves the address form and then drops the manifest on the tooling path, falling straight through to the closure's own domain-level declarations, so a package whose `METHODS.toml` names an entry pipe that its domains do not answers `422` there. Send `pipe_ref` explicitly to be portable across both.

Both forms are API-only. The local runner shells out to `pipelex-agent <projection> bundle <path>`, which reads a closure already on disk, so it has nothing to resolve a reference against and throws on any `method_ref`.

**`source` is a provenance label**, not a path the server reads. Give it a filename and the server threads it onto the diagnostics it can attribute to that file, so an invalid verdict points at the file that caused it. Treat the attribution as best-effort: graph-level `dry_run` and `pipe_factory` items have no single owning file, and a `main_pipe` naming a nonexistent pipe currently reports its provenance in the message prose while leaving the structured field unset — which is why `ValidationErrorItem.source` is optional.

The local runner puts the label to a second use — it names the file on disk in the temp closure it hands the CLI, so the CLI's own diagnostics agree. It **normalizes** it first, though, so local diagnostics may not echo `source` back verbatim the way the API does. The rule is: take the **final segment** of the label (splitting on `/` and `\`), and keep it only if it ends in `.mthds` and is not a dotfile; otherwise fall back to a positional name (`bundle.mthds`, `extra_2.mthds`).

So `lib/shared.mthds` and `https://example.com/shared.mthds` both become `shared.mthds` — the prefix is dropped, the basename survives. A label whose final segment is not a `.mthds` file (`notes.txt`, `.hidden.mthds`, a bare label like `main`) gets the positional name instead. That is a deliberate guard against escaping the temp directory, not an oversight — and it's why the API is the one to trust for verbatim `source` round-tripping.

**`pipe_ref` is a QUALIFIED `domain.pipe_code` ref, and it is optional.** Omit it and the pipe is chosen by the precedence above — the fetched manifest's `main_pipe` on an address-form `method_ref`, else the closure's own declared `main_pipe`. It fails (`422` on the API, a throw locally) when that chain comes up empty, and equally when the closure declares _several_ `main_pipe`s across its domains, because an ambiguous closure has no single "the" pipe and guessing would be worse than asking.

The valid arm echoes both the ref it resolved and, when you submitted one, the ref you asked for:

```typescript
result.pipe_ref; // "smoke.echo" — always the RESOLVED, qualified ref
result.requested_pipe_ref; // "echo" — what you submitted; absent when it was defaulted
```

## The verdict rides `is_valid`, never the transport

Like `/validate`, these routes are diagnostic. A closure that cannot be resolved is the **successful product** of the call — the request was well-formed, the library was not — so it comes back as a **200** carrying diagnostics, not as a thrown error:

```typescript
const result = await runner.buildInputs({ files });
if (!result.is_valid) {
  for (const err of result.validation_errors) {
    console.error(`${err.source ?? "?"}: ${err.message}`);
  }
  return;
}
console.log(result.inputs);
```

Branch on `is_valid` — never on an HTTP status or a caught exception. A throw means _no verdict could be produced at all_: an unknown `pipe_ref`, an undefaultable selector, auth, a server fault. Over the API it is an `ApiResponseError`, carrying the runner's error domain, next step and request id when the problem document names them (see [errors.md](./errors.md#apiresponseerror)).

(The local `pipelex` runner satisfies the same union but never _returns_ the invalid arm — an unloadable closure makes the CLI exit non-zero, which surfaces as a throw. Callers still branch on `is_valid`; that branch is simply never taken there.)

## The format axis decides which field carries the payload

The request's `format` picks the field the result rides in. The unused field is **absent from the response**, not null.

| `format`         | Payload field | Type          |
| ---------------- | ------------- | ------------- |
| `json` (default) | `inputs`      | parsed object |
| `toml`           | `inputs_toml` | raw text      |

The split is not cosmetic. TOML carried as a parsed object would lose its concept comments and key order — exactly what makes it worth asking for.

`buildInputs` also takes `explicit` (default `false`): emit the ceremonial `{concept, content}` envelope per input instead of the light, signature-driven shape.

## See also

- [pipe-io.md](./pipe-io.md) — `pipeIo()`: a method's three I/O artifacts in one call, which the inputs template is now projected from.
- [api-runner.md](./api-runner.md) — base URL, hosted vs. self-hosted.
- [errors.md](./errors.md) — the exception taxonomy, and `ValidationErrorItem`'s fields.
