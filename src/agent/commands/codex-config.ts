/**
 * mthds-agent codex apply-config — additively merge required Codex sandbox
 * settings into ~/.codex/config.toml so the mthds PostToolUse hook can run
 * without being blocked by Codex's default workspace-write sandbox.
 *
 * Currently the only required key is `[sandbox_workspace_write] network_access = true`.
 * Without it, any hook that fetches remote pipelex config (or any other
 * outbound request) hangs/fails inside the sandbox.
 *
 * Warning-only checks (we never modify these — too high-risk):
 *   - `[features] codex_hooks = false` — explicitly disables hooks
 *     (default is on as of Codex 0.124.0; codex-rs/features/src/lib.rs:768).
 *   - `sandbox_mode = "read-only"` — hook can't run apply_patch validation.
 *
 * Output statuses (via agentSuccess):
 *   - { status: "ALREADY_OK", config_file, warnings? }     — no changes needed
 *   - { status: "APPLIED", config_file, applied, warnings? } — diff merged + written
 *   - { status: "WOULD_APPLY", config_file, applied, warnings? } — --dry-run only
 *
 * Flags:
 *   --check    exits non-zero if anything would change (no writes, no warnings demoted)
 *   --dry-run  prints proposed diff and exits 0 without touching the file
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";
import { agentError, agentSuccess, AGENT_ERROR_DOMAINS } from "../output.js";

// ── Constants ──────────────────────────────────────────────────────
//
// Single-key invariant: this command currently enforces exactly one
// (table, key, value) tuple. `diffRequired` and `collectWarnings` are
// structured around that assumption — if a future requirement adds a
// second required key (e.g. a sandbox_mode default), both will need to
// fan out to a list rather than the singleton structure used here.

const REQUIRED_TABLE = "sandbox_workspace_write";
const REQUIRED_KEY = "network_access";
const REQUIRED_VALUE = true;

// ── Types ──────────────────────────────────────────────────────────

export interface AppliedChange {
  table: string;
  key: string;
  value: string;
}

export interface CodexConfigWarning {
  code: string;
  message: string;
}

export interface CodexConfigInspection {
  config_file: string;
  exists: boolean;
  needs_change: AppliedChange | null;
  warnings: CodexConfigWarning[];
  parse_error?: string;
}

interface ApplyConfigOptions {
  check?: boolean;
  dryRun?: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────

function configFilePath(): string {
  return join(homedir(), ".codex", "config.toml");
}

function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o644 });
  renameSync(tmp, path);
}

/**
 * Append a [table] section with key=value to existing TOML text. Used when
 * the table is missing entirely. We append rather than re-serialize so user
 * formatting/comments elsewhere in the file are preserved verbatim.
 */
function appendTomlTable(existing: string, table: string, key: string, value: string): string {
  const trimmed = existing.replace(/\s+$/, "");
  const sep = trimmed.length === 0 ? "" : "\n\n";
  return `${trimmed}${sep}[${table}]\n${key} = ${value}\n`;
}

/**
 * Insert key=value into an existing [table] section without re-serializing
 * the document. Locates the table header line, finds the end of its body
 * (next [section] header or EOF), and inserts the line just before that
 * boundary. This preserves comments and ordering of every other table.
 */
function insertIntoExistingTable(
  existing: string,
  table: string,
  key: string,
  value: string,
): string {
  const lines = existing.split("\n");
  const headerRegex = new RegExp(`^\\s*\\[\\s*${table.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\]\\s*(#.*)?$`);
  // Treat both `[table]` and `[[array_of_tables]]` as section boundaries —
  // the inner `\[\[?...\]\]?` lets the boundary scan stop at array-of-tables
  // headers too, so we don't accidentally insert into one.
  const anyHeaderRegex = /^\s*\[\[?[^\]]+\]\]?\s*(#.*)?$/;

  let tableStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRegex.test(lines[i])) {
      tableStart = i;
      break;
    }
  }

  if (tableStart === -1) {
    // Caller should have used appendTomlTable; defensive fallback.
    return appendTomlTable(existing, table, key, value);
  }

  let insertAt = lines.length;
  for (let i = tableStart + 1; i < lines.length; i++) {
    if (anyHeaderRegex.test(lines[i])) {
      insertAt = i;
      break;
    }
  }

  // Walk back over trailing blank lines so the new key sits with its table.
  while (insertAt > tableStart + 1 && lines[insertAt - 1].trim() === "") {
    insertAt--;
  }

  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  const newLine = `${key} = ${value}`;
  return [...before, newLine, ...after].join("\n");
}

/**
 * Decide whether the parsed config already satisfies the required key.
 * Returns null if satisfied, otherwise an AppliedChange describing what
 * needs to be added.
 */
function diffRequired(parsed: Record<string, unknown>): AppliedChange | null {
  const table = parsed[REQUIRED_TABLE];
  if (
    table &&
    typeof table === "object" &&
    !Array.isArray(table) &&
    (table as Record<string, unknown>)[REQUIRED_KEY] === REQUIRED_VALUE
  ) {
    return null;
  }
  return {
    table: REQUIRED_TABLE,
    key: REQUIRED_KEY,
    value: String(REQUIRED_VALUE),
  };
}

/** Collect non-fatal warnings about the user's config without modifying it. */
function collectWarnings(parsed: Record<string, unknown>): CodexConfigWarning[] {
  const warnings: CodexConfigWarning[] = [];

  const features = parsed.features;
  if (
    features &&
    typeof features === "object" &&
    !Array.isArray(features) &&
    (features as Record<string, unknown>).codex_hooks === false
  ) {
    warnings.push({
      code: "CODEX_HOOKS_DISABLED",
      message:
        "[features] codex_hooks is explicitly set to false; the mthds hook will not load. Remove this key (Codex 0.124+ enables hooks by default).",
    });
  }

  if (parsed.sandbox_mode === "read-only") {
    warnings.push({
      code: "SANDBOX_READ_ONLY",
      message:
        'sandbox_mode = "read-only" prevents the apply_patch hook from running. Set to "workspace-write" or remove the key.',
    });
  }

  return warnings;
}

