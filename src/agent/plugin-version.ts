/**
 * Plugin version checking for the Claude Code mthds plugin.
 *
 * Reads ~/.claude/plugins/installed_plugins.json to detect whether the
 * installed plugin version satisfies the minimum required by this mthds-agent
 * release. Returns null when not running inside Claude Code (file absent).
 *
 * Bump MIN_PLUGIN_VERSION each release alongside min_mthds_version in the
 * plugin's targets/defaults.toml.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import semver from "semver";
import type { BinaryCheckEntry } from "./update-cache.js";

// ── Constants ──────────────────────────────────────────────────────

/** Minimum plugin version this mthds-agent release requires. */
export const MIN_PLUGIN_VERSION = ">=0.7.0";

/** Keys in installed_plugins.json for the mthds plugin (prod and dev targets). */
export const PLUGIN_KEYS = [
  "mthds@mthds-plugins",
  "mthds-dev@mthds-plugins",
] as const;

/** Command to update the plugin (prod). */
export const PLUGIN_UPDATE_CMD = "claude plugin install mthds@mthds-plugins";

/** Path to Claude Code's installed plugins registry. */
export const INSTALLED_PLUGINS_PATH = join(
  homedir(),
  ".claude",
  "plugins",
  "installed_plugins.json"
);

// ── Types ──────────────────────────────────────────────────────────

interface PluginEntry {
  scope: string;
  version: string;
  [key: string]: unknown;
}

interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, PluginEntry[]>;
}

// ── Main ───────────────────────────────────────────────────────────

/**
 * Check the installed Claude Code plugin version against MIN_PLUGIN_VERSION.
 *
 * Returns:
 * - `{ s: "ok", v: "0.7.1" }`     — plugin installed and satisfies constraint
 * - `{ s: "outdated", v: "0.6.2", r: ">=0.7.0" }` — plugin too old
 * - `{ s: "missing", v: null }`    — plugin key exists but no user-scope entry
 * - `null`                         — not in Claude Code (file absent or corrupt)
 */
export function checkPluginVersion(): BinaryCheckEntry | null {
  let content: string;
  try {
    content = readFileSync(INSTALLED_PLUGINS_PATH, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null; // File doesn't exist — not in Claude Code
    process.stderr.write(
      `Warning: could not read ${INSTALLED_PLUGINS_PATH} (${code ?? String(err)}). Plugin version check skipped.\n`
    );
    return null;
  }

  let parsed: InstalledPluginsFile;
  try {
    const raw: unknown = JSON.parse(content);
    if (!raw || typeof raw !== "object" || !("plugins" in raw)) return null;
    const plugins = (raw as Record<string, unknown>).plugins;
    if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return null;
    parsed = raw as InstalledPluginsFile;
  } catch {
    process.stderr.write(
      `Warning: ${INSTALLED_PLUGINS_PATH} contains invalid JSON. Plugin version check skipped.\n`
    );
    return null;
  }

  // Try each known plugin key (prod first, then dev)
  let entries: PluginEntry[] | undefined;
  for (const key of PLUGIN_KEYS) {
    const candidate = parsed.plugins[key];
    if (candidate && Array.isArray(candidate) && candidate.length > 0) {
      entries = candidate as PluginEntry[];
      break;
    }
  }
  if (!entries) {
    // No known plugin key found — plugin not installed at all
    return { s: "missing", v: null, r: MIN_PLUGIN_VERSION };
  }

  // Prefer scope=user; fall back to first entry
  const userEntry = entries.find((e) => e.scope === "user") ?? entries[0]!;
  const version = userEntry.version;

  if (!version || typeof version !== "string") {
    return { s: "missing", v: null, r: MIN_PLUGIN_VERSION };
  }

  const coerced = semver.coerce(version);
  if (!coerced) {
    // Unparseable version (e.g. "unknown") — don't nag
    return null;
  }

  if (semver.satisfies(coerced, MIN_PLUGIN_VERSION)) {
    return { s: "ok", v: coerced.version };
  }

  return { s: "outdated", v: coerced.version, r: MIN_PLUGIN_VERSION };
}
