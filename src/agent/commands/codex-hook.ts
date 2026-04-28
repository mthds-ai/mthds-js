/**
 * mthds-agent codex hook — Codex PostToolUse(apply_patch) hook runtime.
 *
 * Wired into ~/.codex/hooks.json by `mthds-agent codex install-hook`. Runs
 * after every apply_patch tool call in a Codex session: parses the patch
 * envelope from tool_input.command, finds touched .mthds files, and validates
 * each one with plxt (lint + fmt). On lint or fmt failure it emits the Codex
 * hook block protocol so the session sees the error.
 *
 * Replaces the bash script previously at ~/.codex/hooks/codex-validate-mthds.sh.
 *
 * Stdout protocol — Codex's hook contract, not the mthds agent JSON:
 *   - empty / no output         → silent pass (no .mthds touched, or all clean)
 *   - {"decision":"block",...}  → block the turn with the given reason
 *
 * Stage 3 (`mthds-agent validate bundle`) stays disabled until offline-mode
 * validation lands in mthds-agent (Codex sandbox blocks the eager S3 fetch).
 * Tracked as Phase 2D in mthds-plugins/TODOS.md.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, sep } from "node:path";

const PLXT_INSTALL_HINT = "uv tool install pipelex-tools";

interface PlxtRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface PostToolUsePayload {
  tool_input?: { command?: string };
}

// ── Pure helpers (exported for testability) ───────────────────────────

/**
 * Extract every distinct .mthds path mentioned in an apply_patch envelope.
 *
 * The envelope's relevant headers are:
 *   *** Update File: <path>
 *   *** Add File: <path>
 *   *** Move to: <path>      (destination of a rename — we validate the dest)
 *
 * `Delete File:` and `Move from:` (the source of a rename) are deliberately
 * skipped because the file no longer exists post-patch.
 */
export function parseMthdsFiles(command: string): string[] {
  const re = /^\*\*\* (?:Update File|Add File|Move to):\s*(.+\.mthds)\s*$/gm;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    seen.add(match[1]!.trim());
  }
  return Array.from(seen);
}

export function formatLintError(file: string, result: PlxtRunResult): string {
  const out =
    result.stderr.trim() ||
    result.stdout.trim() ||
    `lint exited with code ${result.exitCode} (no output)`;
  return `TOML/schema lint errors in ${file}:\n${out}\n\nFix it.`;
}

export function formatFmtError(file: string, result: PlxtRunResult): string {
  const out = result.stderr.trim() || "no output";
  return `plxt fmt failed on ${file} (exit ${result.exitCode}):\n${out}\n\nFix it.`;
}

export function buildBlockPayload(reason: string): string {
  return JSON.stringify({ decision: "block", reason }) + "\n";
}

// ── Runtime helpers ───────────────────────────────────────────────────

function readAllStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * Cross-platform `command -v <name>`. We can't rely on PATH lookup
 * inside spawnSync because we need to detect absence vs. spawn failure
 * before we report "missing tool" to the user.
 */
function commandOnPath(name: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  if (!pathEnv) return false;
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
    if (existsSync(candidate)) return true;
  }
  return false;
}

function runPlxt(args: string[]): PlxtRunResult {
  const result = spawnSync("plxt", args, { encoding: "utf8" });
  if (result.error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: result.error.message,
    };
  }
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// ── Dependency-injectable core (the actual command logic) ─────────────

export interface CodexHookDeps {
  readStdin: () => string;
  fileExists: (path: string) => boolean;
  hasPlxt: () => boolean;
  runPlxt: (args: string[]) => PlxtRunResult;
  emit: (output: string) => void;
}

export async function runCodexHook(deps: CodexHookDeps): Promise<void> {
  const raw = deps.readStdin();
  if (raw.trim().length === 0) return; // silent pass

  let parsed: PostToolUsePayload;
  try {
    parsed = JSON.parse(raw) as PostToolUsePayload;
  } catch {
    return; // malformed payload — silent pass, not our job to police Codex
  }

  const command = parsed?.tool_input?.command;
  if (typeof command !== "string" || command.length === 0) return;

  const files = parseMthdsFiles(command);
  if (files.length === 0) return;

  if (!deps.hasPlxt()) {
    deps.emit(
      buildBlockPayload(
        `Missing required CLI tool: plxt (install via: ${PLXT_INSTALL_HINT})`
      )
    );
    return;
  }

  const errors: string[] = [];

  for (const file of files) {
    // Renamed-source paths and delete targets won't exist on disk post-patch.
    // Skipping them is the right thing — this is identical to the bash
    // hook's behaviour.
    if (!deps.fileExists(file)) continue;

    // Stage 1: plxt lint (block on failure)
    const lint = deps.runPlxt(["lint", "--quiet", file]);
    if (lint.exitCode !== 0) {
      errors.push(formatLintError(file, lint));
      continue; // skip fmt for files that failed lint
    }

    // Stage 2: plxt fmt — also blocks on failure (the bash hook this
    // replaces aggregated lint and fmt errors into a single block reason).
    // Re-formatting can fail e.g. when the file becomes invalid mid-edit;
    // surfacing it loudly is better than letting a half-formatted file land.
    const fmt = deps.runPlxt(["fmt", file]);
    if (fmt.exitCode !== 0) {
      errors.push(formatFmtError(file, fmt));
    }

    // Stage 3: mthds-agent validate bundle — DISABLED.
    // Re-enable once mthds-agent supports offline validation
    // (mthds-plugins/TODOS.md Phase 2D).
  }

  if (errors.length > 0) {
    deps.emit(buildBlockPayload(errors.join("\n\n")));
  }
}

// ── CLI entry point ───────────────────────────────────────────────────

export async function agentCodexHook(): Promise<void> {
  return runCodexHook({
    readStdin: readAllStdin,
    fileExists: existsSync,
    hasPlxt: () => commandOnPath("plxt"),
    runPlxt,
    emit: (out) => process.stdout.write(out),
  });
}
