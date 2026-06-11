import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  writeFileSync,
  readFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runners } from "../types.js";
import type {
  Runner,
  RunnerType,
  BuildInputsRequest,
  BuildOutputRequest,
  BuildRunnerRequest,
  BuildRunnerResponse,
  ConceptRequest,
  ConceptResponse,
  PipeSpecRequest,
  PipeSpecResponse,
  CheckModelRequest,
  CheckModelResponse,
  ConceptRepresentationFormat,
} from "../types.js";
import type { RunOptions, StartOptions } from "../../protocol/options.js";
import type {
  ModelCategory,
  ModelDeck,
  ModelInfo,
  ValidationReport,
  VersionInfo,
} from "../../protocol/models.js";
import { MTHDS_PROTOCOL_VERSION } from "../../protocol/models.js";
import { conceptRef } from "../../protocol/concept.js";
import type { DictPipeOutput, DictRunResultExecute } from "../api/models.js";
import type {
  RunRead,
  RunResults,
  RunResultState,
  WaitForResultOptions,
} from "../api/runs.js";
import { BaseRunner } from "../base-runner.js";

const execFileAsync = promisify(execFile);

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mthds-"));
}

// Extract the canonical code from the first `[concept.X]` / `[pipe.X]` section of a TOML
// string. pipelex normalizes these names (ASCII fold, PascalCase / snake_case, namespace
// strip) before emitting TOML, so the section header is the source of truth — not the
// caller-supplied spec.
function extractSectionKey(toml: string, kind: "concept" | "pipe"): string | null {
  const m = toml.match(new RegExp(`\\[${kind}\\.([^\\]\\s]+)\\]`));
  return m && m[1] ? m[1] : null;
}

/**
 * Write an array of .mthds file contents to a temp directory.
 * Returns the path to the first file (the main bundle).
 */
function writeMthdsContents(tmp: string, contents: string[]): string {
  if (contents.length === 0) {
    throw new Error("mthds_contents must contain at least one element");
  }
  const bundlePath = join(tmp, "bundle.mthds");
  writeFileSync(bundlePath, contents[0]!, "utf-8");
  for (let i = 1; i < contents.length; i++) {
    writeFileSync(join(tmp, `extra_${i}.mthds`), contents[i]!, "utf-8");
  }
  return bundlePath;
}

export class PipelexRunner extends BaseRunner implements Runner {
  readonly type: RunnerType = Runners.PIPELEX;
  private readonly libraryDirs: string[];

  constructor(libraryDirs?: string[]) {
    super();
    this.libraryDirs = libraryDirs ?? [];
  }

  private libraryArgs(): string[] {
    return this.libraryDirs.flatMap((dir) => ["-L", dir]);
  }

