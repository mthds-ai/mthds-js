# Contract Check — mthds-js

**Date**: 2026-06-19
**Repo**: mthds-js (npm: `mthds`)
**Branch**: release/v0.12.0
**Baseline**: `v0.11.0` (auto-detected)
**Target**: HEAD (`ac2b975`)

**Specs checked**:
- `docs/specs/mthds-agent-cli.md` — **owned** by mthds-js; the `mthds`/`mthds-agent` CLI surface (commands, options, envelopes, output routing).
- `docs/specs/pipelex-mthds-protocol.md` — **implemented/consumed**; the API-runner wire shapes (validate report union, `render`/`rendered_markdown`, 0/1/2 exit policy, error envelope).
- `docs/specs/plxt-cli.md` — **consumed** via passthrough (no relevant change this release).
- `docs/specs/hook-lint-pipeline.md` — **participated in** by `codex-hook.ts` (Stage 3 decision logic).

| Category            | Count | Resolution needed? |
|---------------------|-------|--------------------|
| Discrepancies       | 2     | Yes                |
| Unmatched additions | 3     | Yes                |
| Aligned changes     | 6     | No                 |

The wire/protocol side is fully documented; the gaps are concentrated in `mthds-agent-cli.md` (the new `--format`/`--error-format` options and the API-runner Markdown default) plus one pre-existing, conformance-unverified Codex-hook default-to-block divergence.

## Discrepancies

### D1 — API-runner `validate` now defaults to Markdown output, contradicting "API runner → structured JSON".

1. **What the code does**: `runProtocolValidate` in `src/agent/commands/api-commands.ts:811-874` normalizes a missing `--format` to `"markdown"` (`normValidateFormat(undefined) → "markdown"`, `src/agent/commands/api-commands.ts:811-813`). When the server returns `rendered_markdown`, the valid arm emits it verbatim to **stdout** via `agentMarkdownSuccess` and `return`s — bypassing the `agentSuccess({success:true,...})` JSON envelope; the invalid arm emits it to **stderr** and `process.exit(1)` via `agentMarkdownError` (`src/agent/output.ts:52-67`). So against a render-capable Pipelex API, the *default* output of `mthds-agent --runner api validate bundle` is now Markdown, not JSON.
2. **What the spec says**: `mthds-agent-cli.md:26` ("With the API runner, native commands output structured JSON"), `:971` (Output Routing table: "Runner-aware commands with **API runner** → stdout/stderr → mthds-agent JSON protocol"), and `:978` ("Only the API runner wraps responses in the mthds-agent JSON envelope"). The Output Routing table is not individually `> Verified by`-tagged; the related validate envelope is verified by `tests/pipelex_agent/test_validate_envelope.py` — but that covers the pipelex/local path, not the API-runner Markdown path.
3. **What changed**: the **code** moved (new `--format`, defaulting to markdown, on the API runner). `mthds-agent-cli.md` was not updated to match. Note the **protocol** spec *does* document the underlying view: `pipelex-mthds-protocol.md` §"Opt-in `rendered_markdown`" (`:240-251`) and §"Presentation vs contract" (`:255-260`), and `:282` even says "the agent CLI … renders the error envelope per `--error-format`." The gap is specifically in `mthds-agent-cli.md`'s output-routing statements, which still assert JSON-only for the API runner.

### D2 — Codex hook treats unparseable/empty stderr as BLOCK; the spec decision table says PASS.

1. **What the code does**: `classifyStage3Result` in `src/agent/commands/codex-hook.ts:203-232` — when `parseAgentErrorEnvelope` returns `undefined` (empty or non-JSON stderr), it returns `{ kind: "block", ... }` (default-to-block safety, `:206-216`); any non-`config`/`runtime` domain also blocks (`:227-231`).
2. **What the spec says**: `hook-lint-pipeline.md:110` Decision Logic — "Invalid JSON / no `error` field → **PASS** (don't block on unknowns)"; `:109` — "Other `input`-domain errors → **WARN**". Conformance status: **unverified** (explicit `<!-- unverified: hook orchestration not exercised in conformance -->` at `:130`).
3. **What changed**: This is a **pre-existing philosophy divergence** between the Codex hook (`codex-hook.ts`, default-to-block) and the bash-hook decision table the spec documents (default-to-pass). This release changed the *parse mechanism* (Markdown-grep → JSON envelope) but not the block/warn default — so neither side moved on the default this release; the divergence persists. Flag for the reviewer: decide whether the spec should document the Codex variant's stricter default-to-block, or whether the code should match the table.

