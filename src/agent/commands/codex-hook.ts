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
 *                                              validation issues of the environment —
 *                                              the agent is informed but does NOT edit
 *                                              the file
 */

import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { posix as path } from "node:path";
import { isProblemItem } from "../../problems/read.js";
import { codeFamily, familyEntries } from "../../problems/registry.js";
import { formatItem, formatSuggestedFix } from "../../problems/render.js";
import type { ProblemItem, RegistryEntry } from "../../problems/types.js";
import { PROBLEM_DOMAINS } from "../../problems/vocabulary.js";
import { passthroughEnv } from "../passthrough.js";

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
 * One fault of the envelope pipelex-agent wrote before it wrote problem documents: its
 * `validation_errors` items, read loosely.
 */
interface LegacyValidationItem {
  category?: unknown;
  message?: unknown;
  pipe_code?: unknown;
  concept_code?: unknown;
  domain_code?: unknown;
  field_name?: unknown;
  source?: unknown;
  missing_pipe_code?: unknown;
  missing_concept_code?: unknown;
  /** The runner's correction for this error; the hook reads only its `description`. */
  suggested_fix?: unknown;
}

/**
 * What `pipelex-agent validate bundle --error-format json` writes on stderr when it fails, the
 * subset the hook reads, in either of its two forms:
 *
 * - a problem document (docs/errors.md): `code` and `detail`, the faults in `errors`, each with
 *   its `code`, `detail`, `location` and `suggested_fix`, and the command's sentence in `message`;
 * - the envelope a pipelex-agent that predates problem documents writes: `error_domain`,
 *   `message` and `validation_errors`. Read until the pipelex floor of this CLI writes problems.
 *
 * Either is parsed from another program's output, so every member is read as unknown.
 */
export interface AgentErrorEnvelope {
  code?: unknown;
  detail?: unknown;
  domain?: unknown;
  errors?: unknown;
  is_valid?: unknown;
  error_domain?: unknown;
  message?: unknown;
  validation_errors?: unknown;
}

/**
 * Coerce an untyped envelope field to a string. The envelope is parsed from an
 * untrusted/version-skewed subprocess, so a field typed `string` here may at
 * runtime be a number, null, etc. — calling `.trim()` on a non-string would crash
 * the hook. Returns "" for any non-string so the safe block/warn path still runs.
 */
function safeStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Parse the agent CLI's JSON error envelope from a stream. Returns undefined when
 * the text is empty or not a JSON object — the caller defaults to block (safety).
 *
 * Exported for testability — the decision keys on the structured envelope, never on
 * a Markdown rendering.
 */
export function parseAgentErrorEnvelope(text: string): AgentErrorEnvelope | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return parsed as AgentErrorEnvelope;
}

/** Whether the envelope is a problem document: a `code` and a `detail`, both strings. */
function isProblemEnvelope(envelope: AgentErrorEnvelope): boolean {
  return typeof envelope.code === "string" && typeof envelope.detail === "string";
}

/**
 * The client codes whose fix is the machine's set-up, not the file: a configuration, a tool
 * missing or too old. Their domain is `input`, the caller's, which the hook would otherwise read
 * as the file's.
 */
const ENVIRONMENT_CODES: ReadonlySet<string> = new Set([
  "client.not_configured",
  "client.tool_missing",
  "client.tool_outdated",
]);

/**
 * The domains whose failure is the environment's, not the file's: the agent is told and does not
 * edit the file. A problem's `account`, `operator` and `runtime`, the client codes of the
 * machine's set-up, and the legacy envelope's `config` and `runtime`.
 */
const ENVIRONMENT_DOMAINS: ReadonlySet<string> = new Set([
  "account",
  "operator",
  "runtime",
  "environment",
  "config",
]);

/** How the hook reads a code the core registry declares: `environment` for `ENVIRONMENT_CODES`, else its domain. */
function knownCodeDomain(entry: RegistryEntry): string {
  return ENVIRONMENT_CODES.has(entry.code) ? "environment" : entry.domain;
}

