# CLI Contract Check — mthds-js

**Date**: 2026-03-24
**Repo**: mthds-js (npm: `mthds`)
**Branch**: fix/CLI-contracts
**Baseline**: `v0.1.3` (user-specified)
**Target**: HEAD (`66d6105`)

**Contracts checked**:
- `docs/contracts/mthds-agent-cli.md` — mthds-agent CLI (owned by mthds-js)
- `docs/contracts/plxt-cli.md` — plxt CLI (owned by vscode-pipelex)
- `docs/contracts/hook-lint-pipeline.md` — hook pipeline (owned by skills)

---

| Category | Count | Resolution needed? |
|---|---|---|
| Discrepancies | 3 | Yes |
| Unmatched additions | 2 | Yes |
| Aligned changes | 7 | No |

**3 discrepancies and 2 unmatched items require resolution before release.**

---

## Discrepancies

### 1. `concept` output format — JSON-wrapped vs raw TOML

- **What the code does**: `src/agent/commands/runner-commands.ts:134` calls `agentSuccess({ ...result })`, which outputs a JSON envelope (`{ "success": true, "concept_code": "...", "toml": "..." }`) to stdout.
- **What the contract says**: `docs/contracts/mthds-agent-cli.md` lines 249–261 — "Returns raw TOML (not JSON-wrapped)." with example showing bare TOML on stdout.
- **What changed**: The code was newly added in this diff (previously `concept` lived under `mthds-agent pipelex concept` which used passthrough to `pipelex-agent`). The new implementation uses the Runner interface and wraps the result in JSON. The contract was written to describe the passthrough behavior (raw TOML from `pipelex-agent`), but the code now uses a different output path.

### 2. `pipe` output format — JSON-wrapped vs raw TOML

- **What the code does**: `src/agent/commands/runner-commands.ts:196` calls `agentSuccess({ ...result })`, outputting JSON.
- **What the contract says**: `docs/contracts/mthds-agent-cli.md` lines 263–279 — "Returns raw TOML (not JSON-wrapped)." with example showing bare TOML on stdout.
- **What changed**: Same as `concept` — migrated from pipelex passthrough to Runner interface. JSON-wrapped output now instead of raw TOML. The pipelex runner path no longer exists for this command (no passthrough fallback).

### 3. `assemble` output format — JSON-wrapped vs raw TOML

- **What the code does**: `src/agent/commands/runner-commands.ts:270` calls `agentSuccess({ ...result })`, outputting JSON.
- **What the contract says**: `docs/contracts/mthds-agent-cli.md` line 294 — "Success output (raw TOML to stdout)."
- **What changed**: Same pattern as above — migrated from passthrough to Runner interface.

---

## Unmatched Additions

### In contract but not in code

**1. `mthds-agent check-model` command**

The contract documents `check-model` at `docs/contracts/mthds-agent-cli.md` lines 316–325 with `--type` and `--format json` options, fuzzy matching, and "Did you mean?" suggestions. No implementation exists in the codebase — `check-model` / `checkModel` returns zero grep hits across `src/`. Either the command was never implemented, or it was planned and not yet built.

**2. `mthds-agent models --format <json|markdown>` option**

The contract (`docs/contracts/mthds-agent-cli.md` lines 301–303) documents `--format json` for structured JSON output vs default markdown. The code at `src/agent/commands/runner-commands.ts:808-834` only has `--type` (filter by category) — no `--format` option. Output is always JSON via `agentSuccess()`.

### In code but not in contract

**`mthds-agent pipe --type <type>` CLI option**

The code at `src/agent/commands/runner-commands.ts:570` defines `--type <type>` as a required separate CLI flag ("Pipe type (PipeLLM, PipeSequence, etc.)"). The contract at `docs/contracts/mthds-agent-cli.md` line 272 mentions `type` only as a field inside the `--spec` JSON payload, not as a separate CLI flag. Consumers calling `mthds-agent pipe` need to know whether to pass `--type PipeLLM --spec '{...}'` (what the code expects) or include `type` inside the `--spec` JSON (what the contract implies).

---

## Aligned Changes

1. **`mthds-agent pipelex` subcommand group removed** — Both code and contract now have runner-aware commands at the top level. Contract documents this correctly. CHANGELOG labels it as a breaking change.
2. **`--runner <type>` global option** — Code and contract agree: `api | pipelex`, falls back to config default.
3. **`build pipe` command removed** — Removed from both code and contract. CHANGELOG marks it as breaking.
4. **`mthds_contents: string[]` (plural, array)** — Runner interface types changed from `mthds_content: string` to `mthds_contents: string[]`. This is internal to the Runner interface and not directly visible at the CLI level, but CHANGELOG documents it correctly as a breaking change for SDK consumers.
5. **`validate`, `run`, `inputs` now top-level** — Both code and contract show these as top-level commands with runner dispatch.
6. **`concept`, `pipe`, `assemble` now top-level** — Both code and contract register these at the top level (previously only under `pipelex` group).
7. **No changes to plxt passthrough or hook pipeline** — `plxt fmt`/`lint` passthrough and hook pipeline are unchanged. `plxt-cli.md` and `hook-lint-pipeline.md` remain aligned.
