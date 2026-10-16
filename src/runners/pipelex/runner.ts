import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runners } from "../types.js";
import { materializeBundleFiles } from "../bundle.js";
import { assertExclusiveRunSources } from "../../protocol/options.js";
import { argumentInvalid, problemError, ProblemError } from "../../problems/errors.js";
import { readProblemBody } from "../../problems/read.js";
import type { Runner, RunnerType, CheckModelRequest, CheckModelResponse } from "../types.js";
import type { RunOptions, StartOptions } from "../../protocol/options.js";
import type {
  ModelCategory,
  ModelDeck,
  ModelInfo,
  ValidationResult,
  VersionInfo,
} from "../../protocol/models.js";
import { MODEL_CATEGORIES } from "../../protocol/models.js";
import type { DictPipeOutput, DictRunResultExecute } from "../api/models.js";

const execFileAsync = promisify(execFile);

/** How long the health check waits for `pipelex doctor`, in seconds. */
const HEALTH_TIMEOUT_SECONDS = 10;
/** The exit status of a program that handled Ctrl-C itself, as pipelex does. */
const EXIT_INTERRUPTED = 130;

/** What a failed `execFile` call carries: the exit status or the system's code, and the output. */
interface ExecFailure {
  code?: number | string | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  stderr?: string;
  stdout?: string;
  message?: string;
}

/** What a failed call printed, stderr first, else its own message. */
function execFailureDetail(err: unknown): string {
  const failure = (err ?? {}) as ExecFailure;
  return failure.stderr?.trim() || failure.stdout?.trim() || failure.message || String(err);
}

/**
 * The problem-carrying error of a `pipelex` or `pipelex-agent` call that failed after it was
 * started or could not start: `client.tool_missing` when the program is not on the PATH, the
 * problem it printed on stderr when it printed one (`pipelex-agent` with `--format json` writes
 * its failure as a problem document), else `runtime.unexpected` with `message` and what it printed.
 */
function execFailureError(err: unknown, tool: string, message: string): ProblemError {
  const failure = (err ?? {}) as ExecFailure;
  if (failure.code === "ENOENT") {
    return problemError(
      "client.tool_missing",
      { tool },
      { message: `${tool} not found: ${failure.message ?? String(err)}`, cause: err },
    );
  }
  const printed = failure.stderr?.trim() ? readProblemBody(failure.stderr.trim()) : undefined;
  if (printed !== undefined) {
    return new ProblemError(printed, { cause: err });
  }
  return problemError(
    "runtime.unexpected",
    {},
    { message: `${message}:\n${execFailureDetail(err)}`, cause: err },
  );
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mthds-"));
}

/**
 * Materialize bare `.mthds` contents into a temp directory so the local CLI can load
 * them, for the MTHDS Protocol routes that ride bare strings (`execute` / `start` /
 * `validate`). Returns the path of the first file, `bundle.mthds`, which the CLI is
 * pointed at; the rest sit beside it as `extra_<n>.mthds` and are picked up via
 * `-L <tmp>`.
 */
function writeMthdsContents(tmp: string, contents: string[]): string {
  if (contents.length === 0) {
    throw argumentInvalid("mthds_contents", "empty", "At least one MTHDS file is required.");
  }
  contents.forEach((content, index) => {
    const name = index === 0 ? "bundle.mthds" : `extra_${index}.mthds`;
    writeFileSync(join(tmp, name), content, "utf-8");
  });
  return join(tmp, "bundle.mthds");
}

/** How a stuff's `concept` reads when it is not the ref string, for the refusal that names it. */
function describeNonRefConcept(concept: unknown): string {
  if (concept === undefined) return "missing";
  if (concept === null) return "null";
  if (Array.isArray(concept)) return "a list";
  if (typeof concept === "object") return "an object";
  return `the ${typeof concept} ${String(concept)}`;
}

/**
 * The pipelex CLI's own run flags, which `execute` forwards to `pipelex run`. They
 * steer the pipelex runtime, not the request, so they ride beside the protocol's
 * `RunOptions` rather than inside it, and no other runner reads them.
 */
export interface PipelexRunFlags {
  /** `--dry-run`: run without inference calls. pipelex refuses it on a hosted run. */
  dryRun?: boolean;
  /** `--mock-inputs`: mock the missing required inputs. pipelex requires `--dry-run` with it. */
  mockInputs?: boolean;
  /** `true` sends `--hosted`, `false` sends `--local`; unset leaves pipelex's `[run] execution` setting to decide. */
  hosted?: boolean;
}

