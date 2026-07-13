# Build routes — `/v1/build/*`

The three per-pipe projections: `buildInputs`, `buildOutput`, `buildRunner`. Given a closure of `.mthds` files and a pipe inside it, each returns one view of that pipe — an example inputs template, its output representation, or a runnable Python script.

These are **Pipelex API extensions, not MTHDS Protocol routes.** The protocol fixes `execute` / `start` / `validate` / `models` / `version`; everything here is Pipelex's own surface, which is why the request types live in `src/runners/types.ts` (the runner layer) rather than in `src/protocol/`. A third-party MTHDS runner is not obliged to serve them.

## The shared envelope

All three take the same closure + pipe selector:

```typescript
const result = await runner.buildInputs({
  files: [{ content: "domain = 'smoke'\nmain_pipe = 'echo'\n…", source: "smoke.mthds" }],
  pipe_ref: "smoke.echo", // optional
});
```

**`files[]` XOR `method_ref`.** Supply the closure inline as `files`, or name a registry method with `method_ref` — never both. `method_ref` is reserved: the method registry does not exist yet, so the API answers `501` and the local runner throws.

**`source` is a provenance label**, not a path the server reads. Give it a filename and the server threads it onto every diagnostic raised from that file, so an invalid verdict points at the file that caused it. The local runner puts it to a second use — it names the file on disk in the temp closure it hands the CLI, so the CLI's own diagnostics agree.

**`pipe_ref` is a QUALIFIED `domain.pipe_code` ref, and it is optional.** Omit it and the pipe defaults to the closure's declared `main_pipe`. That default fails (`422` on the API, a throw locally) when the closure declares *no* `main_pipe` — and equally when it declares *several* across its domains, because an ambiguous closure has no single "the" pipe and guessing would be worse than asking.

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

Branch on `is_valid` — never on an HTTP status or a caught exception. A throw means *no verdict could be produced at all*: an unknown `pipe_ref`, an undefaultable selector, auth, a server fault.

(The local `pipelex` runner satisfies the same union but never *returns* the invalid arm — an unloadable closure makes the CLI exit non-zero, which surfaces as a throw. Callers still branch on `is_valid`; that branch is simply never taken there.)

## The format axis decides which field carries the payload

Each route's `format` picks the field the result rides in. The unused field is **absent from the response**, not null.

| Route | `format` | Payload field | Type |
| --- | --- | --- | --- |
| `buildInputs` | `json` (default) | `inputs` | parsed object |
| `buildInputs` | `toml` | `inputs_toml` | raw text |
| `buildOutput` | `schema` (default), `json` | `output` | parsed object |
| `buildOutput` | `python` | `output_python` | source text |

The split is not cosmetic. TOML carried as a parsed object would lose its concept comments and key order — exactly what makes it worth asking for. And Python source fed through a JSON parse is not a value at all; before the split, `format: "python"` was a hard 500 on the API.

`buildInputs` also takes `explicit` (default `false`): emit the ceremonial `{concept, content}` envelope per input instead of the light, signature-driven shape.

## `allow_signatures` is `buildRunner`-only

Alone among the three, `buildRunner` still runs the dry-run sweep — and `allow_signatures` only ever parameterized that sweep. `buildInputs` and `buildOutput` are static reads of the resolved closure, so the flag is meaningless to them and they do not accept it.

`buildRunner`'s valid arm carries the script plus the typed-structures projection it imports from: write `structures.artifacts` and `structures.lock` (under `structures.lock_filename`) into `structures.directory`, relative to the script, and the returned `python_code` runs against them.

## See also

- [api-runner.md](./api-runner.md) — base URL, hosted vs. self-hosted.
- [errors.md](./errors.md) — the exception taxonomy, and `ValidationErrorItem`'s fields.
