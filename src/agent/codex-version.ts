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
 * silently off. The floor is the version the plugin is tested against; below
 * it we warn rather than hard-error, because 0.131–0.140 setups do work.
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
export const MIN_CODEX_VERSION = "0.141.0";

/** Warning code emitted when the detected Codex is below MIN_CODEX_VERSION. */
export const CODEX_VERSION_TOO_OLD = "CODEX_VERSION_TOO_OLD";

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
 * Best-effort minimum-version check. Returns a warning entry (same shape as
 * CodexConfigWarning) when the detected Codex is older than the supported
 * floor, or null when Codex is recent enough or cannot be detected.
 */
export function codexVersionWarning(): { code: string; message: string } | null {
  const detected = detectCodexVersion();
  if (detected === null || !semver.lt(detected, MIN_CODEX_VERSION)) return null;
  return {
    code: CODEX_VERSION_TOO_OLD,
    message: `Codex ${detected} is older than ${MIN_CODEX_VERSION}, the minimum version the mthds plugin supports — the bundled validation hook may not load. Upgrade Codex to ${MIN_CODEX_VERSION} or newer.`,
  };
}