/** How a `PipelexRunner` starts the `pipelex` and `pipelex-agent` processes it runs. */
export interface PipelexRunnerOptions {
  /**
   * Their environment; this process's when absent. `mthds-agent` passes its own plus
   * `PIPELEX_USAGE_STATS_HOST=mthds-agent`, so their usage statistics say that it ran them.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * The numbers `pipelex --version` reports, one `<label> <version>` line each since pipelex 0.57.0:
 * `pipelex <version>`, `mthds-protocol <version>` and `mthds-standard <version>`. The protocol
 * version is the one the installed pipelex speaks, which need not be the one this package follows,
 * so it is read from pipelex rather than restated. A pipelex that prints no protocol line is older
 * than the handshake and cannot say which protocol it speaks, so its version is refused.
 */
export function parsePipelexVersionReport(stdout: string): {
  pipelexVersion: string;
  protocolVersion: string;
} {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const labelled = (label: string): string | undefined => {
    for (const line of lines) {
      const [first, second, ...rest] = line.split(/\s+/);
      if (first === label && second !== undefined && rest.length === 0) return second;
    }
    return undefined;
  };
  // The first line was the version alone before pipelex named itself on it.
  const pipelexVersion = labelled("pipelex") ?? lines[0]?.split(/\s+/).pop() ?? "";
  const protocolVersion = labelled("mthds-protocol");
  if (protocolVersion === undefined) {
    throw problemError(
      "client.tool_outdated",
      { tool: "pipelex", version: pipelexVersion || "unknown" },
      {
        message: `pipelex ${pipelexVersion} does not report the MTHDS Protocol version it speaks; upgrade pipelex to 0.57.0 or later.`,
      },
    );
  }
  return { pipelexVersion, protocolVersion };
}

export class PipelexRunner implements Runner {
  readonly type: RunnerType = Runners.PIPELEX;
  private readonly libraryDirs: string[];
  private readonly env: NodeJS.ProcessEnv | undefined;

  constructor(libraryDirs?: string[], options: PipelexRunnerOptions = {}) {
    this.libraryDirs = libraryDirs ?? [];
    this.env = options.env;
  }

  private libraryArgs(): string[] {
    return this.libraryDirs.flatMap((dir) => ["-L", dir]);
  }

  private async exec(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("pipelex", [...args, ...this.libraryArgs()], {
      encoding: "utf-8",
      env: this.env,
    });
  }

