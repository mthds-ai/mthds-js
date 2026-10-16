/**
 * Output helpers for the mthds-agent CLI.
 *
 * - Success: JSON (or Markdown, where a command offers it) on stdout.
 * - Error: the problem document on stderr, then `process.exit(1)`
 *   (mthds/docs/spec/cli-io-contract.md, "Error Propagation"). Every failure is one problem with
 *   a registered code, the same document whichever command or route failed: rendered as Markdown
 *   by default, for the agent reading it, and written as the problem's JSON form with
 *   `--error-format json`, for a program, which branches on `code`. The JSON form carries no
 *   `status`, even for a problem relayed from a runner, and members of this CLI's own ride beside
 *   the core ones, such as the command's own sentence in `message`.
 */

import { buildInstallCommand } from "./binaries.js";
import type { BinaryRecoveryInfo } from "./binaries.js";
import { ProblemError, reportedProblem } from "../problems/errors.js";
import { ApiResponseError } from "../runners/api/exceptions.js";
import { buildProblem } from "../problems/build.js";
import { renderProblemMarkdown } from "../problems/render.js";
import type { CoreErrorCode, ProblemParamsByCode } from "../problems/registry.generated.js";
import type { BuildProblemOptions } from "../problems/build.js";
import type { Problem } from "../problems/types.js";
import { noteProblem } from "../usage-stats/outcome.js";

// ── Re-export BinaryRecoveryInfo for callers ────────────────────────
export type { BinaryRecoveryInfo };

// ── Success output ───────────────────────────────────────────────────

export function agentSuccess(result: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

/** Emit a server-rendered Markdown success to stdout (exit 0) — the `--format markdown` valid arm. */
export function agentMarkdownSuccess(markdown: string): void {
  process.stdout.write(markdown.endsWith("\n") ? markdown : markdown + "\n");
}

// ── The error stream's format ────────────────────────────────────────

/** The two forms of the error stream: the problem rendered as Markdown, or its JSON form. */
export type ErrorFormat = "markdown" | "json";

/**
 * The value an option takes on a command line, as `--name value` or `--name=value`: its last
 * occurrence, as Commander reads a repeated option, wherever it stands, before the command or on
 * it. Nothing after `--` is an option.
 */
export function optionValue(argv: readonly string[], name: string): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") break;
    if (arg === name) {
      value = argv[index + 1];
      index += 1;
    } else if (arg?.startsWith(`${name}=`)) {
      value = arg.slice(name.length + 1);
    }
  }
  return value;
}

/**
 * The form of the error stream a command line asks for: its last `--error-format`, else its last
 * `--format` when it names `json`, the error stream inheriting the success stream's form as the
 * workspace's output rule says, else Markdown. Read from the command line itself rather than
 * from the parsed options, so that a failure before or during parsing is written in the form
 * asked for too, and so that every command reads the same value wherever the option stands.
 */
export function resolveErrorFormat(argv: readonly string[] = process.argv): ErrorFormat {
  const explicit = optionValue(argv, "--error-format");
  if (explicit === "json" || explicit === "markdown") return explicit;
  const inherited = optionValue(argv, "--format");
  return inherited === "json" ? "json" : "markdown";
}

let chosenErrorFormat: ErrorFormat | undefined;

/**
 * Fix the error stream's form for the rest of the process, as a command that parses its own
 * `--error-format` does once it has read it; `undefined` goes back to reading the command line.
 */
export function chooseErrorFormat(format: ErrorFormat | undefined): void {
  chosenErrorFormat = format;
}

// ── Building the problem of a failure ────────────────────────────────

/**
 * The problem of a failure this CLI detects itself, built from the core registry: its detail and
 * next step are the registry's templates filled with `params`, and `message`, the command's own
 * sentence, rides beside them, since it may name facts the parameters do not, such as the values
 * an option accepts.
 */
export function agentProblem<Code extends CoreErrorCode>(
  code: Code,
  params: ProblemParamsByCode[Code],
  message?: string,
  options: Omit<BuildProblemOptions, "extra"> = {},
): Problem {
  return buildProblem(code, params, { ...options, extra: { message } });
}

/**
 * The problem of an error a command caught: the problem a `ProblemError` carries, as received or
 * as the client built it, with the request id of the answer's header when the problem names none
 * (`reportedProblem`) and, for an answer of the runtime, this CLI's `answer` member naming its
 * route, its status and the start of a body that is no problem document, else `fallback`, the
 * problem the command reads an error of its kind as, with the error's message in `message`.
 */
export function problemOfError(err: unknown, fallback: (message: string) => Problem): Problem {
  if (!(err instanceof ProblemError))
    return fallback(err instanceof Error ? err.message : String(err));
  const problem = reportedProblem(err);
  return err instanceof ApiResponseError && !("answer" in problem)
    ? { ...problem, answer: err.answer }
    : problem;
}

/** The catch-all problem, `runtime.unexpected`, of a failure no other code describes. */
export function unexpectedProblem(message: string): Problem {
  return agentProblem("runtime.unexpected", {}, message);
}

// ── Error output ─────────────────────────────────────────────────────

