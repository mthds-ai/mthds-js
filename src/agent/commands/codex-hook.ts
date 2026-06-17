/**
 * mthds-agent codex hook — Codex PostToolUse(apply_patch) hook runtime.
 *
 * Invoked by the mthds plugin's bundled PostToolUse(apply_patch) hook
 * (mthds-codex/hooks/codex-hooks.json, discovered through the plugin manifest).
 * Runs after every apply_patch tool call in a Codex session: parses the patch
 * envelope from tool_input.command, finds touched .mthds files, and validates
 * each one through three stages: plxt lint, plxt fmt, pipelex-agent validate
 * bundle.
 *
 * Stdout protocol — Codex's hook contract, not the mthds agent JSON:
 *   - empty / no output                      → silent pass (no .mthds touched, or all clean)
 *   - {"decision":"block",...}               → block the turn with the given reason
 *   - {"hookSpecificOutput":{...}}           → emit additionalContext (no block) for
 *                                              config/runtime-domain validation issues —
 *                                              the agent is informed but does NOT edit
 *                                              the file
 */

import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { posix as path } from "node:path";

const PLXT_INSTALL_HINT = "uv tool install pipelex-tools";
const PIPELEX_AGENT_INSTALL_HINT = "uv tool install pipelex";
const ADDITIONAL_CONTEXT_MAX_LEN = 9500;

interface PlxtRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PipelexValidateResult {
  exitCode: number;
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

export function buildAdditionalContextPayload(context: string): string {
  return (
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: context,
      },
    }) + "\n"
  );
}

/**
 * Drop the `## Error source` section and everything after it.
 *
 * Stopgap: pipelex 0.30.2 already omits this section from `validate bundle`
 * markdown output, so once the floor is bumped past 0.30.2 this is a no-op.
 * Kept defensively so a user lagging on pipelex doesn't leak stack frames
 * into the agent-facing block reason.
 */
