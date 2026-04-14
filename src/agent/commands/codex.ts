/**
 * mthds-agent codex install-hook — idempotently merge the mthds Stop hook
 * into ~/.codex/hooks.json.
 *
 * Codex reads ~/.codex/hooks.json at startup and runs each Stop hook after
 * the session ends. We need to add our codex-validate-mthds.sh entry without
 * clobbering any other hooks the user may already have configured.
 *
 * The companion hook script itself (codex-validate-mthds.sh) is copied into
 * place by install-codex.sh — this command only owns the JSON merge.
 *
 * Output statuses (via agentSuccess):
 *   - { status: "ALREADY_INSTALLED", hooks_file } — entry was already present
 *   - { status: "INSTALLED_NEW_FILE", hooks_file } — hooks.json did not exist, we created it
 *   - { status: "MERGED", hooks_file } — entry appended to existing hooks.json
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { agentError, agentSuccess, AGENT_ERROR_DOMAINS } from "../output.js";

// ── Constants ──────────────────────────────────────────────────────

const HOOK_SCRIPT_PATH = "~/.codex/hooks/codex-validate-mthds.sh";
const HOOK_MARKER = "codex-validate-mthds";
const HOOK_TIMEOUT = 30;

// ── Types ──────────────────────────────────────────────────────────

interface HookCommand {
  type: string;
  command: string;
  timeout?: number;
}

interface HookEntry {
  hooks: HookCommand[];
}

interface HooksFile {
  hooks?: {
    Stop?: HookEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// ── Helpers ────────────────────────────────────────────────────────

function hooksFilePath(): string {
  return join(homedir(), ".codex", "hooks.json");
}

function buildMthdsStopEntry(): HookEntry {
  return {
    hooks: [
      {
        type: "command",
        command: HOOK_SCRIPT_PATH,
        timeout: HOOK_TIMEOUT,
      },
    ],
  };
}

function stopEntryMentionsMthds(entry: HookEntry): boolean {
  if (!entry || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (h) => typeof h?.command === "string" && h.command.includes(HOOK_MARKER)
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

  // Case 1: hooks.json does not exist — create it fresh.
  if (!existsSync(file)) {
    const fresh: HooksFile = {
      hooks: {
        Stop: [buildMthdsStopEntry()],
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
    }
    agentSuccess({ status: "INSTALLED_NEW_FILE", hooks_file: file });
    return;
  }

  // Case 2: hooks.json exists — read, parse, merge.
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
  } else if (typeof parsed.hooks !== "object" || parsed.hooks === null || Array.isArray(parsed.hooks)) {
    agentError(
      `${file} has an invalid \`hooks\` field (expected object, got ${Array.isArray(parsed.hooks) ? "array" : typeof parsed.hooks}). Fix the file by hand.`,
      "ConfigError",
      { error_domain: AGENT_ERROR_DOMAINS.CONFIG }
    );
    return;
  }
  const hooks = parsed.hooks as { Stop?: HookEntry[]; [k: string]: unknown };

  if (hooks.Stop === undefined) {
    hooks.Stop = [];
  } else if (!Array.isArray(hooks.Stop)) {
    agentError(
      `${file} has an invalid \`hooks.Stop\` field (expected array, got ${typeof hooks.Stop}). Fix the file by hand.`,
      "ConfigError",
      { error_domain: AGENT_ERROR_DOMAINS.CONFIG }
    );
    return;
  }

  // Idempotency: if any existing Stop entry already references our script, no-op.
  if (hooks.Stop.some(stopEntryMentionsMthds)) {
    agentSuccess({ status: "ALREADY_INSTALLED", hooks_file: file });
    return;
  }

  hooks.Stop.push(buildMthdsStopEntry());

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
