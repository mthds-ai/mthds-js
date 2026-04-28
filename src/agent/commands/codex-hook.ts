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

import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

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
  const out =
    result.stderr.trim() ||
    result.stdout.trim() ||
    `fmt exited with code ${result.exitCode} (no output)`;
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
 * Build the ordered list of candidate paths for `name` on PATH.
 *
 * Pure — no fs access. Exported for testability.
 *
 * On Windows we also try each PATHEXT extension (`plxt.EXE`, `plxt.CMD`, ...)
 * and skip the bare name, because Windows requires an extension to consider
 * a file executable. PATHEXT defaults to `.COM;.EXE;.BAT;.CMD` when unset.
 */
export function buildPathCandidates(
  name: string,
  pathEnv: string,
  platform: NodeJS.Platform,
  pathExt: string | undefined
): string[] {
  if (!pathEnv) return [];
  const isWin = platform === "win32";
  // Don't use node:path's `delimiter`/`sep` — they're baked at module load
  // from the host platform, so the function would silently behave wrong if
  // we wanted to reason about Windows lookup on a POSIX host (and vice versa).
  const pathDelimiter = isWin ? ";" : ":";
  const pathSep = isWin ? "\\" : "/";
  const exts = isWin
    ? (pathExt ?? ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .map((e) => e.trim())
        .filter(Boolean)
    : [""];
  const candidates: string[] = [];
  for (const dir of pathEnv.split(pathDelimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const fullName = `${name}${ext}`;
      candidates.push(
        dir.endsWith(pathSep)
          ? `${dir}${fullName}`
          : `${dir}${pathSep}${fullName}`
      );
    }
  }
  return candidates;
}

/**
 * Cross-platform `command -v <name>`. We can't rely on PATH lookup
 * inside spawnSync because we need to detect absence vs. spawn failure
 * before we report "missing tool" to the user.
 *
 * `accessSync(X_OK)` enforces the executable bit on POSIX. On Windows
 * X_OK is satisfied by any readable file, but the PATHEXT loop in
 * buildPathCandidates already restricts us to extensions Windows treats
 * as runnable.
 */
export function commandOnPath(name: string): boolean {
  const candidates = buildPathCandidates(
    name,
    process.env.PATH ?? "",
    process.platform,
    process.env.PATHEXT
  );
  for (const candidate of candidates) {
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return true;
    } catch {
      // ENOENT, EACCES, or non-executable entry — keep scanning.
    }
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