/**
 * The domain a problem reads as. A code of `ENVIRONMENT_CODES` reads as `environment`, then the
 * problem's own `domain` when the hook knows it. A problem whose domain the hook does not know is
 * read as the codes of its family the hook knows (protocol.md, "A reader falls back on the
 * family"): their domain when they share one, or, when they disagree, `environment` if every one
 * of them would warn and `""` otherwise, which blocks.
 *
 * A problem of a family the hook knows nothing of, such as an extension code
 * (`pipelex.validation.foo`) or a core family newer than the registry this CLI vendors, reads as
 * `""` and blocks. The protocol reads such a problem as `runtime` (`problemDomain` in
 * `problems/reading.ts`, which every other reader of this CLI keeps), a reading made to show a
 * problem, not to gate an edit: here it would warn, letting a fault of the file through as the
 * environment's. The hook is a gate, so it fails closed: the agent reads the problem and decides.
 */
function problemEnvelopeDomain(code: string, domain: string): string {
  if (ENVIRONMENT_CODES.has(code)) return "environment";
  if ((PROBLEM_DOMAINS as readonly string[]).includes(domain)) return domain;
  const readings = familyEntries(codeFamily(code)).map(knownCodeDomain);
  const first = readings[0];
  if (first === undefined) return "";
  if (readings.every((reading) => reading === first)) return first;
  return readings.every((reading) => ENVIRONMENT_DOMAINS.has(reading)) ? "environment" : "";
}

/** The domain the envelope reads as: a problem's (`problemEnvelopeDomain`), else the legacy envelope's `error_domain`. */
function envelopeDomain(envelope: AgentErrorEnvelope): string {
  if (isProblemEnvelope(envelope)) {
    return problemEnvelopeDomain(envelope.code as string, safeStr(envelope.domain));
  }
  return safeStr(envelope.error_domain);
}

/** The locators a legacy item names, in order, each with its label. */
const LEGACY_ITEM_LOCATORS: ReadonlyArray<readonly [keyof LegacyValidationItem, string]> = [
  ["pipe_code", "pipe"],
  ["concept_code", "concept"],
  ["domain_code", "domain"],
  ["field_name", "field"],
  ["missing_pipe_code", "missing pipe"],
  ["missing_concept_code", "missing concept"],
  ["source", "source"],
];

/** A legacy item as list lines: `- [<category>] <message> (<locators>)`, then its suggested fix. */
function formatLegacyItem(item: LegacyValidationItem): string {
  const locators = LEGACY_ITEM_LOCATORS.filter(([key]) => item[key])
    .map(([key, label]) => `${label}: ${String(item[key])}`)
    .join(", ");
  const category = item.category ? `[${String(item.category)}] ` : "";
  const line = `- ${category}${String(item.message ?? "")}${locators ? ` (${locators})` : ""}`;
  const fix = item.suggested_fix;
  const description =
    typeof fix === "object" && fix !== null
      ? safeStr((fix as { description?: unknown }).description).trim()
      : "";
  return description ? `${line}\n  Suggested fix: ${description}` : line;
}

/** A problem's item as list lines: `- <code>: <detail> (<location>)`, then its suggested fix. */
function formatProblemItem(item: ProblemItem): string {
  const line = `- ${formatItem(item)}`;
  return item.suggested_fix === undefined
    ? line
    : `${line}\n  ${formatSuggestedFix(item.suggested_fix)}`;
}

/**
 * Build an agent-facing reason from the structured envelope: the message plus a compact
 * error list. An item carrying a suggested fix gets a `Suggested fix` line under it, the
 * next step the agent should take.
 *
 * The items come from another program, so a malformed list or item is left out rather than
 * crashing the hook: a malformed envelope still produces a clean block.
 */
export function formatValidationReason(
  file: string,
  envelope: AgentErrorEnvelope,
  fallback: string,
): string {
  const problem = isProblemEnvelope(envelope);
  const message =
    safeStr(envelope.message).trim() ||
    (problem ? safeStr(envelope.detail).trim() : "") ||
    fallback;
  const rawItems = problem ? envelope.errors : envelope.validation_errors;
  const items: unknown[] = Array.isArray(rawItems) ? rawItems : [];
  const lines = problem
    ? items.filter(isProblemItem).map(formatProblemItem)
    : items
        .filter((item): item is LegacyValidationItem => typeof item === "object" && item !== null)
        .map(formatLegacyItem);
  if (lines.length === 0) return `Validation failed for ${file}:\n\n${message}`;
  return `Validation failed for ${file}:\n\n${message}\n\n${lines.join("\n")}`;
}

