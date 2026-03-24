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
  DictPipeOutput,
  ExecuteRequest,
  PipelineResponse,
  ValidateRequest,
  ValidateResponse,
  ConceptRequest,
  ConceptResponse,
  PipeSpecRequest,
  PipeSpecResponse,
  AssembleRequest,
  AssembleResponse,
  ModelsRequest,
  ModelsResponse,
} from "./types.js";
import type {
  ExecutePipelineOptions,
  PipelineExecuteResponse,
  PipelineStartResponse,
} from "../client/pipeline.js";

const execFileAsync = promisify(execFile);

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mthds-"));
}

/**
 * Write an array of .mthds file contents to a temp directory.
 * Returns the path to the first file (the main bundle).
 */
function writeMthdsContents(tmp: string, contents: string[]): string {
  const bundlePath = join(tmp, "bundle.mthds");
  writeFileSync(bundlePath, contents[0]!, "utf-8");
  for (let i = 1; i < contents.length; i++) {
    writeFileSync(join(tmp, `extra_${i}.mthds`), contents[i]!, "utf-8");
  }
  return bundlePath;
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

  // pipelex build output bundle <bundle.mthds> --pipe <pipe_code> [--format <fmt>]
  async buildOutput(request: BuildOutputRequest): Promise<unknown> {
    const tmp = makeTmpDir();
    try {
      const bundlePath = writeMthdsContents(tmp, request.mthds_contents);

      const args = [
        "build",
        "output",
        "bundle",
        bundlePath,
        "--pipe",
        request.pipe_code,
        "-L",
        tmp,
      ];
      if (request.format) {
        args.push("--format", request.format);
      }
      args.push(...this.libraryArgs());

      const { stdout } = await execFileAsync("pipelex", args, {
        encoding: "utf-8",
      });

      return JSON.parse(stdout) as unknown;
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
    return JSON.parse(stdout) as ConceptResponse;
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
    return JSON.parse(stdout) as PipeSpecResponse;
  }

  // pipelex-agent assemble --domain <d> --main-pipe <p> [--concepts <c>...] [--pipes <p>...]
  async assemble(request: AssembleRequest): Promise<AssembleResponse> {
    const tmp = makeTmpDir();
    try {
      const args = [
        "assemble",
        "--domain",
        request.domain,
        "--main-pipe",
        request.main_pipe,
      ];
      if (request.description) {
        args.push("--description", request.description);
      }
      if (request.system_prompt) {
        args.push("--system-prompt", request.system_prompt);
      }
      if (request.concepts) {
        for (let i = 0; i < request.concepts.length; i++) {
          const filePath = join(tmp, `concept_${i}.toml`);
          writeFileSync(filePath, request.concepts[i]!, "utf-8");
          args.push("--concepts", filePath);
        }
      }
      if (request.pipes) {
        for (let i = 0; i < request.pipes.length; i++) {
          const filePath = join(tmp, `pipe_${i}.toml`);
          writeFileSync(filePath, request.pipes[i]!, "utf-8");
          args.push("--pipes", filePath);
        }
      }

      const { stdout } = await execFileAsync("pipelex-agent", args, {
        encoding: "utf-8",
      });
      return JSON.parse(stdout) as AssembleResponse;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // pipelex-agent models [--type <type>...]
  async models(request?: ModelsRequest): Promise<ModelsResponse> {
    const args = ["models"];
    if (request?.type) {
      for (const t of request.type) {
        args.push("--type", t);
      }
    }
    const { stdout } = await execFileAsync("pipelex-agent", args, {
      encoding: "utf-8",
    });
    return JSON.parse(stdout) as ModelsResponse;
  }

  // ── Pipeline execution ──────────────────────────────────────────
  // pipelex run <target> [--pipe code] [--inputs file] [--output-dir dir]

  async execute(request: ExecuteRequest): Promise<PipelineResponse> {
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

  // ── RunnerProtocol implementation ─────────────────────────────────

  async executePipeline(
    options: ExecutePipelineOptions
  ): Promise<PipelineExecuteResponse> {
    const request: ExecuteRequest = {
      mthds_contents: options.mthds_contents ?? undefined,
      pipe_code: options.pipe_code ?? undefined,
      inputs: options.inputs
        ? Object.fromEntries(
            Object.entries(options.inputs).map(([k, v]) => [k, v])
          )
        : undefined,
    };
    const response = await this.execute(request);
    return {
      pipeline_run_id: response.pipeline_run_id,
      created_at: response.created_at,
      pipeline_state: response.pipeline_state,
      finished_at: response.finished_at,
      main_stuff_name: response.main_stuff_name,
      pipe_output: response.pipe_output as unknown as DictPipeOutput,
    };
  }

  async startPipeline(
    _options: ExecutePipelineOptions
  ): Promise<PipelineStartResponse> {
    throw new Error(
      "startPipeline is not supported by the pipelex CLI runner. Use the API runner instead."
    );
  }
}