/** Members of this CLI's own that ride a failure beside the problem's core members. */
export interface AgentErrorExtras {
  /** How to install or upgrade the binary a command needs, on a `client.tool_missing` or `client.tool_outdated`. */
  recovery?: BinaryRecoveryInfo;
  /** Verdict discriminant on a validate failure: `false` rides beside the method's `errors`. */
  is_valid?: boolean;
  /**
   * The methods the resolver refused, with the reasons. Rides an error the same way it rides a
   * success: an agent told "no valid methods" and nothing else has no way to learn that the
   * manifests were fine and addressed to another version of the standard. Every failure raised
   * once the read has happened carries it, whether or not the failure is about the refusals.
   */
  skipped_methods?: unknown[];
  /**
   * What mthds.sh's registry route answered for each method a publish sent, so a failed publish
   * says, method by method, why nothing was listed.
   */
  registrations?: unknown[];
}

/** The problem as this CLI writes it: its `status` left out, and its extras beside its members. */
function cliProblem(problem: Problem, extras: AgentErrorExtras | undefined): Problem {
  const { status: _status, ...written } = problem;
  for (const [name, value] of Object.entries(extras ?? {})) {
    if (value !== undefined && !(name in written)) written[name] = value;
  }
  return written;
}

/** The form of the error stream for the rest of this process. */
export function errorFormat(): ErrorFormat {
  return chosenErrorFormat ?? resolveErrorFormat();
}

/** A value of a report as one line of Markdown text. */
function inline(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * The extras of a failure rendered as Markdown sections after the problem's own, so that the
 * default error stream says what the JSON form carries: the runtime's answer, the command that
 * installs a missing tool, the methods the resolver refused with their reasons, and what mthds.sh
 * answered for each method.
 */
function renderExtrasMarkdown(problem: Problem, extras: AgentErrorExtras | undefined): string {
  const sections: string[] = [];
  const answer = problem.answer as
    | { route?: unknown; status?: unknown; excerpt?: unknown }
    | undefined;
  if (answer !== undefined && typeof answer === "object") {
    const lines = [`- Route: \`${inline(answer.route)}\`, status ${inline(answer.status)}`];
    if (answer.excerpt !== undefined)
      lines.push(`- The server answered: ${inline(answer.excerpt)}`);
    sections.push(`### Answer\n\n${lines.join("\n")}`);
  }
  if (extras?.recovery !== undefined) {
    sections.push(`### Recovery\n\nRun \`${buildInstallCommand(extras.recovery)}\`.`);
  }
  const skipped = (extras?.skipped_methods ?? []) as Array<{ name?: unknown; errors?: unknown }>;
  if (skipped.length > 0) {
    const lines = skipped.map((method) => {
      const reasons = Array.isArray(method.errors) ? method.errors.map(inline).join("; ") : "";
      return `- \`${inline(method.name)}\`${reasons ? `: ${reasons}` : ""}`;
    });
    sections.push(`### Skipped methods\n\n${lines.join("\n")}`);
  }
  const registrations = (extras?.registrations ?? []) as Array<Record<string, unknown>>;
  if (registrations.length > 0) {
    const lines = registrations.map((registration) => {
      const said = registration.message ?? (registration.error as { message?: unknown })?.message;
      const outcome = inline(registration.outcome);
      return `- \`${inline(registration.name)}\`: ${outcome}${said === undefined ? "" : ` (${inline(said)})`}`;
    });
    sections.push(`### Registrations\n\n${lines.join("\n")}`);
  }
  return sections.map((section) => `\n${section}\n`).join("");
}

/**
 * Write a failure on stderr and exit 1: the problem in the form the command line asks for
 * (`resolveErrorFormat`), noted for the command's usage statistics. The extras ride the JSON form
 * as members and the Markdown form as sections after the problem's.
 */
export function agentError(problem: Problem, extras?: AgentErrorExtras): never {
  const written = cliProblem(problem, extras);
  noteProblem(written);
  const output =
    errorFormat() === "json"
      ? `${JSON.stringify(written, null, 2)}\n`
      : renderProblemMarkdown(written) + renderExtrasMarkdown(written, extras);
  process.stderr.write(output);
  process.exit(1);
}

/**
 * Write a warning on stderr, in the error stream's form: `{"warning": true, "message": …}` and its
 * members in JSON, a `> **Warning**:` line in Markdown. A warning never stops the command.
 */
export function agentWarning(message: string, members: Record<string, unknown> = {}): void {
  if (errorFormat() === "json") {
    process.stderr.write(`${JSON.stringify({ warning: true, message, ...members })}\n`);
    return;
  }
  process.stderr.write(`> **Warning**: ${message}\n`);
}

/**
 * Write a failure a runner rendered as Markdown on stderr and exit 1 — the `--format markdown`
 * arm of an invalid verdict, which the runner renders as it renders the valid arm. `problem` is
 * the one the JSON arm would write, noted for the usage statistics as `agentError` notes it, so
 * both arms count the failure alike.
 */
export function agentMarkdownError(markdown: string, problem: Problem): never {
  noteProblem(problem);
  process.stderr.write(markdown.endsWith("\n") ? markdown : markdown + "\n");
  process.exit(1);
}
