/**
 * Codex ~/.codex/hooks.json legacy cleanup.
 *
 * mthds-plugins used to wire the .mthds validation hook into ~/.codex/hooks.json
 * via `mthds-agent codex install-hook`. The hook now ships inside the plugin
 * (mthds-codex/hooks/codex-hooks.json, discovered through the plugin manifest),
 * so `install-hook` is gone.
 *
 * Any leftover ~/.codex/hooks.json entry from an older install would fire a
 * SECOND `mthds-agent codex hook` concurrently with the plugin-bundled hook —
 * two `plxt fmt` runs racing on the same file. `apply-config` removes the stale
 * entry and `doctor` reports it.
 *
 * "Ours" = any hook handler whose command matches a known mthds marker, in
 * either the legacy `Stop` slot (pre-0.5.0 bash script) or `PostToolUse` (the
 * bash script or the `mthds-agent codex hook` runtime). The plugin-bundled copy
 * lives inside the plugin directory, never in ~/.codex/hooks.json, so removing
 * every mthds entry from ~/.codex/hooks.json is unambiguously correct.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ── Constants ──────────────────────────────────────────────────────

// Substrings that identify entries previously written by `install-hook` or
// the retired install-codex.sh script. Any handler whose command contains one
// of these is "ours" and gets swept.
const LEGACY_MARKERS = ["codex-validate-mthds", "mthds-agent codex hook"];

// ── Types ──────────────────────────────────────────────────────────

interface HookCommand {
  type?: string;
  command?: string;
  timeout?: number;
}

interface HookEntry {
  matcher?: string;
  hooks?: HookCommand[];
}

interface ParsedHooks {
  hooks?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface LegacyHookInspection {
  hooks_file: string;
  exists: boolean;
  has_legacy_entry: boolean;
  parse_error?: string;
}

export interface LegacyHookRemoval {
  hooks_file: string;
  status: "removed" | "absent" | "error";
  error?: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function hooksFilePath(): string {
  return join(homedir(), ".codex", "hooks.json");
}

function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o644 });
  renameSync(tmp, path);
}

function entryIsOurs(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const cmds = (entry as HookEntry).hooks;
  if (!Array.isArray(cmds)) return false;
  return cmds.some(
    (h) =>
      typeof h?.command === "string" &&
      LEGACY_MARKERS.some((m) => h.command!.includes(m)),
  );
}

interface ReadResult {
  exists: boolean;
  parsed?: ParsedHooks;
  parseError?: string;
}

/** Read and JSON-parse ~/.codex/hooks.json. Never throws — malformed input is
 *  reported via `parseError` so callers can treat it as a warning rather than
 *  a crash. An empty file parses to {} (an existing-but-empty hooks.json). */
function readHooksFile(file: string): ReadResult {
  if (!existsSync(file)) return { exists: false };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return { exists: true, parseError: `Failed to read ${file}: ${(err as Error).message}` };
  }
  if (raw.trim().length === 0) return { exists: true, parsed: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { exists: true, parseError: `Invalid JSON in ${file}: ${(err as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { exists: true, parseError: `${file} does not contain a JSON object at the top level.` };
  }
  return { exists: true, parsed: parsed as ParsedHooks };
}

/** True when any mthds entry is present in the `Stop` or `PostToolUse` slot. */
function hasLegacyEntry(parsed: ParsedHooks): boolean {
  const hooks = parsed.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return false;
  const table = hooks as Record<string, unknown>;
  return [table.Stop, table.PostToolUse].some(
    (slot) => Array.isArray(slot) && slot.some(entryIsOurs),
  );
}

// ── Public API ─────────────────────────────────────────────────────

/** Read-only inspection of ~/.codex/hooks.json — used by doctor and the
 *  apply-config --check / --dry-run paths. */
export function inspectLegacyCodexHook(): LegacyHookInspection {
  const file = hooksFilePath();
  const read = readHooksFile(file);
  if (!read.exists) {
    return { hooks_file: file, exists: false, has_legacy_entry: false };
  }
  if (read.parseError !== undefined) {
    return { hooks_file: file, exists: true, has_legacy_entry: false, parse_error: read.parseError };
  }
  return { hooks_file: file, exists: true, has_legacy_entry: hasLegacyEntry(read.parsed!) };
}

/** Remove every mthds entry from ~/.codex/hooks.json, preserving all unrelated
 *  hooks, hook events, and top-level keys. A `Stop` / `PostToolUse` array that
 *  becomes empty is dropped. Never throws — failures surface via `status`. */
export function removeLegacyCodexHook(): LegacyHookRemoval {
  const file = hooksFilePath();
  const read = readHooksFile(file);
  if (!read.exists) return { hooks_file: file, status: "absent" };
  if (read.parseError !== undefined) {
    return { hooks_file: file, status: "error", error: read.parseError };
  }
  const parsed = read.parsed!;
  if (!hasLegacyEntry(parsed)) return { hooks_file: file, status: "absent" };

  const hooks = parsed.hooks as Record<string, unknown>;
  for (const slot of ["Stop", "PostToolUse"]) {
    const arr = hooks[slot];
    if (!Array.isArray(arr)) continue;
    const kept = arr.filter((entry) => !entryIsOurs(entry));
    if (kept.length === 0) {
      delete hooks[slot];
    } else {
      hooks[slot] = kept;
    }
  }
  // Drop the `hooks` key entirely once it is empty, mirroring the per-slot
  // cleanup above — a residual `{}` would leave the file in a shape no tool
  // wrote.
  if (Object.keys(hooks).length === 0) {
    delete parsed.hooks;
  }

  try {
    writeAtomic(file, JSON.stringify(parsed, null, 2) + "\n");
  } catch (err) {
    return { hooks_file: file, status: "error", error: `Failed to write ${file}: ${(err as Error).message}` };
  }
  return { hooks_file: file, status: "removed" };
}
