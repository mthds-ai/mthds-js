import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runners } from "../types.js";
import { materializeMethodFiles } from "../bundle.js";
import { inlineMethodFiles } from "../api/tree-sending.js";
import { MethodTree } from "../../method-tree/tree.js";
import { assertOneMethodSource, hasMethodSource } from "../../protocol/options.js";
import { PipelineRequestError } from "../../protocol/exceptions.js";
import type { Runner, RunnerType, CheckModelRequest, CheckModelResponse } from "../types.js";
import type { MethodFiles } from "../../protocol/file_entries.js";
import type { RunOptions, StartOptions, ValidateSource } from "../../protocol/options.js";
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

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mthds-"));
}

/** The subdirectory of a run's scratch directory a method's tree is written into, alone. */
const METHOD_DIR_NAME = "method";

/**
 * The directory holding the method's tree on disk, for pipelex to list: the root of a
 * tree the lister read from this machine, used where it is rather than copied, or
 * `<scratch>/method/`, into which a `files` map or any other tree is written. Nothing
 * a run generates is written there, so no artifact lands on a file of the method.
 * `undefined` when the request carries no method.
 */
async function methodDirectory(
  source: { files?: MethodFiles | null; tree?: RunOptions["tree"] },
  scratch: string,
): Promise<string | undefined> {
  if (source.tree instanceof MethodTree && source.tree.root !== null) return source.tree.root;
  let files: MethodFiles | undefined;
  if (source.tree != null) files = await inlineMethodFiles(source.tree);
  else files = source.files ?? undefined;
  if (files === undefined) return undefined;
  const directory = join(scratch, METHOD_DIR_NAME);
  materializeMethodFiles(directory, files);
  return directory;
}

/** Whether the request's tree holds this tree path. */
function treeHolds(
  source: { files?: MethodFiles | null; tree?: RunOptions["tree"] },
  treePath: string,
): boolean {
  if (source.tree != null) return source.tree.files.some((file) => file.path === treePath);
  return source.files != null && Object.hasOwn(source.files, treePath);
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
    throw new Error(
      `pipelex ${pipelexVersion} does not report the MTHDS Protocol version it speaks; upgrade pipelex to 0.57.0 or later.`,
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
   * Use this for long-running or interactive commands.
   */
  private async execStreaming(args: string[], inheritStdin = false): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn("pipelex", [...args, ...this.libraryArgs()], {
        stdio: [inheritStdin ? "inherit" : "ignore", "inherit", "inherit"],
        env: this.env,
      });
      child.on("error", (err) => reject(new Error(`pipelex not found: ${err.message}`)));
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`pipelex exited with code ${code}`));
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

  async health(): Promise<Record<string, unknown>> {
    try {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("pipelex health check timed out after 10s")), 10_000),
      );
      await Promise.race([this.exec(["doctor", "-g"]), timeout]);
      return { status: "ok" };
    } catch {
      throw new Error("pipelex CLI is not installed or not in PATH");
    }
  }

  async version(): Promise<VersionInfo> {
    const { stdout } = await this.exec(["--version"]);
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
      throw new Error(`checkModel requires \`type\` (one of: ${MODEL_CATEGORIES.join(", ")})`);
    }
    const args = ["check-model", request.reference, "--type", request.type, "--format", "json"];
    const { stdout } = await execFileAsync("pipelex-agent", args, {
      encoding: "utf-8",
      env: this.env,
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
    // Refuse a method given twice, or an empty tree, up front — the same contract the
    // API client enforces — so `files` beside a `tree` fails clearly instead of one winning.
    assertOneMethodSource(options);
    const bundleMain = options.bundleMain;
    if (bundleMain != null && (!bundleMain.endsWith(".mthds") || !treeHolds(options, bundleMain))) {
      throw new PipelineRequestError(
        `bundleMain names '${bundleMain}', which is not a .mthds file of the method's tree.`,
      );
    }
    const tmp = makeTmpDir();
    try {
      // The local runner keeps no blob store: a tree is read in full and written to
      // disk, and a hash entry in a caller's `files` is refused while writing.
      const directory = await methodDirectory(options, tmp);
      // The pipelex CLI dispatches through `run bundle <path>` / `run pipe <code>`.
      const args: string[] = ["run"];

      if (directory !== undefined) {
        // The method's whole tree (its Python, templates and other files beside its
        // bundles). A bundle the caller named runs, with the tree's directory as its
        // library so its files resolve. With none named, pipelex is handed the
        // directory and chooses where the run starts by the protocol's rule: the
        // manifest's `main_pipe`, else the one `main_pipe` the bundles declare,
        // refusing a tree where that is ambiguous.
        if (bundleMain != null) {
          args.push("bundle", join(directory, ...bundleMain.split("/")), "-L", directory);
        } else {
          args.push("bundle", directory);
        }
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
          throw new Error(
            `pipelex wrote the stuff "${stuffName}" whose "concept" is ${describeNonRefConcept(concept)}, ` +
              `where the MTHDS standard puts the concept's ref string; upgrade pipelex.`,
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
  // pipelex validate bundle <the tree's directory> [--allow-signatures]

  async validate(source: ValidateSource, allowSignatures = false): Promise<ValidationResult> {
    assertOneMethodSource(source);
    if (!hasMethodSource(source)) {
      throw new PipelineRequestError("validate() needs the method's tree, as files or tree.");
    }
    const tmp = makeTmpDir();
    try {
      // pipelex is handed the tree's directory, so it chooses the bundle to start at
      // and loads the directory beside it, refusing a tree where the choice is ambiguous.
      const directory = (await methodDirectory(source, tmp))!;
      const args = ["validate", "bundle", directory];
      if (allowSignatures) {
        args.push("--allow-signatures");
      }
      try {
        await this.exec(args);
      } catch (err) {
        const execError = err as Error & {
          code?: number | string;
          stderr?: string;
          stdout?: string;
        };
        const detail = execError.stderr?.trim() || execError.stdout?.trim() || execError.message;
        // The bare `pipelex validate` follows the 0/1/2 exit policy: exit 1 is a
        // produced negative verdict (the bundle is invalid), exit 2+ (or a spawn
        // failure, whose `code` is a string like "ENOENT") is a *no-verdict*
        // condition (setup / bad args / internal). A negative verdict is a result,
        // not a transport failure → return the minimal invalid arm (mirroring the
        // minimal valid arm below — the CLI emits human text, not structured
        // diagnostics, so validation_errors is empty). Re-raise everything else.
        if (execError.code === 1) {
          return {
            is_valid: false,
            validation_errors: [],
            pending_signatures: [],
            is_runnable: false,
            message: `Bundle validation failed:\n${detail}`,
          };
        }
        throw new Error(`Bundle validation failed:\n${detail}`);
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

  // ── Async start (protocol primitive, unsupported locally) ──────────
  // The local pipelex CLI runs methods in-process and blocking via `execute`;
  // there is no durable run to start and poll by id, so the protocol's async
  // `start` primitive belongs to the Pipelex Hosted API (use --runner api).

  async start(_options: StartOptions): Promise<never> {
    throw new Error(ASYNC_START_UNSUPPORTED);
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
