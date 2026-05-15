/**
 * mthds-agent codex apply-config — make ~/.codex/ correct for the mthds plugin.
 *
 * Two jobs:
 *  1. Additively merge required keys into ~/.codex/config.toml:
 *       [sandbox_workspace_write] network_access = true
 *         — Codex's default workspace-write sandbox blocks outbound network for
 *           hook commands; without it any remote fetch hangs/fails.
 *       [features] plugin_hooks = true
 *         — plugin-bundled hooks are opt-in; without it Codex never loads the
 *           mthds validation hook shipped inside the plugin.
 *  2. Remove any obsolete mthds entry left in ~/.codex/hooks.json by the retired
 *     `install-hook` command (see codex.ts) — it would double-fire alongside the
 *     plugin-bundled hook.
 *
 * Warning-only checks (never modified — too high-risk):
 *   - `[features] hooks = false` (or its alias `codex_hooks = false`) disables
 *     hooks entirely; we check both keys defensively.
 *   - `sandbox_mode = "read-only"` — apply_patch can't run, so the hook can't
 *     either.
 *
 * Output statuses (via agentSuccess):
 *   - { status: "ALREADY_OK", ... }   — nothing needed changing
 *   - { status: "APPLIED", ... }      — config.toml merged and/or stale hook removed
 *   - { status: "WOULD_APPLY", ... }  — --dry-run only
 *
 * Flags:
 *   --check    exits non-zero if anything would change (no writes, no warnings demoted)
 *   --dry-run  prints proposed diff and exits 0 without touching any file
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";
import { agentError, agentSuccess, AGENT_ERROR_DOMAINS } from "../output.js";
import { inspectLegacyCodexHook, removeLegacyCodexHook } from "./codex.js";

// ── Constants ──────────────────────────────────────────────────────

/** Each (table, key, value) the mthds plugin needs in ~/.codex/config.toml.
 *  `apply-config` adds missing keys and errors (without writing) on a key that
 *  is explicitly set to a conflicting value. */
interface RequiredSetting {
  table: string;
  key: string;
  value: boolean;
}

const REQUIRED_SETTINGS: RequiredSetting[] = [
  { table: "sandbox_workspace_write", key: "network_access", value: true },
  { table: "features", key: "plugin_hooks", value: true },
];

// ── Types ──────────────────────────────────────────────────────────

export interface AppliedChange {
  table: string;
  key: string;
  value: string;
}

export interface SettingConflict {
  table: string;
  key: string;
  current: string;
  required: string;
}

export interface CodexConfigWarning {
  code: string;
  message: string;
}

export interface CodexConfigInspection {
  config_file: string;
  exists: boolean;
  needs_changes: AppliedChange[];
  conflicts: SettingConflict[];
  warnings: CodexConfigWarning[];
  parse_error?: string;
}

interface ApplyConfigOptions {
  check?: boolean;
  dryRun?: boolean;
}

type TomlTable = Record<string, unknown>;

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

/** Parse TOML text, treating empty/whitespace-only input as an empty table. */
function parseTomlOrEmpty(text: string): TomlTable {
  return text.trim().length === 0 ? {} : (parseToml(text) as TomlTable);
}

/**
 * Append a [table] section with key=value to existing TOML text. Used when the
 * table is missing entirely. We append rather than re-serialize so user
 * formatting/comments elsewhere in the file are preserved verbatim.
 */
function appendTomlTable(existing: string, table: string, key: string, value: string): string {
  const trimmed = existing.replace(/\s+$/, "");
  const sep = trimmed.length === 0 ? "" : "\n\n";
  return `${trimmed}${sep}[${table}]\n${key} = ${value}\n`;
}

/**
 * Insert key=value into an existing [table] section without re-serializing the
 * document. Locates the table header line, finds the end of its body (next
 * [section] header or EOF), and inserts the line just before that boundary.
 * This preserves comments and ordering of every other table.
 */
function insertIntoExistingTable(
  existing: string,
  table: string,
  key: string,
  value: string,
): string {
  const lines = existing.split("\n");
  const headerRegex = new RegExp(
    `^\\s*\\[\\s*${table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\]\\s*(#.*)?$`,
  );
  // Treat both `[table]` and `[[array_of_tables]]` as section boundaries — the
  // inner `\[\[?...\]\]?` lets the boundary scan stop at array-of-tables
  // headers too, so we don't accidentally insert into one.
  const anyHeaderRegex = /^\s*\[\[?[^\]]+\]\]?\s*(#.*)?$/;

  let tableStart = -1;
  for (let index = 0; index < lines.length; index++) {
    if (headerRegex.test(lines[index])) {
      tableStart = index;
      break;
    }
  }

  if (tableStart === -1) {
    // Caller should have used appendTomlTable; defensive fallback.
    return appendTomlTable(existing, table, key, value);
  }

  let insertAt = lines.length;
  for (let index = tableStart + 1; index < lines.length; index++) {
    if (anyHeaderRegex.test(lines[index])) {
      insertAt = index;
      break;
    }
  }

  // Walk back over trailing blank lines so the new key sits with its table.
  while (insertAt > tableStart + 1 && lines[insertAt - 1].trim() === "") {
    insertAt--;
  }

  const before = lines.slice(0, insertAt);
  const after = lines.slice(insertAt);
  return [...before, `${key} = ${value}`, ...after].join("\n");
}

