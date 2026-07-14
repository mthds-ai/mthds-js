# PR #99 review notes — deferred items

Triage of the SWE-agent review threads on https://github.com/mthds-ai/mthds-js/pull/99 (release/v0.19.0). One confirmed-but-judgment-heavy item was deferred rather than fixed in the release PR.

## `BuildRequestBase`: `files` / `method_ref` XOR is not enforced at compile time

- **Reporter:** cubic-dev-ai (P2) — [thread](https://github.com/mthds-ai/mthds-js/pull/99) on `src/runners/types.ts` (the `BuildRequestBase` interface, `files?` / `method_ref?`).
- **Issue:** the declared XOR contract (exactly one of `files[]` or `method_ref`) is documented but not type-enforced; a caller could construct a body with both selectors or neither, which a runner then rejects at runtime. The suggested fix is an exclusive union (`{ files: ...; method_ref?: never } | { files?: never; method_ref: string }`).
- **Why deferred (needs-judgment, not wrong but not now):**
  - No call site in the repo can construct the bad shape today — every constructor passes exactly `files` (`src/agent/commands/api-commands.ts`, `src/cli/commands/build.ts` ×3), and `method_ref` is a reserved arm: the API answers `501` and the local runner throws (`src/runners/pipelex/runner.ts`, `writeBuildFiles`).
  - These are deliberate wire-mirror types with runtime validation at the boundary (`docs/build-routes.md` documents the XOR as a wire contract). The repo's own rule (comment above the `BuildInputsJsonReport | BuildInputsTomlReport` union in `src/runners/types.ts`) reaches for a union only when there is a real discriminant field; the closure selector has none — presence itself is the signal, which is exactly the case the `never`-union idiom handles most awkwardly.
  - The three request interfaces `extends BuildRequestBase`; an interface cannot extend a union, so the change forces all three into `type`-alias intersections — a real ripple to guard a construction nothing performs.
- **Recommendation:** revisit when `method_ref` is actually implemented server-side. At that point a caller genuinely chooses between the two arms and an exclusive union earns its keep; land it together with the real second arm.