  private async exec(
    args: string[]
  ): Promise<{ stdout: string; stderr: string }> {
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
      child.on("error", (err) =>
        reject(new Error(`pipelex not found: ${err.message}`))
      );
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
        setTimeout(() => reject(new Error("pipelex health check timed out after 10s")), 10_000)
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

  // ── Build ───────────────────────────────────────────────────────

  // pipelex-agent inputs bundle <bundle.mthds> --pipe <pipe_code>
  async buildInputs(request: BuildInputsRequest): Promise<unknown> {
    const tmp = makeTmpDir();
    try {
      const bundlePath = writeMthdsContents(tmp, request.mthds_contents);

      const { stdout } = await execFileAsync(
        "pipelex-agent",
        ["inputs", "bundle", bundlePath, "--pipe", request.pipe_code, "-L", tmp, ...this.libraryArgs()],
        { encoding: "utf-8" }
      );

      return JSON.parse(stdout) as unknown;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // pipelex build output bundle <bundle.mthds> --pipe <pipe_code> -o <file> --format <fmt>
  // Output format determines the file content: 'json'/'schema' produce JSON, 'python' produces Python code.
  // We always pass --format explicitly so the parsing branch below does not rely on
  // pipelex's CLI default, which is outside our contract.
  async buildOutput(request: BuildOutputRequest): Promise<unknown> {
    const tmp = makeTmpDir();
    try {
      const bundlePath = writeMthdsContents(tmp, request.mthds_contents);
      const outPath = join(tmp, "output.json");
      const format: ConceptRepresentationFormat = request.format ?? "json";

      const args = [
        "build",
        "output",
        "bundle",
        bundlePath,
        "--pipe",
        request.pipe_code,
        "-o",
        outPath,
        "-L",
        tmp,
        "--format",
        format,
        ...this.libraryArgs(),
      ];

      const { stderr } = await execFileAsync("pipelex", args, {
        encoding: "utf-8",
      });

      // pipelex can exit 0 without writing the file (e.g. render_output raises ValueError
      // and the CLI does `typer.Exit(0)` after printing the message to stderr). Surface
      // that diagnostic instead of an opaque ENOENT.
      if (!existsSync(outPath)) {
        throw new Error(
          `pipelex build output produced no file at ${outPath}.` +
            (stderr ? ` Output:\n${stderr.trim()}` : "")
        );
      }
      const raw = readFileSync(outPath, "utf-8");
      // 'python' format produces Python source code, not JSON. Return it as-is.
      if (format === "python") {
        return raw;
      }
      return JSON.parse(raw) as unknown;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // pipelex build runner bundle <bundle.mthds> --pipe <pipe_code> -o <file>
  async buildRunner(
    request: BuildRunnerRequest
  ): Promise<BuildRunnerResponse> {
    const tmp = makeTmpDir();
    try {
      const bundlePath = writeMthdsContents(tmp, request.mthds_contents);

      const outPath = join(tmp, "runner.py");
      await this.execStreaming([
        "build",
        "runner",
        "bundle",
        bundlePath,
        "--pipe",
        request.pipe_code,
        "-o",
        outPath,
        "-L",
        tmp,
        ...this.libraryArgs(),
      ]);

      const pythonCode = readFileSync(outPath, "utf-8");
      return {
        python_code: pythonCode,
        pipe_code: request.pipe_code,
        success: true,
        message: "Runner code generated via local CLI",
      };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ── Spec-to-TOML ────────────────────────────────────────────────

  // pipelex-agent concept --spec <json>
  async concept(request: ConceptRequest): Promise<ConceptResponse> {
    const { stdout } = await execFileAsync(
      "pipelex-agent",
      ["concept", "--spec", JSON.stringify(request.spec)],
      { encoding: "utf-8" }
    );
    return {
      success: true,
      concept_code:
        extractSectionKey(stdout, "concept") ??
        ((request.spec.concept_code as string) ?? ""),
      toml: stdout,
    };
  }

  // pipelex-agent pipe --type <type> --spec <json>
  async pipeSpec(request: PipeSpecRequest): Promise<PipeSpecResponse> {
    const { stdout } = await execFileAsync(
      "pipelex-agent",
      [
        "pipe",
        "--type",
        request.pipe_type,
        "--spec",
        JSON.stringify(request.spec),
      ],
      { encoding: "utf-8" }
    );
    return {
      success: true,
      pipe_code:
        extractSectionKey(stdout, "pipe") ??
        ((request.spec.pipe_code as string) ?? ""),
      pipe_type: request.pipe_type,
      toml: stdout,
    };
  }

  // pipelex-agent check-model <reference> --type <type> --format json
  // check-model is a LOCAL CLI capability of this runner only — the MTHDS API
  // has no check-model route, so this method is NOT on the shared `Runner`
  // interface. The local runner always forces --format json: pipelex-agent's
  // markdown output is plain text (via print()), which can't satisfy the
  // CheckModelResponse contract. The request's `format` field is intentionally
  // ignored here. pipelex-agent declares --type as a required typer option (no
  // default), so we guard here for SDK consumers that bypass the agent CLI's parser.
  async checkModel(request: CheckModelRequest): Promise<CheckModelResponse> {
    if (!request.type) {
      throw new Error("checkModel requires `type` (one of: llm, extract, img_gen, search)");
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
  // Local, blocking, in-process — there is no durable run to poll by id, so
  // `execute` / `startAndWaitForResult` run through here and the async
  // primitives (start / getRunStatus / getRunResult / waitForResult) are
  // unsupported.

  async execute(options: RunOptions): Promise<DictRunResultExecute> {
    const tmp = makeTmpDir();
    try {
      // The pipelex CLI dispatches through `run bundle <path>` / `run pipe <code>`.
      const args: string[] = ["run"];

      if (options.mthds_contents?.length) {
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
        writeFileSync(
          inputsPath,
          JSON.stringify(options.inputs),
          "utf-8"
        );
        args.push("--inputs", inputsPath);
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
          const domainCode = typeof conceptObj["domain_code"] === "string" ? conceptObj["domain_code"] : "";
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

  async validate(
    mthdsContents: string[],
    allowSignatures = false
  ): Promise<ValidationReport> {
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
        const execError = err as Error & { stderr?: string; stdout?: string };
        const detail = execError.stderr?.trim() || execError.stdout?.trim() || execError.message;
        throw new Error(`Bundle validation failed:\n${detail}`);
      }
      // The local CLI validates but emits human-readable output, not the
      // structural artifacts — a valid bundle yields an empty report.
      return {};
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ── Run lifecycle ──────────────────────────────────────────────────
  // The local pipelex CLI runs methods in-process; there is no durable run
  // to poll by id, so the async primitives belong to the hosted API (use
  // --runner api). `startAndWaitForResult` is supported — it runs the CLI
  // blocking and returns the result directly.

  override async startAndWaitForResult(
    options: StartOptions,
    _pollOptions?: WaitForResultOptions
  ): Promise<RunResults> {
    const response = await this.execute({
      mthds_contents: options.mthds_contents ?? undefined,
      pipe_code: options.pipe_code ?? undefined,
      inputs: options.inputs ?? undefined,
      output_name: options.output_name ?? undefined,
      output_multiplicity: options.output_multiplicity ?? undefined,
      dynamic_output_concept_ref: options.dynamic_output_concept_ref ?? undefined,
    });
    const pipeOutput = response.pipe_output as DictPipeOutput | null | undefined;
    return {
      pipeline_run_id: response.pipeline_run_id,
      main_stuff: null,
      // The local CLI blocking `pipe_output` carries no graph artifact.
      graph_spec: null,
      pipe_output: (pipeOutput as Record<string, unknown> | null | undefined) ?? null,
    };
  }

  async start(_options: StartOptions): Promise<never> {
    throw new Error(RUN_LIFECYCLE_UNSUPPORTED);
  }

  async getRunStatus(_runId: string): Promise<RunRead> {
    throw new Error(RUN_LIFECYCLE_UNSUPPORTED);
  }

  async getRunResult(
    _runId: string,
    _options?: { signal?: AbortSignal }
  ): Promise<RunResultState> {
    throw new Error(RUN_LIFECYCLE_UNSUPPORTED);
  }
}

const RUN_LIFECYCLE_UNSUPPORTED =
  "Run lifecycle (start/status/result/poll) is not supported by the pipelex CLI runner. Use the API runner instead (--runner api).";

/**
 * Normalize the local CLI's models output into the protocol `ModelDeck`.
 *
 * Accepts the deck shape verbatim (`{ models, aliases, waterfalls }`) and maps
 * the legacy `pipelex-agent models` shape (`presets` / nested `aliases` /
 * nested `waterfalls`, keyed by category) by flattening it.
 */
function toModelDeck(parsed: unknown): ModelDeck {
  const root = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;

  if (Array.isArray(root.models)) {
    return {
      models: root.models as ModelInfo[],
      aliases: (root.aliases as Record<string, string> | undefined) ?? {},
      waterfalls: (root.waterfalls as Record<string, string[]> | undefined) ?? {},
    };
  }

  const models: ModelInfo[] = [];
  const presets = (root.presets ?? {}) as Record<string, Array<{ name: string }>>;
  for (const [category, entries] of Object.entries(presets)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry && typeof entry.name === "string") {
        models.push({ name: entry.name, type: category as ModelInfo["type"] });
      }
    }
  }

  const aliases: Record<string, string> = {};
  const rawAliases = (root.aliases ?? {}) as Record<string, Record<string, string>>;
  for (const group of Object.values(rawAliases)) {
    if (group && typeof group === "object") Object.assign(aliases, group);
  }

  const waterfalls: Record<string, string[]> = {};
  const rawWaterfalls = (root.waterfalls ?? {}) as Record<string, Record<string, string[]>>;
  for (const group of Object.values(rawWaterfalls)) {
    if (group && typeof group === "object") Object.assign(waterfalls, group);
  }

  return { models, aliases, waterfalls };
}