export function truncateForAdditionalContext(text: string): string {
  if (text.length <= ADDITIONAL_CONTEXT_MAX_LEN) return text;
  const omitted = text.length - ADDITIONAL_CONTEXT_MAX_LEN;
  return text.slice(0, ADDITIONAL_CONTEXT_MAX_LEN) + `\n\n[truncated, ${omitted} chars omitted]`;
}

export type Stage3Outcome =
  | { kind: "pass" }
  | { kind: "block"; reason: string }
  | { kind: "warn"; context: string; domain: string };

/**
 * Decide what to emit for a single file's `pipelex-agent validate bundle` result,
 * reading the STRUCTURED JSON envelope (its domain) rather than grepping Markdown.
 * The block/warn split mirrors the bash hook in mthds-plugins.
 *
 * - exit 0                          → pass (no output)
 * - a domain of the environment     → warn (additionalContext, environment issue): a
 *   problem's `account`, `operator` or `runtime`, the legacy envelope's `config` or `runtime`
 * - anything else (input, method, unknown, no-verdict) → block (default-to-block safety),
 *   reason built from the envelope's message and its items; a problem of a code family the hook
 *   knows nothing of is unknown here, never read as `runtime` (`problemEnvelopeDomain`)
 * - unparseable / empty stderr      → block with a generic reason
 */
export function classifyStage3Result(file: string, result: PipelexValidateResult): Stage3Outcome {
  if (result.exitCode === 0) return { kind: "pass" };

  const envelope = parseAgentErrorEnvelope(result.stderr);
  if (envelope === undefined) {
    const detail = result.stderr.trim();
    return {
      kind: "block",
      reason:
        detail.length === 0
          ? `Validation failed for ${file} (pipelex-agent exited ${result.exitCode} with no stderr output)`
          : `Validation failed for ${file}:\n\n${truncateForAdditionalContext(detail)}`,
    };
  }

  const domain = envelopeDomain(envelope);
  if (ENVIRONMENT_DOMAINS.has(domain)) {
    const header = `Validation warning for ${file} (${domain} domain — environment issue, do not edit the file):\n\n`;
    const body =
      safeStr(envelope.message).trim() || safeStr(envelope.detail).trim() || result.stderr.trim();
    return {
      kind: "warn",
      domain,
      context: header + truncateForAdditionalContext(body),
    };
  }

  return {
    kind: "block",
    reason: truncateForAdditionalContext(
      formatValidationReason(file, envelope, result.stderr.trim()),
    ),
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
  pathExt: string | undefined,
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
      candidates.push(dir.endsWith(pathSep) ? `${dir}${fullName}` : `${dir}${pathSep}${fullName}`);
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
    process.env.PATHEXT,
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
  const result = spawnSync("plxt", args, { encoding: "utf8", env: passthroughEnv() });
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
 * Run `pipelex-agent validate bundle <file> -L <libraryDir> --allow-signatures
 * --format json --error-format json`. We do NOT shell out through `mthds-agent`
 * to avoid recursing into this same CLI; pipelex-agent's bundle validation is
 * offline-safe.
 *
 * `--format json --error-format json` is the load-bearing decision input: the
 * hook reads the structured domain from the JSON envelope (stderr on a non-zero
 * exit) rather than grepping Markdown — so the block/warn decision no longer
 * depends on a fragile text shape.
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
    [
      "validate",
      "bundle",
      file,
      "-L",
      libraryDir,
      "--allow-signatures",
      "--format",
      "json",
      "--error-format",
      "json",
    ],
    { encoding: "utf8", env: passthroughEnv() },
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
      buildBlockPayload(`Missing required CLI tool: plxt (install via: ${PLXT_INSTALL_HINT})`),
    );
    return;
  }

  if (!deps.hasPipelexAgent()) {
    deps.emit(
      buildBlockPayload(
        `Missing required CLI tool: pipelex-agent (install via: ${PIPELEX_AGENT_INSTALL_HINT})`,
      ),
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
    // The decision reads the structured JSON envelope's domain. Block on an
    // input, method or unknown domain (agent revises the bundle); warn via
    // additionalContext on a domain of the environment (agent should not edit
    // the file).
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
