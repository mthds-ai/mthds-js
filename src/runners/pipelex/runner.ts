import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runners } from "../types.js";
import { materializeBundleFiles } from "../bundle.js";
import { assertExclusiveRunSources } from "../../protocol/options.js";
import { PipelineRequestError } from "../../protocol/exceptions.js";
import type { Runner, RunnerType, CheckModelRequest, CheckModelResponse } from "../types.js";
import type { RunOptions, StartOptions } from "../../protocol/options.js";
import type {
  ModelCategory,
  ModelDeck,
  ModelInfo,
  ValidationResult,
  VersionInfo,
} from "../../protocol/models.js";
import { MODEL_CATEGORIES, MTHDS_PROTOCOL_VERSION } from "../../protocol/models.js";
import { conceptRef } from "../../protocol/concept.js";
import type { DictPipeOutput, DictRunResultExecute } from "../api/models.js";

const execFileAsync = promisify(execFile);

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
    throw new Error("At least one MTHDS file is required.");
  }
  contents.forEach((content, index) => {
    const name = index === 0 ? "bundle.mthds" : `extra_${index}.mthds`;
    writeFileSync(join(tmp, name), content, "utf-8");
  });
  return join(tmp, "bundle.mthds");
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

export class PipelexRunner implements Runner {
  readonly type: RunnerType = Runners.PIPELEX;
  private readonly libraryDirs: string[];

  constructor(libraryDirs?: string[]) {
    this.libraryDirs = libraryDirs ?? [];
  }

  private libraryArgs(): string[] {
    return this.libraryDirs.flatMap((dir) => ["-L", dir]);
  }

  private async exec(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("pipelex", [...args, ...this.libraryArgs()], {
      encoding: "utf-8",
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
    const pipelexVersion = stdout.trim();
    return {
      protocol_version: MTHDS_PROTOCOL_VERSION,
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
      throw new PipelineRequestError(
        "The local pipelex runner does not support the bundle_b64 (zip) transport; pass the bundle as `files`, or use the API runner.",
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
      // (`{root: {name: {stuff_code, stuff_name, concept: {...}, content}}, aliases}`).
      // Reduce each stuff to the SDK wire shape `{concept: <ref string>, content}` —
      // the same reduction the API runner performs server-side. The runtime-internal
      // id keeps its `pipeline_run_id` name (D1: internals are out of the rename scope).
      const rawRoot = (raw["root"] ?? {}) as Record<string, Record<string, unknown>>;
      const aliases = (raw["aliases"] ?? {}) as Record<string, string>;
      const reducedRoot: Record<string, { concept: string; content: unknown }> = {};
      for (const [stuffName, stuff] of Object.entries(rawRoot)) {
        const conceptRaw = stuff["concept"];
        let conceptRefStr: string;
        if (conceptRaw && typeof conceptRaw === "object") {
          const conceptObj = conceptRaw as Record<string, unknown>;
          const code = typeof conceptObj["code"] === "string" ? conceptObj["code"] : "";
          const domainCode =
            typeof conceptObj["domain_code"] === "string" ? conceptObj["domain_code"] : "";
          // A missing domain_code falls back to the bare code (no leading dot).
          conceptRefStr = domainCode ? conceptRef({ domain_code: domainCode, code }) : code;
        } else {
          conceptRefStr = String(conceptRaw ?? "");
        }
        reducedRoot[stuffName] = { concept: conceptRefStr, content: stuff["content"] };
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