/**
 * Read-only inspection of ~/.codex/config.toml. Used by doctor to surface
 * issues without writing anything. Never throws — parse errors are reported
 * via the `parse_error` field so the caller can decide how to render them.
 */
export function inspectCodexConfig(): CodexConfigInspection {
  const file = configFilePath();
  const exists = existsSync(file);
  if (!exists) {
    // No config file ⇒ definitely needs a change (the required key is missing).
    return {
      config_file: file,
      exists: false,
      needs_change: {
        table: REQUIRED_TABLE,
        key: REQUIRED_KEY,
        value: String(REQUIRED_VALUE),
      },
      warnings: [],
    };
  }

  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return {
      config_file: file,
      exists: true,
      needs_change: null,
      warnings: [],
      parse_error: `Failed to read ${file}: ${(err as Error).message}`,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = raw.trim().length === 0 ? {} : (parseToml(raw) as Record<string, unknown>);
  } catch (err) {
    return {
      config_file: file,
      exists: true,
      needs_change: null,
      warnings: [],
      parse_error: (err as Error).message,
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      config_file: file,
      exists: true,
      needs_change: null,
      warnings: [],
      parse_error: "Top-level value is not a TOML table",
    };
  }

  return {
    config_file: file,
    exists: true,
    needs_change: diffRequired(parsed),
    warnings: collectWarnings(parsed),
  };
}

// ── Main ───────────────────────────────────────────────────────────

export async function agentCodexApplyConfig(
  options: ApplyConfigOptions = {},
): Promise<void> {
  const file = configFilePath();
  const checkMode = options.check === true;
  const dryRunMode = options.dryRun === true;

  let raw = "";
  if (existsSync(file)) {
    try {
      raw = readFileSync(file, "utf8");
    } catch (err) {
      agentError(
        `Failed to read ${file}: ${(err as Error).message}`,
        "IOError",
        { error_domain: AGENT_ERROR_DOMAINS.IO },
      );
      return;
    }
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = raw.trim().length === 0 ? {} : (parseToml(raw) as Record<string, unknown>);
  } catch (err) {
    agentError(
      `Invalid TOML in ${file}: ${(err as Error).message}. Fix the file by hand or delete it and re-run.`,
      "ConfigError",
      { error_domain: AGENT_ERROR_DOMAINS.CONFIG },
    );
    return;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    agentError(
      `${file} does not contain a TOML table at the top level.`,
      "ConfigError",
      { error_domain: AGENT_ERROR_DOMAINS.CONFIG },
    );
    return;
  }

  const change = diffRequired(parsed);
  const warnings = collectWarnings(parsed);

  // --check mode: exit non-zero if anything would change. Warnings count
  // because they signal explicit user state that breaks the hook.
  if (checkMode) {
    if (change || warnings.length > 0) {
      agentError(
        `Codex config needs attention. Run 'mthds-agent codex apply-config' (and review warnings).`,
        "ConfigError",
        { error_domain: AGENT_ERROR_DOMAINS.CONFIG },
      );
      return;
    }
    agentSuccess({ status: "ALREADY_OK", config_file: file });
    return;
  }

  if (!change) {
    agentSuccess({
      status: "ALREADY_OK",
      config_file: file,
      warnings,
    });
    return;
  }

  // Build the new file contents additively.
  //
  // Edge case: `parsed[REQUIRED_TABLE]` may be a TOML-implicit table
  // created by a dotted-key header like `[sandbox_workspace_write.sub]`
  // even when no literal `[sandbox_workspace_write]` header exists in the
  // source text. In that case `insertIntoExistingTable` falls back to
  // appending a fresh header, which would cause smol-toml to reject the
  // result on the sanity-parse below (table redefinition). The sanity
  // parse catches it and we surface a ConfigError — not pretty, but safe.
  // If this becomes a real problem, switch to writing the dotted form
  // `sandbox_workspace_write.network_access = true` at top-of-file.
  let nextRaw: string;
  const tableExists =
    parsed[REQUIRED_TABLE] !== undefined &&
    typeof parsed[REQUIRED_TABLE] === "object" &&
    !Array.isArray(parsed[REQUIRED_TABLE]);

  if (tableExists) {
    nextRaw = insertIntoExistingTable(raw, change.table, change.key, change.value);
  } else {
    nextRaw = appendTomlTable(raw, change.table, change.key, change.value);
  }

  // Sanity-parse the new contents before committing.
  try {
    parseToml(nextRaw);
  } catch (err) {
    agentError(
      `Generated config would not re-parse: ${(err as Error).message}`,
      "ConfigError",
      { error_domain: AGENT_ERROR_DOMAINS.CONFIG },
    );
    return;
  }

  if (dryRunMode) {
    agentSuccess({
      status: "WOULD_APPLY",
      config_file: file,
      applied: [change],
      warnings,
    });
    return;
  }

  try {
    writeAtomic(file, nextRaw);
  } catch (err) {
    agentError(
      `Failed to write ${file}: ${(err as Error).message}`,
      "IOError",
      { error_domain: AGENT_ERROR_DOMAINS.IO },
    );
    return;
  }

  agentSuccess({
    status: "APPLIED",
    config_file: file,
    applied: [change],
    warnings,
  });
}