## Unmatched Additions

### A — `--format` / `--error-format` options on `validate bundle` and `validate pipe` (in code, not in spec).
Added in `src/agent/commands/api-commands.ts:143-144` (`bundle`) and `:167-168` (`pipe`). The `mthds-agent-cli.md` `validate bundle` options table (`:172`) lists only `--pipe`, `--content`, `--view`, `--direction` — it does **not** list `--format`/`--error-format`. (`pipelex-mthds-protocol.md:282` references `--error-format` semantics but does not enumerate CLI options; `mthds-agent-cli.md` is the option-table owner.)

### B — Hook spawn now forwards `--format json --error-format json` (and `--allow-signatures`) (in code, not in spec command line).
`src/agent/commands/codex-hook.ts:357-361` spawns `pipelex-agent validate bundle <file> -L <dir> --allow-signatures --format json --error-format json`. `hook-lint-pipeline.md:86` shows the invocation as `mthds-agent validate bundle "$FILE_PATH" -L "$PARENT_DIR/"` — without these flags (and it names `mthds-agent`, while the code calls `pipelex-agent` directly to avoid recursion; the binary-name difference is pre-existing). Code has the flags; spec command line lacks them.

### C — `PipelexRunner` (local `pipelex` CLI runner) returns a minimal invalid arm on exit 1 instead of throwing (in code, not explicitly sanctioned by spec).
`src/runners/pipelex/runner.ts:448-460` now maps exit `1` to `{ is_valid: false, validation_errors: [], pending_signatures: [], is_runnable: false, message }`; exit `2+`/spawn failures still throw. `pipelex-mthds-protocol.md:55` describes the local validate as "returns this report **or raises**." Two notes for the reviewer: (i) the minimal-invalid-arm return is a runner implementation choice not explicitly described in the spec; (ii) its **empty** `validation_errors[]` sits in tension with the structured-info invariant (`pipelex-mthds-protocol.md:217`, `:284`: every invalid verdict carries a non-empty `validation_errors[]`) — though that invariant is stated for the `pipelex-agent`/API surfaces, not the bare `pipelex` CLI runner this wraps. Verified-by for the invariant: `tests/pipelex_agent/test_validate_errors.py` (covers the agent CLI, not this runner).

## Resolution status (2026-06-19)

Addressed during the v0.12.0 release prep, in `docs/specs/mthds-agent-cli.md` (workspace-root repo, branch `feature/Validate-api-render-format`):

- **D1 — RESOLVED.** Added a new `##### \`validate\` output format (Markdown vs JSON)` subsection documenting the Markdown-default behavior, the `render: ["markdown"]` opt-in, the stdout/stderr/exit semantics, and the JSON fallback. Corrected the intro, the Output-Protocol bullet, and the Output-Routing table + narrative to stop asserting JSON-only for the API runner. Marked `<!-- unverified -->` with a cross-reference to `tests/pipelex_api/test_validate_render.py` (the path is not exercisable in the mthds_agent surface harness).
- **A — RESOLVED.** Added `--format <markdown|json>` and `--error-format <markdown|json>` to the `validate bundle` and `validate pipe` option tables.
- **Stale "Stage 3 disabled" (the `mthds-agent-cli.md` face of B/D2) — RESOLVED.** The `codex hook` section claimed "Stage 3 … is disabled until offline-mode validation lands", but `codex-hook.ts:357` now runs `pipelex-agent validate bundle … --allow-signatures --format json --error-format json` (offline-safe). Rewrote step 5 to document the live Stage 3, its JSON-envelope decision logic (pass / warn on `config`/`runtime` / default-to-block otherwise), added the `additionalContext` warn row to the output-protocol table, fixed the missing-tool step to include `pipelex-agent`, and updated the aggregation step.
- Verified: `make check-spec-links` passes; `tests/mthds_agent/test_spec.py` + `test_agent_json.py` pass (surface + JSON envelope).

