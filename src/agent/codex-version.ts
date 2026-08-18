/**
 * Minimum Codex app version supported by the mthds plugin, and its
 * best-effort runtime detection.
 *
 * Why a floor exists: plugin-bundled hooks only load out of the box on recent
 * Codex. The `[features]` history in the Codex source is:
 *   - 0.124  hook engine (`codex_hooks`, later renamed `hooks`) Stable and
 *            enabled by default
 *   - 0.126–0.130  plugin-bundled hooks exist but require the
 *            `plugin_hooks = true` opt-in (default false)
 *   - 0.131  `plugin_hooks` flipped to default-on
 *   - 0.134  `plugin_hooks` removed entirely — the key is ignored, and plugin
 *            hook loading follows plugin enablement directly
 * `apply-config` writes no hook feature flag (the key it used to write no
 * longer exists), so on a Codex older than the floor the mthds hook can stay
 * silently off. The check is two-tiered: below 0.131 the bundled hook cannot
 * load at all — that is a hard error (success would be a false positive);
 * between 0.131 and the tested floor the setup works, so it is only a
 * warning.
 *
 * Detection shells out to `codex --version` (output like `codex-cli 0.142.5`)
 * and is strictly best-effort: any failure — binary not on PATH, timeout,
 * unparseable output — yields null and no warning, never an error. The check
 * runs in setup/diagnostic commands only (`codex apply-config`, `doctor`).
 */

import { execFileSync } from "node:child_process";
import semver from "semver";

/** Minimum Codex app version the mthds plugin supports (see history above).
 *  Managed by the bump-required-versions skill alongside the other floors. */
export const MIN_CODEX_VERSION = "0.144.0";

/** Below this version plugin-bundled hooks cannot load at all: they were
 *  gated behind the `plugin_hooks` opt-in (default-off before 0.131), and
 *  that key was removed in 0.134 so there is nothing left to write. This is
 *  a fixed historical boundary of Codex itself — unlike MIN_CODEX_VERSION it
 *  is never bumped. */
export const CODEX_PLUGIN_HOOKS_MIN = "0.131.0";

/** Warning code: Codex is below MIN_CODEX_VERSION but hooks still load. */
export const CODEX_VERSION_TOO_OLD = "CODEX_VERSION_TOO_OLD";

/** Error code: Codex is below CODEX_PLUGIN_HOOKS_MIN — the hook cannot load. */
export const CODEX_HOOKS_UNAVAILABLE = "CODEX_HOOKS_UNAVAILABLE";

/** Two-tier verdict on the installed Codex version. */
export interface CodexVersionFinding {
  code: typeof CODEX_VERSION_TOO_OLD | typeof CODEX_HOOKS_UNAVAILABLE;
  severity: "warning" | "error";
  message: string;
}

/**
 * Detect the installed Codex CLI version. Returns the bare semver string
 * (e.g. "0.142.5") or null when it cannot be determined. Never throws.
 */
export function detectCodexVersion(): string | null {
  let rawOutput: string;
  try {
    rawOutput = execFileSync("codex", ["--version"], {
      stdio: "pipe",
      timeout: 5000,
      // npm installs the Codex CLI as a `codex.cmd` shim on Windows, which
      // Node refuses to spawn without a shell (EINVAL) — detection would be
      // silently bypassed on that platform. Command and args are fixed
      // strings, so shell interpolation has nothing to escape.
      shell: process.platform === "win32",
    })
      .toString()
      .trim();
  } catch {
    return null;
  }

  const match = rawOutput.match(/\d+\.\d+\.\d+/);
  if (!match) return null;
  const parsed = semver.coerce(match[0]);
  return parsed ? parsed.version : null;
}

/**
 * Best-effort minimum-version check, two-tiered:
 *   - below CODEX_PLUGIN_HOOKS_MIN → severity "error": plugin-bundled hooks
 *     cannot load on that Codex and there is no key apply-config could write
 *     to fix it — reporting success would be a false positive.
 *   - below MIN_CODEX_VERSION (but hooks-capable) → severity "warning": the
 *     setup works but is older than the floor the plugin is tested against.
 * Returns null when Codex is recent enough or cannot be detected.
 */
export function assessCodexVersion(): CodexVersionFinding | null {
  const detected = detectCodexVersion();
  if (detected === null || !semver.lt(detected, MIN_CODEX_VERSION)) return null;
  if (semver.lt(detected, CODEX_PLUGIN_HOOKS_MIN)) {
    return {
      code: CODEX_HOOKS_UNAVAILABLE,
      severity: "error",
      message: `Codex ${detected} cannot load plugin-bundled hooks: they were gated behind the plugin_hooks opt-in flag (default-off before Codex ${CODEX_PLUGIN_HOOKS_MIN}), which was removed in 0.134 and can no longer be written — the mthds validation hook will not load. Upgrade Codex to ${MIN_CODEX_VERSION} or newer, then re-run \`mthds-agent codex apply-config\`.`,
    };
  }
  return {
    code: CODEX_VERSION_TOO_OLD,
    severity: "warning",
    message: `Codex ${detected} is older than ${MIN_CODEX_VERSION}, the minimum version the mthds plugin supports — the bundled validation hook may not load. Upgrade Codex to ${MIN_CODEX_VERSION} or newer.`,
  };
}
