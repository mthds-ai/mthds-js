# Contract Check — mthds-js

**Date**: 2026-07-14
**Repo**: mthds-js (npm: `mthds`)
**Branch**: `release/v0.19.0`
**Baseline**: `v0.18.0` (auto-detected — latest release tag)
**Target**: HEAD (`3016527`, plus uncommitted release-prep changes for v0.19.0)

**Specs checked**:
- `docs/specs/mthds-agent-cli.md` — mthds-agent CLI (owned by mthds-js)
- `docs/specs/pipelex-mthds-protocol.md` — MTHDS Protocol wire surface (owned by pipelex + pipelex-api; implemented by the API runner)
- `docs/specs/plxt-cli.md` — plxt CLI (owned by vscode-pipelex; consumed via passthrough)
- `docs/specs/hook-lint-pipeline.md` — hook pipeline (owned by mthds-plugins; participated in by codex-hook.ts)

**Also consulted (outside the skill's normal scope, because it turned out to be load-bearing)**: `docs/specs/pipelex-codegen.md` — owned by pipelex + pipelex-api, not listed as a spec mthds-js implements/consumes, but its "Route envelopes" section is the actual canonical spec for the `/v1/build/*` changes in this diff. See Unmatched Additions.

## Summary Table

| Category               | Count | Resolution needed? |
|------------------------|-------|--------------------|
| Discrepancies          | 3     | Yes                |
| Unmatched additions    | 4     | Some                |
| Aligned changes        | 6     | No                 |

**Verdict**: 3 discrepancies require resolution — one is a stale doc section, one is an explicit spec statement the code now contradicts, and one is a possible error-taxonomy misuse worth a second look. None block wire compatibility. Decision for this release (2026-07-14): ship v0.19.0 now, address these as follow-up work.

---

## Discrepancies

### 1. `mthds-agent-cli.md` Stability Notes contradicts the new `codegen` registration on the API runner

**What the code does**: `src/agent/commands/api-commands.ts` (new in this diff, lines ~470–508) registers a `codegen` command group with `types`/`check` subcommands on the **API runner** program. Invoking either emits `error_type: "UnsupportedError"` pointing the caller at `--runner pipelex`. This means `codegen` now **appears** in `mthds-agent --help` under the API runner (as a stub that errors cleanly), where previously it did not exist at all for that runner.

**What the spec says**: `docs/specs/mthds-agent-cli.md` line 1027 (Stability Notes): *"`pipelex-commands.ts` (pipelex runner stubs) and `api-commands.ts` (API runner handlers) list the same set, minus the pipelex-runner-only commands the API runner does not implement (`init`, `accept-gateway-terms`, `codegen`)."* This explicitly says `api-commands.ts` should **not** list `codegen` at all. Unverified in conformance (this line is narrative/stability guidance, no dedicated test).

**What changed**: The code changed since baseline (this is new registration in the diff); the spec's codegen section itself (lines 391–402: *"API runner does not implement this command yet"*) is loosely compatible with a clean-error stub, but the Stability Notes' explicit command-list enumeration was not updated to match. This is a spec-drift-by-omission, not a deliberate contradiction — but as written, the two spec passages now disagree with each other, and one disagrees with the code.

### 2. `mthds-agent-cli.md`'s `mthds-agent inputs` section is stale relative to the shipped `inputs bundle`/`inputs pipe` contract

**What the code does**: `src/agent/commands/api-commands.ts`'s `inputsGroup` (`mthds-agent inputs bundle`/`inputs pipe`) now:
- Takes `--pipe <ref>` (a qualified `domain.pipe_code`, optional, server-defaulted off `main_pipe`) — not `--pipe <code>`.
- On success, emits `{ success: true, pipe_ref: "...", inputs: {...} }` via the new `emitInputsTemplate` helper — the key is `pipe_ref`, not `pipe_code`.
- On a produced invalid verdict (`is_valid: false` from `buildInputs`), emits an **error** envelope (not a success envelope) carrying `is_valid: false` and `validation_errors`.

**What the spec says**: `docs/specs/mthds-agent-cli.md` lines 370–389 (`#mthds-agent-inputs`) documents: `--pipe <code>` as the option; and a success shape of `{ "success": true, "pipe_code": "main_pipe", "inputs": {...} }` with no mention of an invalid-verdict path at all. Marked `<!-- unverified: ... generated input JSON not behaviorally tested -->` — no conformance test currently guards this section either way.

**What changed**: The code changed in this diff (this is exactly the `pipe_code`→`pipe_ref` rename and discriminated-verdict work the CHANGELOG describes for the build routes); the doc section was not updated to match. Since this is the section of the spec an AI agent or the skills plugin would read to understand `mthds-agent inputs`, this is the most consumer-visible of the three discrepancies.

### 3. The new `buildInputs` error path uses `error_type: "ValidationError"`, which the spec's own taxonomy says means the opposite of what's happening

**What the code does**: `emitInputsTemplate` (api-commands.ts) branches on `result.is_valid` from `buildInputs()`. On `false` — a **produced invalid-bundle verdict** carrying `validation_errors[]` — it calls `agentError(result.message, "ValidationError", { error_domain: AGENT_ERROR_DOMAINS.VALIDATION, is_valid: false, validation_errors: result.validation_errors })`.

**What the spec says**: `docs/specs/mthds-agent-cli.md`'s Error Types table (lines 74–86) draws a specific distinction:
- `ValidationError` → *"A **no-verdict** validation failure — a transport/auth/server fault or a request-shape 422 ... **NOT** an invalid bundle."*
- `ValidateBundleError` → *"An **invalid-bundle verdict** — `/validate` returned a 200 `is_valid: false` body (a produced verdict, not a thrown error). Carries `is_valid: false` + `validation_errors[]`."*

The sibling `validate bundle` command (same file, lines 254–264) correctly uses `ValidateBundleError` for exactly this situation (a produced `is_valid: false` verdict). The new `buildInputs` error path produces the identical shape (`is_valid: false` + `validation_errors[]`, a produced verdict, not a thrown error) but tags it `ValidationError` — the type the spec says means the opposite (no verdict at all). Marked `<!-- unverified -->` in the sense that build-route error envelopes aren't conformance-tested yet, so nothing currently catches this either way.

**What changed**: This is new code in this diff. It's not clear this is a deliberate new precedent ("build-route invalid verdicts get `ValidationError` because they're a different family from `/validate`") vs. a copy-paste/naming slip that should be `ValidateBundleError` (or a new `error_type` altogether, since it's not literally `/validate`). Flagging for the human reviewer's call.

---

## Unmatched Additions

**In code, documented elsewhere but not in the four specs this skill scopes to**: The entire `/v1/build/*` wire migration in this diff — `files[]` envelope, qualified/optional `pipe_ref` (with defaulting-to-`main_pipe` and ambiguous/absent-`main_pipe` errors), the `200`+`is_valid` discriminated-union verdict discipline replacing bare payloads, the format-following payload split (`inputs`/`inputs_toml`, `output`/`output_python`), `allow_signatures` now rejected by the local runner and dropped from `buildInputs`/`buildOutput`, and the `structures` projection on `buildRunner` — is **not documented at all** in `mthds-agent-cli.md` or `pipelex-mthds-protocol.md`. It **is** documented, in detail, and it matches the code closely, in `docs/specs/pipelex-codegen.md` §"Route envelopes" (lines 142–159) — a spec this contract-check skill's own spec-set table doesn't currently list as one mthds-js consumes, even though `src/runners/api/client.ts`, `src/runners/pipelex/runner.ts`, `src/cli/commands/build.ts`, and `src/runners/types.ts` all directly implement what that section describes. Recommend the `contract-check` skill's spec table be extended to include `pipelex-codegen.md` as a fifth explicit-map spec (same treatment as `pipelex-mthds-protocol.md`), so future build-route changes get checked against it automatically.

**In code, new and undocumented by design (acknowledged gap)**: The bare `mthds build inputs pipe`/`build output pipe` CLI gained `--format`/`--explicit` flags (`src/cli.ts`, `src/cli/commands/build.ts`). The `mthds` interactive CLI has no spec yet — this is the acknowledged, pre-existing gap the skill's own notes call out, not a new problem. Flagging for awareness only.

**In mthds-js's own docs, not `docs/specs/`, and accurate**: `docs/build-routes.md` (new) and updates to `CLI.md` / `docs/api-runner.md` correctly describe the same `files[]`/`pipe_ref`/discriminated-verdict contract as `pipelex-codegen.md`, from the client's point of view. No conflict found between mthds-js's own docs and the canonical spec.

**In spec, not (yet) in code**: `pipelex-codegen.md` §"CLI: codegen" documents `mthds-agent codegen types` as taking `--target <flavor>`, `-o <dir>`, `-L <dir>` (mirrored in `mthds-agent-cli.md` line 397). The actual stub in both `api-commands.ts` and `pipelex-commands.ts` only declares `[paths...]` as an argument with `allowUnknownOption()`/`allowExcessArguments()` — meaning those flags aren't *rejected*, but they also aren't declared, so `--help` won't show them. This is consistent with "stub, not full implementation" and both specs already carry `<!-- unverified: greenfield -->` markers for codegen, so this isn't a fresh drift — just noting it's still open.

---

## Aligned Changes

- **`resolveQualifiedPipeRef`** (new `src/runners/pipe-ref.ts`) behavior — qualified ref wins, single-domain closure lets a bare ref get qualified, absent/ambiguous `main_pipe` throws — matches `pipelex-codegen.md`'s description of how the engine defaults `--pipe` for `codegen inputs`, which this explicitly mirrors by design (per its own docstring).
- **`allow_signatures` handling** — rejected by the local `buildRunner` runner (throws, points at API runner), and absent entirely from `BuildInputsRequest`/`BuildOutputRequest` types — matches `pipelex-codegen.md`'s statement that `build/inputs`/`build/output` "run no dry-run sweep, and therefore drop `allow_signatures`," while `build/runner` "keeps both the sweep and `allow_signatures`."
- **`BuildRunnerValidReport.structures` optionality** — API always populates it, local runner only when the installed pipelex ships the codegen lock — matches `pipelex-codegen.md`'s description of the trust-chain being engine-version-gated.
- **Format-split discriminated unions** (`BuildInputsJsonReport`/`BuildInputsTomlReport`, `BuildOutputObjectReport`/`BuildOutputPythonReport`) — matches `pipelex-codegen.md`'s "The format axis decides the payload's JSON type" section exactly (parsed object vs. raw text, mutually exclusive fields).
- **`PIPELEX_PKG.version_constraint` bump** (`>=0.35.1` → `>=0.39.0` in `src/agent/binaries.ts`) — no spec pins a specific value; `mthds-agent-cli.md`'s Binary Dependencies table documents the field's existence/shape only and is explicitly marked "concrete constraint values are not asserted in conformance." Not a contract violation; this is exactly the CHANGELOG-documented dependency bump needed to unlock `codegen`.
- **`plxt-cli.md` and `hook-lint-pipeline.md`** — untouched by any file in this diff; no discrepancies found.

---

## Follow-up (deferred from v0.19.0 release)

1. Update `mthds-agent-cli.md` Stability Notes line to drop `codegen` from the "commands the API runner does not implement" list, since it's now registered there as a clean-erroring stub.
2. Update `mthds-agent-cli.md`'s `#mthds-agent-inputs` section: `--pipe <code>` → `--pipe <ref>`, success shape's `pipe_code` → `pipe_ref`, and document the new invalid-verdict error path.
3. Resolve whether `emitInputsTemplate`'s invalid-verdict path should use `ValidateBundleError` instead of `ValidationError` (matching the sibling `validate bundle` command's convention for the same produced-verdict shape), or whether a new error type is warranted.
4. Consider adding `pipelex-codegen.md` to the `contract-check` skill's explicit-map spec table, since it's the canonical spec for the `/v1/build/*` wire surface this repo implements.

Per each spec's `> Verified by:` convention, any spec edit above must land with its conformance test update in the same change, and `make check-spec-links` (run from `conformance/`) must pass.
