/**
 * Plugin version checking for the mthds plugin under Claude Code and Codex.
 *
 * Detects the active host (Claude Code or Codex), reads the appropriate
 * plugin registry, and checks the installed version against
 * MIN_PLUGIN_VERSION. Returns null when no known host is detected (file
 * absent on disk and no CODEX_HOME env).
 *
 * Bump MIN_PLUGIN_VERSION each release alongside min_mthds_version in the
 * plugin's targets/defaults.toml.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import semver from "semver";
import type { BinaryCheckEntry } from "./update-cache.js";

// ── Constants ──────────────────────────────────────────────────────

/** Minimum plugin version this mthds-agent release requires. */
export const MIN_PLUGIN_VERSION = ">=0.10.2";

/** Keys in installed_plugins.json for the mthds plugin (prod and dev targets). */
export const PLUGIN_KEYS = [
  "mthds@mthds-plugins",
  "mthds-dev@mthds-plugins",
] as const;

/** Codex marketplace + plugin names searched under $CODEX_HOME/plugins/cache. */
const CODEX_MARKETPLACE = "mthds-plugins";
const CODEX_PLUGIN_NAMES = ["mthds", "mthds-dev"] as const;

/** Sentinel directory name Codex uses for local dev installs. */
const CODEX_LOCAL_VERSION = "local";

/** Path to Claude Code's installed plugins registry. */
export const INSTALLED_PLUGINS_PATH = join(
  homedir(),
  ".claude",
  "plugins",
  "installed_plugins.json"
);

// ── Types ──────────────────────────────────────────────────────────

/** A host that exposes an mthds plugin install. `detectHost()` returns this or null. */
export type PluginHost = "claude" | "codex";

interface PluginEntry {
  scope: string;
  version: string;
  [key: string]: unknown;
}

interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, PluginEntry[]>;
}

interface CodexPluginManifest {
  version?: unknown;
  [key: string]: unknown;
}

// ── Host detection ─────────────────────────────────────────────────