function readSettingValue(parsed: TomlTable, setting: RequiredSetting): unknown {
  const table = parsed[setting.table];
  if (table && typeof table === "object" && !Array.isArray(table)) {
    return (table as TomlTable)[setting.key];
  }
  return undefined;
}

/**
 * Compare the parsed config against REQUIRED_SETTINGS:
 *   - missing key  → an AppliedChange to add it
 *   - wrong value  → a SettingConflict (the user must hand-fix; we never flip
 *                    a key that is explicitly set)
 *   - right value  → satisfied, ignored
 */
function evaluateSettings(parsed: TomlTable): {
  changes: AppliedChange[];
  conflicts: SettingConflict[];
} {
  const changes: AppliedChange[] = [];
  const conflicts: SettingConflict[] = [];
  for (const setting of REQUIRED_SETTINGS) {
    const current = readSettingValue(parsed, setting);
    if (current === setting.value) continue;
    if (current === undefined) {
      changes.push({ table: setting.table, key: setting.key, value: String(setting.value) });
    } else {
      conflicts.push({
        table: setting.table,
        key: setting.key,
        current: JSON.stringify(current),
        required: String(setting.value),
      });
    }
  }
  return { changes, conflicts };
}

/** Collect non-fatal warnings about the user's config without modifying it. */
function collectWarnings(parsed: TomlTable): CodexConfigWarning[] {
  const warnings: CodexConfigWarning[] = [];

  const features = parsed.features;
  if (features && typeof features === "object" && !Array.isArray(features)) {
    const featuresTable = features as TomlTable;
    // Check both `hooks` and its alias `codex_hooks` defensively. Either being
    // explicitly false disables hooks entirely and breaks the mthds hook. When
    // both are false, name both so neither is silently omitted.
    const disabledKeys = (["hooks", "codex_hooks"] as const).filter(
      (key) => featuresTable[key] === false,
    );
    if (disabledKeys.length > 0) {
      const keyList = disabledKeys.map((key) => `[features] ${key}`).join(" and ");
      const plural = disabledKeys.length > 1;
      warnings.push({
        code: "CODEX_HOOKS_DISABLED",
        message: `${keyList} ${plural ? "are" : "is"} explicitly set to false; the mthds hook will not load. Remove ${plural ? "these keys" : "this key"} — hooks are enabled by default.`,
      });
    }
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

function legacyHookWarning(parseError: string): CodexConfigWarning {
  return {
    code: "LEGACY_HOOK_UNREADABLE",
    message: `Could not read ~/.codex/hooks.json to remove any obsolete mthds hook entry (${parseError}). If you previously ran \`mthds-agent codex install-hook\`, delete that entry by hand so the validation hook does not run twice.`,
  };
}

/** Apply each change to the TOML text in sequence, re-parsing between changes
 *  so the table-exists decision reflects edits already made. */
function applyChanges(raw: string, changes: AppliedChange[]): string {
  let next = raw;
  for (const change of changes) {
    const parsed = parseTomlOrEmpty(next);
    const table = parsed[change.table];
    const tableExists = table !== undefined && typeof table === "object" && !Array.isArray(table);
    next = tableExists
      ? insertIntoExistingTable(next, change.table, change.key, change.value)
      : appendTomlTable(next, change.table, change.key, change.value);
  }
  return next;
}

// ── Read-only inspection ───────────────────────────────────────────

/**
 * Read-only inspection of ~/.codex/config.toml. Used by doctor to surface
 * issues without writing anything. Never throws — parse errors are reported
 * via the `parse_error` field so the caller can decide how to render them.
 */
export function inspectCodexConfig(): CodexConfigInspection {
  const file = configFilePath();
  const exists = existsSync(file);
  if (!exists) {
    // No config file ⇒ every required key is missing.
    return {
      config_file: file,
      exists: false,
      needs_changes: REQUIRED_SETTINGS.map((setting) => ({
        table: setting.table,
        key: setting.key,
        value: String(setting.value),
      })),
      conflicts: [],
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
      needs_changes: [],
      conflicts: [],
      warnings: [],
      parse_error: `Failed to read ${file}: ${(err as Error).message}`,
    };
  }

  let parsed: TomlTable;
  try {
    parsed = parseTomlOrEmpty(raw);
  } catch (err) {
    return {
      config_file: file,
      exists: true,
      needs_changes: [],
      conflicts: [],
      warnings: [],
      parse_error: (err as Error).message,
    };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      config_file: file,
      exists: true,
      needs_changes: [],
      conflicts: [],
      warnings: [],
      parse_error: "Top-level value is not a TOML table",
    };
  }

  const { changes, conflicts } = evaluateSettings(parsed);
  return {
    config_file: file,
    exists: true,
    needs_changes: changes,
    conflicts,
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
      agentError(`Failed to read ${file}: ${(err as Error).message}`, "IOError", {
        error_domain: AGENT_ERROR_DOMAINS.IO,
      });
      return;
    }
  }

  let parsed: TomlTable;
  try {
    parsed = parseTomlOrEmpty(raw);
  } catch (err) {
    agentError(
      `Invalid TOML in ${file}: ${(err as Error).message}. Fix the file by hand or delete it and re-run.`,
      "ConfigError",
      { error_domain: AGENT_ERROR_DOMAINS.CONFIG },
    );
    return;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    agentError(`${file} does not contain a TOML table at the top level.`, "ConfigError", {
      error_domain: AGENT_ERROR_DOMAINS.CONFIG,
    });
    return;
  }

  const { changes, conflicts } = evaluateSettings(parsed);
  const warnings = collectWarnings(parsed);

  // A key explicitly set to a conflicting value is a hard error in every mode:
  // apply-config never overrides an explicit user choice.
  if (conflicts.length > 0) {
    const lines = conflicts.map(
      (conflict) =>
        `  [${conflict.table}] ${conflict.key} = ${conflict.current} (the mthds plugin needs ${conflict.required})`,
    );
    agentError(
      `~/.codex/config.toml has settings that conflict with the mthds plugin:\n${lines.join("\n")}\nChange them by hand, then re-run \`mthds-agent codex apply-config\`.`,
      "ConfigError",
      { error_domain: AGENT_ERROR_DOMAINS.CONFIG },
    );
    return;
  }

  // ── --check mode: report only, exit non-zero if anything needs attention ──
  if (checkMode) {
    const legacy = inspectLegacyCodexHook();
    const needsAttention =
      changes.length > 0 ||
      warnings.length > 0 ||
      legacy.has_legacy_entry ||
      legacy.parse_error !== undefined;
    if (needsAttention) {
      agentError(
        `Codex config needs attention. Run 'mthds-agent codex apply-config' (and review warnings).`,
        "ConfigError",
        { error_domain: AGENT_ERROR_DOMAINS.CONFIG },
      );
      return;
    }
    agentSuccess({
      status: "ALREADY_OK",
      config_file: file,
      applied: [],
      legacy_hook: { hooks_file: legacy.hooks_file, status: "absent" },
      warnings: [],
    });
    return;
  }

  // Validate the prospective config.toml contents before any write.
  let nextRaw = raw;
  if (changes.length > 0) {
    try {
      nextRaw = applyChanges(raw, changes);
      // Sanity-parse: an implicit table created by a dotted-key header can make
      // appendTomlTable emit a duplicate header that smol-toml rejects.
      // applyChanges itself re-parses between changes, so a malformed
      // intermediate state throws here too — caught the same way.
      parseToml(nextRaw);
    } catch (err) {
      agentError(
        `Generated config would not re-parse: ${(err as Error).message}`,
        "ConfigError",
        { error_domain: AGENT_ERROR_DOMAINS.CONFIG },
      );
      return;
    }
  }

  // ── --dry-run mode: report the proposed diff, write nothing ──
  if (dryRunMode) {
    const legacy = inspectLegacyCodexHook();
    const allWarnings =
      legacy.parse_error !== undefined
        ? [...warnings, legacyHookWarning(legacy.parse_error)]
        : warnings;
    const wouldChange = changes.length > 0 || legacy.has_legacy_entry;
    agentSuccess({
      status: wouldChange ? "WOULD_APPLY" : "ALREADY_OK",
      config_file: file,
      applied: changes,
      legacy_hook: {
        hooks_file: legacy.hooks_file,
        status: legacy.has_legacy_entry
          ? "would-remove"
          : legacy.parse_error !== undefined
            ? "error"
            : "absent",
      },
      warnings: allWarnings,
    });
    return;
  }

  // ── Apply ──
  if (changes.length > 0) {
    try {
      writeAtomic(file, nextRaw);
    } catch (err) {
      agentError(`Failed to write ${file}: ${(err as Error).message}`, "IOError", {
        error_domain: AGENT_ERROR_DOMAINS.IO,
      });
      return;
    }
  }

  const removal = removeLegacyCodexHook();
  const allWarnings =
    removal.status === "error" && removal.error !== undefined
      ? [...warnings, legacyHookWarning(removal.error)]
      : warnings;
  const didChange = changes.length > 0 || removal.status === "removed";

  agentSuccess({
    status: didChange ? "APPLIED" : "ALREADY_OK",
    config_file: file,
    applied: changes,
    legacy_hook: { hooks_file: removal.hooks_file, status: removal.status },
    warnings: allWarnings,
  });
}
