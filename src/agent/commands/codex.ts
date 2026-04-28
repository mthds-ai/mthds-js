/**
 * mthds-agent codex install-hook — idempotently wire the mthds
 * PostToolUse(apply_patch) hook into ~/.codex/hooks.json.
 *
 * Codex reads ~/.codex/hooks.json at startup and runs each registered hook
 * after the matching tool call. We register a PostToolUse hook with
 * matcher=apply_patch whose command is `mthds-agent codex hook` — the actual
 * validation runtime, registered under the same `codex` subcommand group as
 * this install command.
 *
 * Migration: pre-0.5.0 versions of this command wrote `hooks.Stop[]` entries
 * pointing at a bash script (~/.codex/hooks/codex-validate-mthds.sh). The
 * mthds-plugins WIP 0.9.0 install-codex.sh wrote `hooks.PostToolUse[]`
 * entries pointing at the same bash script. Both are obsolete: the bash
 * script is gone, and the new entry routes through `mthds-agent codex hook`
 * directly. We sweep both legacy shapes here so users coming from any
 * earlier install end up with a clean hooks.json.
 *
 * Output statuses (via agentSuccess):
 *   - { status: "INSTALLED_NEW_FILE", hooks_file } — hooks.json didn't exist
 *   - { status: "ALREADY_INSTALLED", hooks_file } — new-shape entry already present
 *   - { status: "MERGED", hooks_file }            — entry appended (fresh or post-migration)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { agentError, agentSuccess, AGENT_ERROR_DOMAINS } from "../output.js";

// ── Constants ──────────────────────────────────────────────────────

const HOOK_COMMAND = "mthds-agent codex hook";
const HOOK_MATCHER = "apply_patch";
const HOOK_TIMEOUT = 30;

// Substrings that identify entries previously written by this command or
// the retired install-codex.sh script. Any entry whose command contains
// either is "ours" and gets cleaned up before the new entry is appended.
const LEGACY_MARKERS = ["codex-validate-mthds", "mthds-agent codex hook"];

// ── Types ──────────────────────────────────────────────────────────

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}

interface HookEntry {
  matcher?: string;
  hooks: HookCommand[];
}

interface HooksFile {
  hooks?: {
    Stop?: HookEntry[];
    PostToolUse?: HookEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ── Helpers ────────────────────────────────────────────────────────

function hooksFilePath(): string {
  return join(homedir(), ".codex", "hooks.json");
}

function buildPostToolUseEntry(): HookEntry {
  return {
    matcher: HOOK_MATCHER,
    hooks: [
      {
        type: "command",
        command: HOOK_COMMAND,
        timeout: HOOK_TIMEOUT,
      },
    ],
  };
}

// "Ours" is a fuzzy substring match across all known shapes (current +
// legacy bash-script entries) — used to identify entries to clean up.
// "Current" is an exact-prefix match on the new shape only — used to
// detect idempotent re-installs. The asymmetry is deliberate: a legacy
// entry should be removed and replaced, not treated as already-installed.
function entryIsOurs(entry: HookEntry | unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const cmds = (entry as HookEntry).hooks;
  if (!Array.isArray(cmds)) return false;
  return cmds.some(
    (h) =>
      typeof h?.command === "string" &&
      LEGACY_MARKERS.some((m) => h.command.includes(m))
  );
}

function entryIsCurrent(entry: HookEntry): boolean {
  if (entry?.matcher !== HOOK_MATCHER) return false;
  if (!Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (h) => typeof h?.command === "string" && h.command.startsWith(HOOK_COMMAND)
  );
}

function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents, { encoding: "utf8", mode: 0o644 });
  renameSync(tmp, path);
}

// ── Main ───────────────────────────────────────────────────────────

export async function agentCodexInstallHook(): Promise<void> {
  const file = hooksFilePath();

  // Case 1: hooks.json does not exist — create it fresh with the new shape.
  if (!existsSync(file)) {
    const fresh: HooksFile = {
      hooks: {
        PostToolUse: [buildPostToolUseEntry()],
      },
    };
    try {
      writeAtomic(file, JSON.stringify(fresh, null, 2) + "\n");
    } catch (err) {
      agentError(
        `Failed to create ${file}: ${(err as Error).message}`,
        "IOError",
        { error_domain: AGENT_ERROR_DOMAINS.IO }
      );
      return;
    }
    agentSuccess({ status: "INSTALLED_NEW_FILE", hooks_file: file });
    return;
  }

  // Case 2: hooks.json exists — read, validate, migrate legacy entries, merge.
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    agentError(
      `Failed to read ${file}: ${(err as Error).message}`,
      "IOError",
      { error_domain: AGENT_ERROR_DOMAINS.IO }
    );
    return;
  }

  let parsed: HooksFile;
  try {
    parsed = raw.trim().length === 0 ? {} : (JSON.parse(raw) as HooksFile);
  } catch (err) {
    agentError(
      `Invalid JSON in ${file}: ${(err as Error).message}. Fix the file by hand or delete it and re-run.`,
      "ConfigError",
      { error_domain: AGENT_ERROR_DOMAINS.CONFIG }
    );
    return;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    agentError(
      `${file} does not contain a JSON object at the top level.`,
      "ConfigError",
      { error_domain: AGENT_ERROR_DOMAINS.CONFIG }
    );
    return;
  }

  if (parsed.hooks === undefined) {
    parsed.hooks = {};
  } else if (
    typeof parsed.hooks !== "object" ||
    parsed.hooks === null ||
    Array.isArray(parsed.hooks)
  ) {
    agentError(
      `${file} has an invalid \`hooks\` field (expected object, got ${
        Array.isArray(parsed.hooks) ? "array" : typeof parsed.hooks
      }). Fix the file by hand.`,
      "ConfigError",
      { error_domain: AGENT_ERROR_DOMAINS.CONFIG }
    );
    return;
  }

  const hooks = parsed.hooks as {
    Stop?: HookEntry[];
    PostToolUse?: HookEntry[];
    [k: string]: unknown;
  };

  // Validate hooks.PostToolUse if present.
  if (hooks.PostToolUse !== undefined && !Array.isArray(hooks.PostToolUse)) {
    agentError(
      `${file} has an invalid \`hooks.PostToolUse\` field (expected array, got ${typeof hooks.PostToolUse}). Fix the file by hand.`,
      "ConfigError",
      { error_domain: AGENT_ERROR_DOMAINS.CONFIG }
    );
    return;
  }

  // Validate hooks.Stop if present (we may need to mutate it).
  if (hooks.Stop !== undefined && !Array.isArray(hooks.Stop)) {
    agentError(
      `${file} has an invalid \`hooks.Stop\` field (expected array, got ${typeof hooks.Stop}). Fix the file by hand.`,
      "ConfigError",
      { error_domain: AGENT_ERROR_DOMAINS.CONFIG }
    );
    return;
  }

  // Track whether we mutated anything in memory. If yes, we must write —
  // even when a current-shape entry already exists, because a stale legacy
  // entry alongside it is still pollution that should be cleaned up.
  let dirty = false;

  // Migration: drop any legacy Stop entry pointing at our old script.
  if (Array.isArray(hooks.Stop)) {
    const before = hooks.Stop.length;
    hooks.Stop = hooks.Stop.filter((e) => !entryIsOurs(e));
    if (hooks.Stop.length !== before) dirty = true;
    if (hooks.Stop.length === 0) {
      delete hooks.Stop;
    }
  }

  // Initialise PostToolUse if absent.
  if (hooks.PostToolUse === undefined) {
    hooks.PostToolUse = [];
  }

  // Detect whether a current-shape entry already exists, then strip any
  // legacy PostToolUse(apply_patch) entries that pointed at the old bash
  // script. Doing both in this order means a hooks.json with both a current
  // and a legacy entry gets cleaned up on re-run.
  const hasCurrent = hooks.PostToolUse.some(entryIsCurrent);
  const beforePtu = hooks.PostToolUse.length;
  hooks.PostToolUse = hooks.PostToolUse.filter(
    (e) => entryIsCurrent(e) || !entryIsOurs(e)
  );
  if (hooks.PostToolUse.length !== beforePtu) dirty = true;

  if (!hasCurrent) {
    hooks.PostToolUse.push(buildPostToolUseEntry());
    dirty = true;
  }

  if (!dirty) {
    agentSuccess({ status: "ALREADY_INSTALLED", hooks_file: file });
    return;
  }

  try {
    writeAtomic(file, JSON.stringify(parsed, null, 2) + "\n");
  } catch (err) {
    agentError(
      `Failed to write ${file}: ${(err as Error).message}`,
      "IOError",
      { error_domain: AGENT_ERROR_DOMAINS.IO }
    );
    return;
  }

  agentSuccess({ status: "MERGED", hooks_file: file });
}