  /**
   * Run pipelex with stdout and stderr inherited (streamed to the terminal).
   * Use this for long-running or interactive commands. A failure is a `ProblemError`: pipelex
   * printed its own account on the terminal, in human text with no problem to reuse, so a non-zero
   * exit is `runtime.unexpected`, and one the person caused with Ctrl-C (the interrupt killed
   * pipelex, or pipelex handled it and exited 130) is `client.aborted`.
   */
  private async execStreaming(args: string[], inheritStdin = false): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn("pipelex", [...args, ...this.libraryArgs()], {
        stdio: [inheritStdin ? "inherit" : "ignore", "inherit", "inherit"],
        env: this.env,
      });
      child.on("error", (err) =>
        reject(
          problemError(
            "client.tool_missing",
            { tool: "pipelex" },
            { message: `pipelex not found: ${err.message}`, cause: err },
          ),
        ),
      );
      child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (code === 0) {
          resolve();
        } else if (signal === "SIGINT" || code === EXIT_INTERRUPTED) {
          reject(problemError("client.aborted", {}, { message: "pipelex was interrupted." }));
        } else {
          const how =
            code === null ? `was stopped by the signal ${signal}` : `exited with code ${code}`;
          reject(problemError("runtime.unexpected", {}, { message: `pipelex ${how}` }));
        }
      });
    });
  }

  // ── CLI passthrough ──────────────────────────────────────────

  async buildPassthrough(subcommand: string, rawArgs: string[]): Promise<void> {
    await this.execStreaming(["build", subcommand, ...rawArgs]);
  }

  async runPassthrough(rawArgs: string[]): Promise<void> {
    await this.execStreaming(["run", ...rawArgs], true);
  }

  async validatePassthrough(rawArgs: string[]): Promise<void> {
    await this.execStreaming(["validate", ...rawArgs]);
  }

  // ── Health & version ────────────────────────────────────────────

  /**
   * Check pipelex with `pipelex doctor`, given `HEALTH_TIMEOUT_SECONDS` to answer. A failure is a
   * `ProblemError`: `client.tool_missing` when pipelex is not on the PATH, `client.timeout` when
   * doctor did not answer in time, `runtime.misconfigured` when it exited 1, having found issues,
   * else `runtime.unexpected`.
   */
  async health(): Promise<Record<string, unknown>> {
    try {
      await execFileAsync("pipelex", ["doctor", "-g", ...this.libraryArgs()], {
        encoding: "utf-8",
        env: this.env,
        timeout: HEALTH_TIMEOUT_SECONDS * 1000,
      });
      return { status: "ok" };
    } catch (cause) {
      const failure = (cause ?? {}) as ExecFailure;
      if (failure.code === "ENOENT") {
        throw problemError(
          "client.tool_missing",
          { tool: "pipelex" },
          { message: "pipelex CLI is not installed or not in PATH", cause },
        );
      }
      if (failure.killed === true) {
        throw problemError(
          "client.timeout",
          { seconds: HEALTH_TIMEOUT_SECONDS },
          {
            message: `pipelex health check timed out after ${HEALTH_TIMEOUT_SECONDS}s`,
            cause,
          },
        );
      }
      if (failure.code === 1) {
        throw problemError(
          "runtime.misconfigured",
          { component: "pipelex" },
          { message: `pipelex doctor found issues:\n${execFailureDetail(cause)}`, cause },
        );
      }
      throw problemError(
        "runtime.unexpected",
        {},
        { message: `pipelex health check failed:\n${execFailureDetail(cause)}`, cause },
      );
    }
  }

  async version(): Promise<VersionInfo> {
    let stdout: string;
    try {
      ({ stdout } = await this.exec(["--version"]));
    } catch (err) {
      throw execFailureError(err, "pipelex", "pipelex --version failed");
    }
    const { pipelexVersion, protocolVersion } = parsePipelexVersionReport(stdout);
    return {
      protocol_version: protocolVersion,
      runner_version: pipelexVersion,
      // Implementation identity rides the protocol's extension-open VersionInfo.
      implementation: "pipelex",
      implementation_version: pipelexVersion,
      runtime_version: pipelexVersion,
    };
  }

  // pipelex-agent check-model <reference> --type <type> --format json
  // check-model is a LOCAL CLI capability of this runner only — the Pipelex API
  // has no check-model route, so this method is NOT on the shared `Runner`
  // interface. The local runner always forces --format json: pipelex-agent's
  // markdown output is plain text (via print()), which can't satisfy the
  // CheckModelResponse contract. The request's `format` field is intentionally
  // ignored here. pipelex-agent declares --type as a required typer option (no
  // default), so we guard here for SDK consumers that bypass the agent CLI's parser.
  async checkModel(request: CheckModelRequest): Promise<CheckModelResponse> {
    if (!request.type) {
      throw argumentInvalid(
        "type",
        "missing",
        `checkModel requires \`type\` (one of: ${MODEL_CATEGORIES.join(", ")})`,
      );
    }
    const args = ["check-model", request.reference, "--type", request.type, "--format", "json"];
    const { stdout } = await execFileAsync("pipelex-agent", args, {
      encoding: "utf-8",
      env: this.env,
    }).catch((err: unknown) => {
      throw execFailureError(err, "pipelex-agent", "pipelex-agent check-model failed");
    });
    return JSON.parse(stdout) as CheckModelResponse;
  }

  // pipelex-agent models [--type <type>] --format json
  async models(category?: ModelCategory): Promise<ModelDeck> {
    const args = ["models"];
    if (category) {
      args.push("--type", category);
    }
    args.push("--format", "json");
    const { stdout } = await execFileAsync("pipelex-agent", args, {
      encoding: "utf-8",
      env: this.env,
    }).catch((err: unknown) => {
      throw execFailureError(err, "pipelex-agent", "pipelex-agent models failed");
    });
    return toModelDeck(JSON.parse(stdout));
  }

  // ── Method execution ────────────────────────────────────────────
  // pipelex run <target> [--pipe code] [--inputs file] [--output-dir dir]
  // Blocking — methods run through `execute`, and pipelex executes them locally
  // or on the hosted Pipelex API, as its `[run] execution` setting says, unless
  // `flags.hosted` overrides it. There is no durable run to poll by id; the async
  // `start` primitive is unsupported (use the API runner for that).

  async execute(options: RunOptions, flags: PipelexRunFlags = {}): Promise<DictRunResultExecute> {
    // Reject conflicting run sources up front — the same contract the API client
    // enforces — so a bundle combined with `mthds_contents` (or both encodings)
    // fails clearly instead of the branch order below silently preferring one.
    assertExclusiveRunSources(options);
    // The local runner materializes `files` to disk; it has no zip decoder, so
    // the `bundle_b64` transport form is API-runner-only. Reject it explicitly
    // rather than dispatching `run` with no target (which fails cryptically).
    if (options.bundle_b64 != null) {
      throw problemError(
        "runtime.unsupported",
        { capability: "bundle_b64" },
        {
          message:
            "The local pipelex runner does not support the bundle_b64 (zip) transport; pass the bundle as `files`, or use the API runner.",
        },
      );
    }
    const tmp = makeTmpDir();
    try {
      // The pipelex CLI dispatches through `run bundle <path>` / `run pipe <code>`.
      const args: string[] = ["run"];

      if (options.files && Object.keys(options.files).length > 0) {
        // A full method bundle (custom PipeFunc Python travels with the method).
        // Materialize it to disk preserving `funcs/*.py`, then run the main
        // `.mthds` with the temp dir as its library so the funcs resolve. The
        // caller-selected entrypoint (`bundleMain`) is honored so a directory of
        // several methods runs the one that was named, not a re-guessed sibling.
        const bundlePath = materializeBundleFiles(tmp, options.files, options.bundleMain);
        args.push("bundle", bundlePath);
        args.push("-L", tmp);
        if (options.pipe_code) {
          args.push("--pipe", options.pipe_code);
        }
      } else if (options.mthds_contents?.length) {
        const bundlePath = writeMthdsContents(tmp, options.mthds_contents);
        args.push("bundle", bundlePath);
        args.push("-L", tmp);
        if (options.pipe_code) {
          args.push("--pipe", options.pipe_code);
        }
      } else if (options.pipe_code) {
        args.push("pipe", options.pipe_code);
      }

      if (options.inputs) {
        const inputsPath = join(tmp, "inputs.json");
        writeFileSync(inputsPath, JSON.stringify(options.inputs), "utf-8");
        args.push("--inputs", inputsPath);
      }

      if (flags.dryRun) {
        args.push("--dry-run");
      }
      if (flags.mockInputs) {
        args.push("--mock-inputs");
      }
      if (flags.hosted !== undefined) {
        args.push(flags.hosted ? "--hosted" : "--local");
      }

      // Pin the working-memory artifact to a known path; other outputs go to
      // an incremental directory under --output-dir which we don't need.
      const wmPath = join(tmp, "working_memory.json");
      args.push("--working-memory-path", wmPath);
      args.push("--output-dir", join(tmp, "results"));
      args.push("--no-pretty-print");

      await this.execStreaming(args);

      const raw = existsSync(wmPath)
        ? (JSON.parse(readFileSync(wmPath, "utf-8")) as Record<string, unknown>)
        : {};

      // The CLI writes the runtime's FULL working memory
      // (`{root: {name: {stuff_code, stuff_name, concept, content}}, aliases}`), each stuff
      // naming its concept by its crate key, the string the standard puts on the wire.
      // Reduce each stuff to the SDK wire shape `{concept, content}`, passing the key
      // through as written so a dependency's `<package_address>::<domain>.<Code>` survives.
      // A stuff carrying anything else in its place — the concept object a runtime older
      // than standard 2.1.0 wrote, or no concept at all — is refused rather than reduced,
      // as mthds-python's runner refuses it. The runtime-internal id keeps its
      // `pipeline_run_id` name (D1: internals are out of the rename scope).
      const rawRoot = (raw["root"] ?? {}) as Record<string, unknown>;
      const aliases = (raw["aliases"] ?? {}) as Record<string, string>;
      const reducedRoot: Record<string, { concept: string; content: unknown }> = {};
      for (const [stuffName, stuff] of Object.entries(rawRoot)) {
        const fields =
          typeof stuff === "object" && stuff !== null ? (stuff as Record<string, unknown>) : {};
        const concept = fields["concept"];
        if (typeof concept !== "string") {
          throw problemError(
            "client.tool_outdated",
            { tool: "pipelex", version: await this.versionForRefusal() },
            {
              message:
                `pipelex wrote the stuff "${stuffName}" whose "concept" is ${describeNonRefConcept(concept)}, ` +
                `where the MTHDS standard puts the concept's ref string; upgrade pipelex.`,
            },
          );
        }
        reducedRoot[stuffName] = { concept, content: fields["content"] };
      }

      // `main_stuff_name` is a pipelex extension field riding the protocol's
      // extension-open response — not a protocol field.
      return {
        pipeline_run_id: "",
        pipe_output: {
          working_memory: { root: reducedRoot, aliases },
          pipeline_run_id: "",
        } as DictPipeOutput,
        main_stuff_name: aliases["main_stuff"] ?? "main_stuff",
      };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ── Validation ──────────────────────────────────────────────────
  // pipelex validate bundle <bundle.mthds> [--allow-signatures]

  async validate(mthdsContents: string[], allowSignatures = false): Promise<ValidationResult> {
    const tmp = makeTmpDir();
    try {
      const bundlePath = writeMthdsContents(tmp, mthdsContents);
      const args = ["validate", "bundle", bundlePath, "-L", tmp];
      if (allowSignatures) {
        args.push("--allow-signatures");
      }
      try {
        await this.exec(args);
      } catch (err) {
        const execError = err as Error & ExecFailure;
        const detail = execFailureDetail(err);
        // The bare `pipelex validate` follows the 0/1/2 exit policy: exit 1 is a
        // produced negative verdict (the bundle is invalid), exit 2+ (or a spawn
        // failure, whose `code` is a string like "ENOENT") is a *no-verdict*
        // condition (setup / bad args / internal). A negative verdict is a result,
        // not a transport failure → return the minimal invalid arm (mirroring the
        // minimal valid arm below — the CLI emits human text, not structured
        // diagnostics, so the one item the protocol asks of an invalid verdict is the
        // method not validating, stated by what the CLI printed rather than by the
        // registry's detail, which the verdict's own problem already states). Everything
        // else is a failure carrying its problem: pipelex missing is `client.tool_missing`,
        // any other no-verdict `runtime.unexpected`.
        if (execError.code === 1) {
          return {
            is_valid: false,
            errors: [{ code: "method.invalid", detail }],
            pending_signatures: [],
            is_runnable: false,
            message: "Bundle validation failed.",
          };
        }
        throw execFailureError(err, "pipelex", "Bundle validation failed");
      }
      // Exit 0 — a valid verdict. The CLI emits human-readable output, not the
      // structural artifacts, so return the minimal valid arm (the `is_valid: true`
      // discriminant), not the full report. (Per the protocol contract, a CLI
      // runner may return minimal discriminant arms.)
      return { is_valid: true };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** The version pipelex reports, for a refusal naming it, or `unknown` when it reports none. */
  private async versionForRefusal(): Promise<string> {
    try {
      const { stdout } = await this.exec(["--version"]);
      return stdout.match(/\d+\.\d+\.\d+\S*/)?.[0] ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  // ── Async start (protocol primitive, unsupported locally) ──────────
  // The local pipelex CLI runs methods in-process and blocking via `execute`;
  // there is no durable run to start and poll by id, so the protocol's async
  // `start` primitive belongs to the Pipelex Hosted API (use --runner api).

  async start(_options: StartOptions): Promise<never> {
    throw problemError(
      "runtime.unsupported",
      { capability: "start" },
      { message: ASYNC_START_UNSUPPORTED },
    );
  }
}

const ASYNC_START_UNSUPPORTED =
  "Async start is not supported by the pipelex CLI runner — it runs methods in-process and blocking. Use `execute` (e.g. `mthds run`), or the API runner for durable start (--runner api).";

/**
 * Normalize the local CLI's models output into the protocol `ModelDeck`.
 *
 * Accepts the deck shape verbatim (`{ models, aliases, waterfalls }`) and maps
 * the legacy `pipelex-agent models` shape, whose `presets`, `aliases` and
 * `waterfalls` are each keyed by category. The presets project into the
 * protocol's flat `models` list, each entry carrying its category as `type`,
 * raw: a category this version of the protocol does not define is kept, under
 * the protocol's reader rule (see `ModelInfo.type`). The aliases and waterfalls
 * stay keyed by category, as the routing extensions pipelex's own protocol
 * runner serves: the same alias name exists in several categories pointing at
 * different models, so flattening them would keep only one of them.
 */
function toModelDeck(parsed: unknown): ModelDeck {
  const root = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const aliases = root.aliases ?? {};
  const waterfalls = root.waterfalls ?? {};

  if (Array.isArray(root.models)) {
    return { models: root.models as ModelInfo[], aliases, waterfalls };
  }

  const models: ModelInfo[] = [];
  const presets = (root.presets ?? {}) as Record<string, Array<{ name: string }>>;
  for (const [category, entries] of Object.entries(presets)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry && typeof entry.name === "string") {
        models.push({ name: entry.name, type: category });
      }
    }
  }

  return { models, aliases, waterfalls };
}
