import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runners } from "./types.js";
import type {
  Runner,
  RunnerType,
  BuildInputsRequest,
  BuildOutputRequest,
  BuildRunnerRequest,
  BuildRunnerResponse,
  ExecuteRequest,
  PipelineResponse,
  ValidateRequest,
  ValidateResponse,
  ConceptRequest,
  ConceptResponse,
  PipeSpecRequest,
  PipeSpecResponse,
  CheckModelRequest,
  CheckModelResponse,
  ModelsRequest,
  ModelsResponse,
  ConceptRepresentationFormat,
} from "./types.js";
import type {
  StartRunOptions,
  RunPublic,
  RunRead,
  RunResult,
  RunResultState,
  WaitForResultOptions,
} from "../client/runs.js";
import { BaseRunner } from "./base-runner.js";

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

  async version(): Promise<Record<string, string>> {
    const { stdout } = await this.exec(["--version"]);
    return { pipelex: stdout.trim() };
  }

  // ── Build ───────────────────────────────────────────────────────
  // buildInputs and buildOutput have no CLI equivalent.

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
  // The local runner always forces --format json: pipelex-agent's markdown output is plain
  // text (via print()), which can't satisfy the CheckModelResponse contract. The request's
  // `format` field is intentionally ignored here.
  // pipelex-agent declares --type as a required typer option (no default), so we guard
  // here for SDK consumers that bypass the agent CLI's parser.
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

  // pipelex-agent models [--type <type>...] --format json
  async models(request?: ModelsRequest): Promise<ModelsResponse> {
    const args = ["models"];
    if (request?.type) {
      for (const t of request.type) {
        args.push("--type", t);
      }
    }
    args.push("--format", "json");
    const { stdout } = await execFileAsync("pipelex-agent", args, {
      encoding: "utf-8",
    });
    return JSON.parse(stdout) as ModelsResponse;
  }

  // ── Pipeline execution ──────────────────────────────────────────
  // pipelex run <target> [--pipe code] [--inputs file] [--output-dir dir]
  // Local, blocking, in-process — there is no durable run to poll by id, so
  // `startAndWaitForResult` runs through here and the granular durable
  // primitives (start/getRun/getResult/waitForResult) are unsupported.

  private async executeLocal(request: ExecuteRequest): Promise<PipelineResponse> {
    const tmp = makeTmpDir();
    try {
      const args: string[] = ["run"];

      if (request.mthds_contents?.length) {
        const bundlePath = writeMthdsContents(tmp, request.mthds_contents);
        args.push(bundlePath);
        args.push("-L", tmp);
        if (request.pipe_code) {
          args.push("--pipe", request.pipe_code);
        }
      } else if (request.pipe_code) {
        args.push(request.pipe_code);
      }

      if (request.inputs) {
        const inputsPath = join(tmp, "inputs.json");
        writeFileSync(
          inputsPath,
          JSON.stringify(request.inputs),
          "utf-8"
        );
        args.push("--inputs", inputsPath);
      }

      args.push("--output-dir", tmp);

      await this.execStreaming(args);

      const wmPath = join(tmp, "working_memory.json");
      const raw = existsSync(wmPath)
        ? (JSON.parse(readFileSync(wmPath, "utf-8")) as Record<string, unknown>)
        : {};

      // The CLI output is working memory JSON. Wrap it in PipelineResponse shape.
      return {
        pipeline_run_id: (raw["pipeline_run_id"] as string) ?? "local",
        created_at: new Date().toISOString(),
        pipeline_state: "COMPLETED",
        finished_at: new Date().toISOString(),
        pipe_output: raw["pipe_output"]
          ? (raw["pipe_output"] as PipelineResponse["pipe_output"])
          : null,
        main_stuff_name:
          (raw["main_stuff_name"] as string | undefined) ?? null,
      };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ── Validation ──────────────────────────────────────────────────
  // pipelex validate method <github-url-or-local-path>

  async validate(request: ValidateRequest): Promise<ValidateResponse> {
    const url = request.method_url;
    if (!url) {
      return {
        mthds_contents: request.mthds_contents ?? [],
        pipelex_bundle_blueprint: { domain: "local" },
        success: false,
        message: "method_url is required for pipelex validation",
      };
    }

    try {
      const args = ["validate", "method", url];
      if (request.pipe_code) {
        args.push("--pipe", request.pipe_code);
      }
      await this.execStreaming(args);

      return {
        mthds_contents: request.mthds_contents ?? [],
        pipelex_bundle_blueprint: { domain: "local" },
        success: true,
        message: "Method validated via local CLI",
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Validation failed";
      return {
        mthds_contents: request.mthds_contents ?? [],
        pipelex_bundle_blueprint: { domain: "local" },
        success: false,
        message,
      };
    }
  }

  // ── Run lifecycle ──────────────────────────────────────────────────
  // The local pipelex CLI runs pipelines in-process; there is no durable run
  // to poll by id, so the granular primitives belong to the hosted platform
  // (use --runner api). `startAndWaitForResult` is supported — it runs the CLI
  // blocking and returns the result directly.

  async startAndWaitForResult(
    options: StartRunOptions,
    _pollOptions?: WaitForResultOptions
  ): Promise<RunResult> {
    const response = await this.executeLocal({
      mthds_contents: options.mthds_contents ?? undefined,
      pipe_code: options.pipe_code ?? undefined,
      inputs: options.inputs ?? undefined,
    });
    return {
      pipeline_run_id: response.pipeline_run_id,
      main_stuff: response.main_stuff ?? null,
      graph_spec: response.graph_spec ?? null,
      pipe_output:
        (response.pipe_output as Record<string, unknown> | null | undefined) ?? null,
    };
  }

  async start(_options: StartRunOptions): Promise<RunPublic> {
    throw new Error(RUN_LIFECYCLE_UNSUPPORTED);
  }

  async getRun(_runId: string): Promise<RunRead> {
    throw new Error(RUN_LIFECYCLE_UNSUPPORTED);
  }

  async getResult(
    _runId: string,
    _options?: { signal?: AbortSignal }
  ): Promise<RunResultState> {
    throw new Error(RUN_LIFECYCLE_UNSUPPORTED);
  }
}

const RUN_LIFECYCLE_UNSUPPORTED =
  "Run lifecycle (start/status/result/poll) is not supported by the pipelex CLI runner. Use the API runner instead (--runner api).";
