/**
 * The usage statistics of one CLI process: one `command_completed` per command, whatever its
 * outcome, sent as the contract says.
 *
 * `installUsageStats` hooks a Commander program. The command a process runs is the deepest command
 * Commander dispatched to; when its action is about to run, the session reads every switch, after
 * the legacy migration, and prints the notice where it may (`mthds` there, `mthds-agent` as it
 * exits, once it knows its stderr stayed free of JSON). When the process exits, whether the
 * command returned, called `process.exit` or failed to parse, the session builds the event and
 * either prints it (the debug variable) or writes it to the spool and starts the sender.
 *
 * Nothing is sent for `--help`, `--version`, a group named without a subcommand, an unknown
 * command, or the statistics command group itself (`mthds telemetry`). Everything here is
 * synchronous, since an exit handler cannot wait, and nothing here may throw: a failure of the
 * statistics never changes what the command does or how it exits.
 */

import { spawn, spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { BUDGETS_MS, ENV, NOTICE_TEXT, NOTICE_VERSION } from "./contract.js";
import type { Surface } from "./contract.js";
import { isCi, isContainer, isSetAndNotFalsy } from "./environment.js";
import { buildCommandCompleted } from "./event.js";
import type { Envelope } from "./event.js";
import { noteCancelled, outcomeNotes } from "./outcome.js";
import { writeSpoolFile } from "./spool.js";
import { resolveEndpoint, usageStatsOffBy } from "./switches.js";
import {
  isMachineDisabled,
  noticeVersionSeen,
  obtainInstallationId,
  recordNoticeShown,
  runLegacyMigration,
} from "./state.js";
import type { Installation } from "./state.js";

/** A command of the program: its path, the Commander command with its parsed options, and the arguments. */
export interface Invocation {
  path: string;
  command: Command;
  argv: readonly string[];
}

/** How the process was started: its surface, version and the rules that differ between the two CLIs. */
export interface UsageStatsOptions {
  surface: Surface;
  toolVersion: string;
  /** Whether the notice may be printed for this command, or whether its stderr is a machine contract. */
  noticeAllowed: (invocation: Invocation) => boolean;
  /**
   * Print the notice as the command exits rather than before it runs: `mthds-agent`'s own failures
   * write JSON to stderr on every path, so only at exit is it known whether the stream stayed one a
   * person reads.
   */
  noticeAtExit?: boolean;
  /** Top-level groups whose commands send nothing: the statistics group. */
  silentGroups?: readonly string[];
  argv?: readonly string[];
}

/** The path of a command in its program's tree, its words separated by one space, the root left out. */
export function commandPath(command: Command): string {
  const words: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) {
    words.unshift(current.name());
  }
  return words.join(" ");
}

/** Write a line to stderr synchronously, so it is not lost when the process exits right after. */
function writeStderrLine(line: string): void {
  const buffer = Buffer.from(`${line}\n`, "utf-8");
  let offset = 0;
  let attempts = 0;
  while (offset < buffer.length && attempts < 1000) {
    try {
      offset += writeSync(2, buffer, offset);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") return;
      attempts++;
    }
  }
}

function senderMainPath(): string {
  return fileURLToPath(new URL("./sender-main.js", import.meta.url));
}

/**
 * `hosted` from a run command's `--hosted` or `--local` as Commander parsed them, so that a value
 * (`--inputs --local`) or an argument after `--` is never read as the flag. Absent when neither was
 * given, and on a command that declares neither, such as `mthds-agent`'s, which hand their flags to
 * `pipelex-agent` unparsed: the `pipelex-agent` run reports where it ran.
 */
export function hostedFromOptions(path: string, command: Command): boolean | undefined {
  if (!path.startsWith("run ")) return undefined;
  const options = command.opts<{ hosted?: unknown; local?: unknown }>();
  if (options.hosted === true) return true;
  if (options.local === true) return false;
  return undefined;
}

export class UsageStatsSession {
  private readonly startedAt = Date.now();
  private readonly argv: readonly string[];
  private leaf: Command | undefined;
  private begun = false;
  private enabled = false;
  private silenced = false;

  constructor(private readonly options: UsageStatsOptions) {
    this.argv = options.argv ?? process.argv.slice(2);
  }

  /** Record the command Commander dispatched to; the deepest one is the command the process runs. */
  noteDispatched(command: Command): void {
    this.leaf = command;
  }

  /** Send nothing for this process: help, the version, or the banner. */
  silence(): void {
    this.silenced = true;
  }

  private path(): string | undefined {
    const leaf = this.leaf;
    if (leaf === undefined || leaf.commands.length > 0) return undefined;
    const path = commandPath(leaf);
    if (path === "") return undefined;
    const group = path.split(" ")[0]!;
    if ((this.options.silentGroups ?? []).includes(group)) return undefined;
    return path;
  }

  /**
   * Read the switches, after the legacy migration, and print the notice where it may be: what a
   * command does before any work of its own. Called when its action is about to run, or at exit
   * for a command that failed to parse.
   */
  begin(): void {
    if (this.begun) return;
    const path = this.path();
    if (path === undefined) return;
    this.begun = true;
    try {
      runLegacyMigration();
      this.enabled = usageStatsOffBy().length === 0;
      if (!this.options.noticeAtExit) this.showNotice(path);
    } catch {
      this.enabled = false;
    }
  }

