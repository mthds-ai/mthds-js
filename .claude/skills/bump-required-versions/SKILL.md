---
name: bump-required-versions
description: >
  Bump the minimum required versions that mthds-agent enforces at runtime — the
  Claude Code mthds plugin, pipelex (and pipelex-agent, same package), and plxt.
  Use when the user says "bump required versions", "bump min pipelex version",
  "bump minimum plxt version", "raise minimum plugin version", "update required
  versions", "set min pipelex to X.Y.Z", "bump min mthds plugin version", or any
  variation of changing one or more of these floors. Trigger even when the user
  names only one of the three targets — this skill handles partial updates.
---

# Bump Required Versions

Updates the minimum version constraints that this `mthds-agent` release enforces against:

- The **Claude Code mthds plugin** (when running inside Claude Code) — `MIN_PLUGIN_VERSION` in `src/agent/plugin-version.ts`.
- The **pipelex** PyPI package (provides both the `pipelex` and `pipelex-agent` binaries) — `PIPELEX_PKG.version_constraint` in `src/agent/binaries.ts`.
- The **pipelex-tools** PyPI package (provides the `plxt` binary) — `PIPELEX_TOOLS_PKG.version_constraint` in `src/agent/binaries.ts`.

The constants in those two files are the single source of truth. Tests import the constants directly, so bumping these values does not require test edits — the test suite re-exercises the new floor automatically.

## Why each lives where it lives

- `MIN_PLUGIN_VERSION` enforces the *opposite* direction from the package constraints: the agent checks the **plugin** is recent enough. The plugin's own `min_mthds_version` (in `mthds-plugins/targets/defaults.toml`) enforces the agent is recent enough. Both versions get bumped on coordinated releases — but **this skill only bumps the agent side**. The plugin side has its own skill (`bump-mthds-version` in `mthds-plugins`).
- The `BINARY_RECOVERY` map keys binaries (`pipelex`, `pipelex-agent`, `plxt`), but each entry spreads a shared `*_PKG` constant. The package constants own the version constraint, so the `pipelex` and `pipelex-agent` binaries cannot drift apart even by accident — there is only one line to edit.

## Workflow

### 1. Determine which targets to bump and to what

If the user already specified targets and versions (e.g. "bump pipelex to 0.24.0 and plxt to 0.4.0"), use them.

Otherwise, ask which of the three to bump:

- **plugin** — the Claude Code mthds plugin floor (`MIN_PLUGIN_VERSION`)
- **pipelex** — the `pipelex` PyPI package floor (covers both the `pipelex` and `pipelex-agent` binaries)
- **plxt** — the `pipelex-tools` PyPI package floor (covers the `plxt` binary)

Then for each chosen target ask for the new version (semver `X.Y.Z`).

Show the current values first by reading:

- `src/agent/plugin-version.ts` — find `export const MIN_PLUGIN_VERSION = ">=X.Y.Z"`
- `src/agent/binaries.ts` — find `PIPELEX_PKG` and `PIPELEX_TOOLS_PKG`, each with a `version_constraint: ">=X.Y.Z"` field

### 2. Sanity-check the requested versions

For each requested bump, verify the new version is **strictly greater than** the current floor. Bumping to the same value is a no-op; bumping below is almost certainly a mistake — confirm with the user before proceeding if they ask for a downgrade.

### 3. Apply the edits

The constraint format in both files is a npm-semver range: `">=X.Y.Z"` (note the `>=` prefix and the surrounding quotes).

- **plugin** → edit the `MIN_PLUGIN_VERSION` constant in `src/agent/plugin-version.ts` (one line).
- **pipelex** → edit `PIPELEX_PKG.version_constraint` in `src/agent/binaries.ts` (one line). Both `pipelex` and `pipelex-agent` binaries pick this up automatically via the spread.
- **plxt** → edit `PIPELEX_TOOLS_PKG.version_constraint` in `src/agent/binaries.ts` (one line).

Each constant lives in its own block at the top of `binaries.ts`; use the constant name and the surrounding `as const;` line to make the Edit unambiguous.

### 4. Verify with `make check`

Run `make check` from the `mthds-js` repo root. This builds the project and runs the test suite; tests assert against the imported constants, so a successful run confirms the bumps are coherent.

If checks fail, report the errors. The most likely cause is a hardcoded "below the constraint" version in a test that is now *above* the new constraint — fix by lowering that hardcoded test version, not by reverting the bump.

### 5. Report

Summarise what changed:

```
plugin:        OLD → NEW
pipelex:       OLD → NEW   (also applied to pipelex-agent)
plxt:          OLD → NEW
```

Then remind the user to:

- **Add a CHANGELOG.md entry** under the next release describing the bumps and why (e.g., a feature in the new pipelex version that mthds-agent now relies on). The v0.5.0 entry's plugin bump note is a good template.
- **Coordinate the plugin side** if `MIN_PLUGIN_VERSION` was bumped: the matching `min_mthds_version` in `mthds-plugins/targets/defaults.toml` typically needs to point at the upcoming `mthds-agent` release for the cross-check to make sense. That edit happens in the `mthds-plugins` repo, not here.

Do not commit or create a release — leave that to the user (or to the `release` skill).
