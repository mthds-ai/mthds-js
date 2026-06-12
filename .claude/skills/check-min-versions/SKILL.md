---
name: check-min-versions
description: >
  Show the minimum required versions that this mthds-agent release enforces at
  runtime — the Claude Code mthds plugin, pipelex (and pipelex-agent, same
  package), and plxt. Read-only: reports the current floors without changing
  anything. Use when the user says "check min versions", "what are the required
  versions", "show minimum versions", "what's the min pipelex version", "current
  version floors", "which plxt version do we require", "show required versions",
  or any variation of asking what the current minimums are. This is the read-only
  counterpart to the bump-required-versions skill — if the user wants to *change*
  a floor, use that one instead.
---

# Check Required Versions

Reports the minimum version constraints that this `mthds-agent` release enforces against its three runtime dependencies. This skill only reads and reports — it never edits. To change a floor, use the `bump-required-versions` skill.

## The three floors and where they live

These constants are the single source of truth (the same ones `bump-required-versions` edits):

- **Claude Code mthds plugin** — `MIN_PLUGIN_VERSION` in `src/agent/plugin-version.ts`. The agent checks the *plugin* is recent enough (opposite direction from the package floors below).
- **pipelex** PyPI package (provides both the `pipelex` and `pipelex-agent` binaries) — `PIPELEX_PKG.version_constraint` in `src/agent/binaries.ts`.
- **pipelex-tools** PyPI package (provides the `plxt` binary) — `PIPELEX_TOOLS_PKG.version_constraint` in `src/agent/binaries.ts`.

The constraint format in all three is an npm-semver range string: `">=X.Y.Z"`.

## Workflow

### 1. Read the current values

Run this from the `mthds-js` repo root to pull all three floors in one shot:

```bash
grep -nE 'MIN_PLUGIN_VERSION\s*=' src/agent/plugin-version.ts
grep -nE 'version_constraint:\s*"' src/agent/binaries.ts
```

The first command yields the plugin floor. The second yields two lines — the first belongs to `PIPELEX_PKG` (pipelex / pipelex-agent), the second to `PIPELEX_TOOLS_PKG` (plxt). The `:\s*"` in the pattern is deliberate: it matches only the constraint *values* (which are quoted strings) and skips the `version_constraint: string;` field declaration in the `BinaryRecoveryInfo` interface, which would otherwise show up as a phantom third match. If the two value lines ever look ambiguous, open `src/agent/binaries.ts` and confirm which constant each one sits under — the constant name is what disambiguates them.

### 2. Report

Present the floors as a compact table so the user can read them at a glance:

```
Target    Package         Min version   Source
plugin    (mthds plugin)  >=X.Y.Z       src/agent/plugin-version.ts
pipelex   pipelex         >=X.Y.Z       src/agent/binaries.ts   (also pipelex-agent)
plxt      pipelex-tools   >=X.Y.Z       src/agent/binaries.ts
```

Note in the report that `pipelex` and `pipelex-agent` share one floor (they ship from the same PyPI package), and that the plugin floor is checked in the opposite direction — the agent requires the plugin to be at least this version.

That's the whole job. Don't run `make check`, don't edit anything, don't suggest a bump unless the user asks.