  /**
   * Print the notice and record it, once per machine, while statistics are on, unless this command's
   * stderr is one a program reads: by the CLI's own rule, or because the command wrote JSON to it.
   */
  private showNotice(path: string): void {
    if (
      this.enabled &&
      !outcomeNotes().jsonOnStderr &&
      noticeVersionSeen() < NOTICE_VERSION &&
      this.options.noticeAllowed({ path, command: this.leaf!, argv: this.argv })
    ) {
      writeStderrLine(NOTICE_TEXT);
      recordNoticeShown();
    }
  }

  /** The exit handler: build the command's event and print it or hand it to a sender. */
  finish(exitCode: number): void {
    try {
      if (this.silenced) return;
      const path = this.path();
      if (path === undefined) return;
      this.begin();
      // A command that turned statistics off on the machine is not counted.
      if (!this.enabled || isMachineDisabled()) return;
      if (this.options.noticeAtExit) this.showNotice(path);
      const notes = outcomeNotes();
      const outcome = notes.cancelled ? "cancelled" : exitCode === 0 ? "succeeded" : "failed";
      const installation = obtainInstallationId();
      const event = buildCommandCompleted(
        {
          surface: this.options.surface,
          toolVersion: this.options.toolVersion,
          installation,
        },
        {
          command: path,
          outcome,
          errorDomain: notes.errorDomain,
          durationMs: Date.now() - this.startedAt,
          hosted: hostedFromOptions(path, this.leaf!),
        },
      );
      if (isSetAndNotFalsy(process.env[ENV.debug])) {
        writeStderrLine(JSON.stringify({ usage_stats_debug: event }));
        return;
      }
      deliver(event, installation);
    } catch {
      // Statistics never change how a command ends.
    }
  }
}

/**
 * Hand the event to a sender. A CLI writes it to the spool and starts a detached sender, which
 * posts the whole spool within ten seconds while the command exits at once. In CI or a container,
 * where the sender would be killed with the step, and when it cannot be started, the command posts
 * its own file before it exits, within one second, through a child process it waits for.
 *
 * An event under a process-local identifier, made when the identifier could not be saved, is never
 * spooled, since a sender would drop it as made under another identifier: the event itself is handed
 * to the sender on its command line, and lost if the post fails. Outside CI and containers that
 * sender is detached too, so a machine whose identifier cannot be saved never makes every command
 * wait at exit.
 */
function deliver(event: Envelope, installation: Installation): void {
  const endpoint = resolveEndpoint();
  if (endpoint === undefined) return;
  const waits = isCi() || isContainer();
  if (!installation.persisted) {
    const encoded = Buffer.from(JSON.stringify([event]), "utf-8").toString("base64");
    const target = ["--events", encoded];
    if (waits || !startDetachedSender(endpoint, target)) runSenderAndWait(endpoint, target);
    return;
  }
  const file = writeSpoolFile([event]);
  if (waits || !startDetachedSender(endpoint)) runSenderAndWait(endpoint, ["--file", file]);
}

/** Start a sender that outlives the command, draining the spool or posting `target`'s events. */
function startDetachedSender(endpoint: string, target: string[] = []): boolean {
  try {
    const child = spawn(
      process.execPath,
      [
        senderMainPath(),
        "--endpoint",
        endpoint,
        "--budget-ms",
        String(BUDGETS_MS.detachedSender),
        ...target,
      ],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    // A failed start leaves the child without a process id; its error event would come too late.
    child.on("error", () => undefined);
    if (child.pid === undefined) return false;
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Run the sender as a child and wait for it, within the in-process budget of one second. */
function runSenderAndWait(endpoint: string, target: string[]): void {
  // The child gets the budget less the time to start, so it gives an unsent file back before the
  // command stops waiting for it.
  const childBudgetMs = BUDGETS_MS.cliInProcess - 200;
  try {
    spawnSync(
      process.execPath,
      [senderMainPath(), "--endpoint", endpoint, "--budget-ms", String(childBudgetMs), ...target],
      { stdio: "ignore", timeout: BUDGETS_MS.cliInProcess, windowsHide: true },
    );
  } catch {
    // What could not be posted stays in the spool for the next sender.
  }
}

/**
 * Hook the usage statistics into a Commander program, once every command is registered. Answers
 * the session, which the CLI's error handler silences for help and the version.
 */
export function installUsageStats(program: Command, options: UsageStatsOptions): UsageStatsSession {
  const session = new UsageStatsSession(options);
  const hookTree = (command: Command): void => {
    if (command.commands.length > 0) {
      command.hook("preSubcommand", (_thisCommand, subCommand) => {
        session.noteDispatched(subCommand);
      });
    }
    for (const child of command.commands) hookTree(child);
  };
  hookTree(program);
  program.hook("preAction", (_thisCommand, actionCommand) => {
    session.noteDispatched(actionCommand);
    session.begin();
  });
  process.on("exit", (code) => session.finish(code));
  process.on("SIGINT", () => {
    noteCancelled();
    process.exit(130);
  });
  return session;
}