**B/D2 — RESOLVED (2026-06-19).** The `mthds-plugins` `release/v0.14.0` bash hook (`validate-mthds.sh`) was rewritten to read the structured `is_valid` verdict from stdout, pin `--allow-signatures --format json --error-format json`, and **default-to-block** on no machine-readable verdict / unparseable stderr / input-domain — converging with the Codex hook. The two hooks now agree. `docs/specs/hook-lint-pipeline.md` was updated to match: pinned invocation, success-envelope (`is_valid`-from-stdout) + error-envelope parsing tables, the default-to-block decision table, the `additionalContext` warn/nudge shapes, and a cross-link to the Codex-hook section. Hook orchestration stays `<!-- unverified -->` in conformance (no live hook harness); the Stage 3 invocation shape is unit-tested in mthds-js's `codex-hook-validate.test.ts`. (The bash hook intentionally calls `mthds-agent`, routing to the configured runner, while the Codex hook calls `pipelex-agent` directly to avoid recursion — a pre-existing, deliberate difference.)

**D1 verification upgraded (2026-06-19).** The `validate` Markdown/JSON path is no longer `<!-- unverified -->`: new conformance test `tests/mthds_agent/test_validate_render_format.py` boots `pipelex-api` and drives `mthds-agent --runner api validate bundle` across all four arms (valid→stdout, invalid→stderr+exit1, Markdown default, JSON on demand, `--error-format` override). The `pipelex-api`-boot fixture was promoted to the shared `conformance/fixtures.py` so the `pipelex_api` HTTP arm and this CLI arm reuse one booted server (no double boot, no duplicated checks — the HTTP arm pins the server wire under `pipelex-mthds-protocol.md`; this arm pins CLI presentation/routing under `mthds-agent-cli.md`).

**Still open (other spec, other repo — judgment call):**

- **C in `pipelex-mthds-protocol.md` (owned by `pipelex` + `pipelex-api`).** `PipelexRunner` (the local `pipelex` CLI runner) now returns a minimal invalid arm `{ is_valid: false, validation_errors: [] }` on exit 1 instead of throwing. The empty `validation_errors[]` is in tension with the non-empty-errors invariant (`:217`, `:284`), though that invariant is stated for the `pipelex-agent`/API surfaces, not the bare `pipelex` CLI runner. Decide whether to carve out the CLI-runner wrapper or require it to populate errors. (A spec edit here needs a paired `conformance/` test update + `make check-spec-links`.)

## Aligned Changes

- **`render` request param + `rendered_markdown` response field** on both verdict arms (`src/runners/api/client.ts:443-465`; `src/runners/api/models.ts` — `rendered_markdown?` on `PipelexValidationReport` and `PipelexInvalidReport`). Documented in `pipelex-mthds-protocol.md` §"Opt-in `rendered_markdown`" (`:240-251`); **verified by** `tests/pipelex_api/test_validate_render.py`.
- **Hook switch from Markdown-grepping to structured JSON envelope parsing** (`is_valid`/`error_domain`/`validation_errors`): `hook-lint-pipeline.md:90` already specifies "reads stderr as JSON," and `mthds-agent-cli.md:946-948` describes the JSON-parse decision. Removal of `stripErrorSourceSection`/`extractErrorDomain` is internal.
- **`PipelexRunner` exit-0 minimal valid arm `{ is_valid: true }`** (behavior unchanged; comment reworded, `src/runners/pipelex/runner.ts:462-469`) — consistent with the protocol allowance for a CLI runner to return minimal discriminant arms.
- **Markdown helpers exit semantics** (`agentMarkdownSuccess` → stdout/exit 0; `agentMarkdownError` → stderr/`process.exit(1)`, `src/agent/output.ts:52-67`) — mirror the local CLI's success-stdout / failure-stderr-nonzero convention per `pipelex-mthds-protocol.md` §"Presentation vs contract."
- **Stub sync**: `pipelex-commands.ts` registers the full canonical set (`init`, `validate`, `run`, `concept`, `pipe`, `models`, `check-model`, `inputs`, `accept-gateway-terms`); `api-commands.ts` registers `concept`, `pipe`, `validate`, `inputs`, `run`, `models`, `check-model` and legitimately omits `init` and `accept-gateway-terms` (`mthds-agent-cli.md:382` — API runner doesn't implement `init`; gateway-terms is pipelex-only). No drift.
- **Dependency floor bumps** (`src/agent/binaries.ts` `pipelex >=0.35.0`; `src/agent/plugin-version.ts` `MIN_PLUGIN_VERSION >=0.14.0`) — internal/awareness; not a wire-shape change. (`mthds-agent-cli.md:907` lists an illustrative `>=0.25.0` pinning note, not a hard-verified floor.)