/** Resolve $CODEX_HOME (defaulting to ~/.codex). */
function codexHomeDir(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function codexCacheDir(): string {
  return join(codexHomeDir(), "plugins", "cache");
}

/**
 * Detect the host that this mthds-agent process is running under.
 *
 * `CLAUDECODE=1` is the strongest signal: it's set by Claude Code at runtime
 * (not something users would export in a shell profile), so if it's present
 * we are definitively running inside Claude Code. We trust it even when the
 * Claude registry file is absent — that just means no plugin is installed
 * yet (fresh Claude Code install, or a session that never installed
 * anything). In that case `checkPluginVersion("claude")` returns null and
 * nothing is emitted; importantly we avoid falling through to "codex" and
 * surfacing the wrong upgrade command (e.g. "/plugins install mthds") to a
 * Claude Code user just because a leftover Codex cache dir happens to exist
 * on disk.
 *
 * `$CODEX_HOME` alone is not enough to claim Codex — a user might export it
 * in their shell profile for customization. We require the cache directory
 * to exist as corroborating evidence (Codex creates it on first plugin
 * install).
 *
 * Order of checks:
 *   1. CLAUDECODE=1                                          → "claude"
 *   2. ~/.codex/plugins/cache/ exists (honoring $CODEX_HOME) → "codex"
 *   3. ~/.claude/plugins/installed_plugins.json exists       → "claude"
 *   4. none of the above                                     → null
 */
export function detectHost(): PluginHost | null {
  if (process.env.CLAUDECODE === "1") return "claude";
  if (existsSync(codexCacheDir())) return "codex";
  if (existsSync(INSTALLED_PLUGINS_PATH)) return "claude";
  return null;
}

// ── Update command per host ────────────────────────────────────────

/** Command to run inside the host to install / upgrade the plugin. */
export function pluginUpdateCommand(host: PluginHost): string {
  switch (host) {
    case "codex":
      return "/plugins install mthds";
    case "claude":
      return "claude plugin install mthds@mthds-plugins";
  }
}

// ── Claude registry reader ─────────────────────────────────────────

/**
 * Read the installed plugin version from Claude Code's registry.
 *
 * Returns:
 *   - { version: "0.10.1" }   — plugin entry parsed successfully
 *   - { version: null }       — registry missing / corrupt / unknown sentinel
 *   - { version: "missing" }  — registry present, plugin not installed
 */
function readClaudePluginVersion():
  | { kind: "version"; version: string }
  | { kind: "missing" }
  | { kind: "null" } {
  let content: string;
  try {
    content = readFileSync(INSTALLED_PLUGINS_PATH, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "null" };
    process.stderr.write(
      `Warning: could not read ${INSTALLED_PLUGINS_PATH} (${code ?? String(err)}). Plugin version check skipped.\n`
    );
    return { kind: "null" };
  }

  let parsed: InstalledPluginsFile;
  try {
    const raw: unknown = JSON.parse(content);
    if (!raw || typeof raw !== "object" || !("plugins" in raw)) return { kind: "null" };
    const plugins = (raw as Record<string, unknown>).plugins;
    if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return { kind: "null" };
    parsed = raw as InstalledPluginsFile;
  } catch {
    process.stderr.write(
      `Warning: ${INSTALLED_PLUGINS_PATH} contains invalid JSON. Plugin version check skipped.\n`
    );
    return { kind: "null" };
  }

  let entries: PluginEntry[] | undefined;
  for (const key of PLUGIN_KEYS) {
    const candidate = parsed.plugins[key];
    if (candidate && Array.isArray(candidate) && candidate.length > 0) {
      entries = candidate as PluginEntry[];
      break;
    }
  }
  if (!entries) return { kind: "missing" };

  const userEntry = entries.find((e) => e.scope === "user") ?? entries[0]!;
  const version = userEntry.version;
  if (!version || typeof version !== "string") return { kind: "missing" };

  return { kind: "version", version };
}

// ── Codex registry reader ──────────────────────────────────────────

/**
 * Read the installed plugin version from Codex's plugin cache.
 *
 * Codex stores plugins at:
 *   $CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/.codex-plugin/plugin.json
 *
 * The directory name is the version. A directory named "local" is Codex's
 * dev sentinel — treat it like an unparseable version (don't nag).
 *
 * Returns the same shape as readClaudePluginVersion().
 */
export function readCodexPluginVersion():
  | { kind: "version"; version: string }
  | { kind: "missing" }
  | { kind: "null" } {
  const cacheRoot = codexCacheDir();
  // Track whether any plugin dir was unreadable for a non-"absent" reason
  // (EACCES, EIO, ...). If so, don't claim "missing" at the end — that would
  // tell the user to reinstall a plugin we couldn't actually inspect.
  let sawReadError = false;
  // Track whether any plugin dir had entries but none parsed as semver. If so,
  // don't claim "missing" at the end — the install exists, we just don't
  // recognize the version layout (e.g. a future Codex build).
  let sawUnparseableDirs = false;

  for (const pluginName of CODEX_PLUGIN_NAMES) {
    const pluginDir = join(cacheRoot, CODEX_MARKETPLACE, pluginName);

    let names: string[];
    try {
      names = readdirSync(pluginDir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        sawReadError = true;
        process.stderr.write(
          `Warning: could not read Codex plugin dir ${pluginDir} (${code ?? String(err)}). Plugin version check skipped.\n`
        );
      }
      continue;
    }

    const versionDirs: string[] = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      try {
        if (!statSync(join(pluginDir, name)).isDirectory()) continue;
      } catch {
        continue;
      }
      versionDirs.push(name);
    }

    if (versionDirs.length === 0) continue;

    // Codex's dev sentinel — caller should treat this like "unparseable".
    if (versionDirs.includes(CODEX_LOCAL_VERSION)) return { kind: "null" };

    // Pick the highest semver-coercible version directory.
    let bestDirName: string | null = null;
    let bestVersion: string | null = null;
    for (const name of versionDirs) {
      const coerced = semver.coerce(name);
      if (!coerced) continue;
      if (!bestVersion || semver.gt(coerced.version, bestVersion)) {
        bestDirName = name;
        bestVersion = coerced.version;
      }
    }
    if (!bestDirName) {
      // Directories exist but none parse as semver — treat as unknown and
      // fall through to the next candidate plugin name (e.g. mthds-dev).
      sawUnparseableDirs = true;
      continue;
    }

    // Prefer the manifest's version field when present (covers renamed dirs).
    const manifestPath = join(pluginDir, bestDirName, ".codex-plugin", "plugin.json");
    let manifestVersion: string | null = null;
    try {
      const raw: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
      if (raw && typeof raw === "object") {
        const v = (raw as CodexPluginManifest).version;
        if (typeof v === "string" && v.length > 0) {
          manifestVersion = v;
        }
      }
    } catch {
      /* fall back to directory name */
    }

    const finalVersion = manifestVersion ?? bestDirName;
    return { kind: "version", version: finalVersion };
  }

  // No matching plugin directory under the Codex cache. If we couldn't even
  // read one of the candidate dirs, or if we saw dirs with non-semver names,
  // treat as "skip" — telling the user to reinstall when the real cause was
  // unreadable perms or an unrecognized version layout would be misleading.
  return sawReadError || sawUnparseableDirs ? { kind: "null" } : { kind: "missing" };
}

// ── Main ───────────────────────────────────────────────────────────

/**
 * Check the installed plugin version against MIN_PLUGIN_VERSION for the
 * given host.
 *
 * Returns:
 *   - `{ s: "ok", v: "0.10.1" }`                                  — satisfies constraint
 *   - `{ s: "outdated", v: "0.6.2", r: ">=0.10.1" }`              — too old
 *   - `{ s: "missing", v: null, r: ">=0.10.1" }`                  — registry present, plugin absent
 *   - `null`                                                       — registry unreadable, unparseable, or dev install
 *
 * Caller is expected to call `detectHost()` first and skip when it returns
 * null — there is no "no host" return value here.
 */
export function checkPluginVersion(host: PluginHost): BinaryCheckEntry | null {
  const result =
    host === "codex" ? readCodexPluginVersion() : readClaudePluginVersion();

  if (result.kind === "null") return null;
  if (result.kind === "missing") {
    return { s: "missing", v: null, r: MIN_PLUGIN_VERSION };
  }

  const coerced = semver.coerce(result.version);
  if (!coerced) {
    // Unparseable version string — don't nag (matches "unknown" handling).
    return null;
  }

  if (semver.satisfies(coerced, MIN_PLUGIN_VERSION)) {
    return { s: "ok", v: coerced.version };
  }

  return { s: "outdated", v: coerced.version, r: MIN_PLUGIN_VERSION };
}