export function stripErrorSourceSection(markdown: string): string {
  const match = markdown.match(/^## Error source/m);
  if (!match || match.index === undefined) return markdown;
  return markdown.slice(0, match.index);
}

/**
 * Parse `- **error_domain:** <value>` out of the `## Details` section.
 *
 * Returns the first match (pipelex only emits one). Undefined when the
 * raised error class has no `error_domain` and is not in pipelex's
 * `AGENT_ERROR_DOMAINS` lookup (e.g. bare `LibraryError`).
 */
export function extractErrorDomain(markdown: string): string | undefined {
  const match = markdown.match(/^- \*\*error_domain:\*\* *(\S+)/m);
  return match ? match[1] : undefined;
}

export function truncateForAdditionalContext(text: string): string {
  if (text.length <= ADDITIONAL_CONTEXT_MAX_LEN) return text;
  const omitted = text.length - ADDITIONAL_CONTEXT_MAX_LEN;
  return (
    text.slice(0, ADDITIONAL_CONTEXT_MAX_LEN) +
    `\n\n[truncated, ${omitted} chars omitted]`
  );
}

export type Stage3Outcome =
  | { kind: "pass" }
  | { kind: "block"; reason: string }
  | { kind: "warn"; context: string; domain: string };

/**
 * Decide what to emit for a single file's `pipelex-agent validate bundle`
 * result. The block/warn split mirrors the bash hook in mthds-plugins.
 *
 * - exit 0                        → pass (no output)
 * - empty stderr (post-strip)     → block with a generic "no stderr" reason
 * - error_domain ∈ {config,runtime} → warn (additionalContext), no block
 * - anything else (input, unknown, missing) → block with markdown verbatim
 *   (default-to-block is the safety choice)
 */
export function classifyStage3Result(
  file: string,
  result: PipelexValidateResult
): Stage3Outcome {
  if (result.exitCode === 0) return { kind: "pass" };

  const trimmed = stripErrorSourceSection(result.stderr);
  if (trimmed.trim().length === 0) {
    return {
      kind: "block",
      reason: `Validation failed for ${file} (pipelex-agent exited ${result.exitCode} with no stderr output)`,
    };
  }

  const body = trimmed.replace(/\s+$/, "");
  const domain = extractErrorDomain(trimmed);
  if (domain === "config" || domain === "runtime") {
    const header = `Validation warning for ${file} (${domain} domain — environment issue, do not edit the file):\n\n`;
    return {
      kind: "warn",
      domain,
      context: header + truncateForAdditionalContext(body),
    };
  }

  return {
    kind: "block",
    reason: `Validation failed for ${file}:\n\n${body}`,
  };
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

/**
 * Run `pipelex-agent validate bundle <file> -L <libraryDir> --allow-signatures`.
 * We do NOT shell out through `mthds-agent` to avoid recursing into this same
 * CLI; pipelex-agent's bundle validation is offline-safe (no remote-config or
 * gateway fetch in this code path).
 *
 * `--allow-signatures` makes validation lenient: a bundle that forward-declares
 * pipes as `PipeSignature` placeholders validates structurally instead of
 * erroring on the unimplemented signatures. This keeps the Codex hook at parity
 * with the Claude bash hook and lets every intermediate save during recursive
 * (stepwise-refinement) method building pass while the signature backlog is
 * still being drained. On a signature-free bundle lenient ≡ strict, so the flag
 * is a no-op for every non-recursive edit. The strict gate (no leftover
 * signatures) lives in the orchestrator skill's finalize step and in `run`, not
 * in this per-save hook.
 *
 * Exported for testability — the invocation shape, including this flag, is
 * verified in codex-hook-validate.test.ts.
 */
export function runPipelexValidate(file: string, libraryDir: string): PipelexValidateResult {
  const result = spawnSync(
    "pipelex-agent",
    ["validate", "bundle", file, "-L", libraryDir, "--allow-signatures"],
    { encoding: "utf8" }
  );
  if (result.error) {
    return { exitCode: 127, stderr: result.error.message };
  }
  return {
    exitCode: result.status ?? 1,
    stderr: result.stderr ?? "",
  };
}

// ── Dependency-injectable core (the actual command logic) ─────────────

export interface CodexHookDeps {
  readStdin: () => string;
  fileExists: (path: string) => boolean;
  hasPlxt: () => boolean;
  runPlxt: (args: string[]) => PlxtRunResult;
  hasPipelexAgent: () => boolean;
  runPipelexValidate: (file: string, libraryDir: string) => PipelexValidateResult;
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

  if (!deps.hasPipelexAgent()) {
    deps.emit(
      buildBlockPayload(
        `Missing required CLI tool: pipelex-agent (install via: ${PIPELEX_AGENT_INSTALL_HINT})`
      )
    );
    return;
  }

  const blocks: string[] = [];
  const warnings: string[] = [];

  for (const file of files) {
    // Renamed-source paths and delete targets won't exist on disk post-patch.
    // Skipping them is the right thing — this is identical to the bash
    // hook's behaviour.
    if (!deps.fileExists(file)) continue;

    // Stage 1: plxt lint (block on failure)
    const lint = deps.runPlxt(["lint", "--quiet", file]);
    if (lint.exitCode !== 0) {
      blocks.push(formatLintError(file, lint));
      continue; // skip fmt + Stage 3 for files that failed lint
    }

    // Stage 2: plxt fmt — also blocks on failure (the bash hook this
    // replaces aggregated lint and fmt errors into a single block reason).
    // Re-formatting can fail e.g. when the file becomes invalid mid-edit;
    // surfacing it loudly is better than letting a half-formatted file land.
    const fmt = deps.runPlxt(["fmt", file]);
    if (fmt.exitCode !== 0) {
      blocks.push(formatFmtError(file, fmt));
      continue; // skip Stage 3 on a fmt-broken file
    }

    // Stage 3: pipelex-agent validate bundle — semantic validation, run
    // leniently (`--allow-signatures`, inside runPipelexValidate) so a bundle
    // mid-refinement with leftover PipeSignature placeholders still passes.
    // Markdown stderr is the canonical agent-facing artifact. Block on
    // input/unknown domain (agent revises the bundle); warn via
    // additionalContext on config/runtime (environment issue, agent should not
    // edit the file).
    const libraryDir = path.dirname(file) + "/";
    const validateResult = deps.runPipelexValidate(file, libraryDir);
    const outcome = classifyStage3Result(file, validateResult);
    if (outcome.kind === "block") {
      blocks.push(outcome.reason);
    } else if (outcome.kind === "warn") {
      warnings.push(outcome.context);
    }
  }

  // Aggregation. When both blocks and warnings exist we emit block-only —
  // the agent has to revise and re-save anyway, so deferring the warning
  // until the next pass is fine and keeps the response shape simple.
  if (blocks.length > 0) {
    deps.emit(buildBlockPayload(blocks.join("\n\n")));
    return;
  }
  if (warnings.length > 0) {
    deps.emit(buildAdditionalContextPayload(warnings.join("\n\n")));
  }
}

// ── CLI entry point ───────────────────────────────────────────────────

export async function agentCodexHook(): Promise<void> {
  return runCodexHook({
    readStdin: readAllStdin,
    fileExists: existsSync,
    hasPlxt: () => commandOnPath("plxt"),
    runPlxt,
    hasPipelexAgent: () => commandOnPath("pipelex-agent"),
    runPipelexValidate,
    emit: (out) => process.stdout.write(out),
  });
}
