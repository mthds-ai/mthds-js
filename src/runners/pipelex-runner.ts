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
import { homedir, tmpdir } from "node:os";
import { Runners } from "./types.js";
import type {
  Runner,
  RunnerType,
  BuildInputsRequest,
  BuildOutputRequest,
  BuildPipeRequest,
  BuildPipeResponse,
  BuildRunnerRequest,
  BuildRunnerResponse,
  DictPipeOutput,
  ExecuteRequest,
  GenerateMermaidRequest,
  GenerateMermaidResponse,
  PipelineResponse,
  ValidateRequest,
  ValidateResponse,
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
 * Return the default methods directory (~/.mthds/methods).
 */
function getMethodsDir(): string {
  return join(homedir(), ".mthds", "methods");
}

/**
 * Ensure the output directory exists and return the pipelex `-o` base path.
 * Pipelex treats `-o <path>` as a base name and creates `<path>_NN/`,
 * so we pass `<dir>/bundle` to get output inside `<dir>/`.
 */
function resolveOutputBase(output: string | undefined): string {
  const dir = output ?? getMethodsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, "bundle");
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
      await this.exec(["show", "config"]);
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

  // pipelex build inputs <bundle.mthds> --pipe <pipe_code>
  async buildInputs(request: BuildInputsRequest): Promise<unknown> {
    const tmp = makeTmpDir();
    try {
      const bundlePath = join(tmp, "bundle.mthds");
      writeFileSync(bundlePath, request.mthds_content, "utf-8");

      const { stdout } = await this.exec([
        "build",
        "inputs",
        bundlePath,
        "--pipe",
        request.pipe_code,
      ]);

      return JSON.parse(stdout) as unknown;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // pipelex build output <bundle.mthds> --pipe <pipe_code> [--format <fmt>]
  async buildOutput(request: BuildOutputRequest): Promise<unknown> {
    const tmp = makeTmpDir();
    try {
      const bundlePath = join(tmp, "bundle.mthds");
      writeFileSync(bundlePath, request.mthds_content, "utf-8");

      const args = [
        "build",
        "output",
        bundlePath,
        "--pipe",
        request.pipe_code,
      ];
      if (request.format) {
        args.push("--format", request.format);
      }

      const { stdout } = await this.exec(args);

      return JSON.parse(stdout) as unknown;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // pipelex build pipe "PROMPT" -o <dir>
  async buildPipe(request: BuildPipeRequest): Promise<BuildPipeResponse> {
    const outputDir = resolveOutputBase(request.output);
    await this.execStreaming([
      "build",
      "pipe",
      request.brief,
      "-o",
      outputDir,
    ]);
    return {
      mthds_content: "",
      pipelex_bundle_blueprint: {},
      success: true,
      message: `Pipeline built successfully — saved to ${outputDir}`,
    };
  }

  // pipelex build runner <bundle.mthds> --pipe <pipe_code> -o <file>
  async buildRunner(
    request: BuildRunnerRequest
  ): Promise<BuildRunnerResponse> {
    const tmp = makeTmpDir();
    try {
      const bundlePath = join(tmp, "bundle.mthds");
      writeFileSync(bundlePath, request.mthds_content, "utf-8");

      const outPath = join(tmp, "runner.py");
      await this.execStreaming([
        "build",
        "runner",
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

  // ── Pipeline execution ──────────────────────────────────────────
  // pipelex run <target> [--pipe code] [--inputs file] [--output-dir dir]

  async execute(request: ExecuteRequest): Promise<PipelineResponse> {
    const tmp = makeTmpDir();
    try {
      const args: string[] = ["run"];

      if (request.mthds_content) {
        const bundlePath = join(tmp, "bundle.mthds");
        writeFileSync(bundlePath, request.mthds_content, "utf-8");
        args.push(bundlePath);
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
        mthds_content: request.mthds_content ?? "",
        pipelex_bundle_blueprint: { domain: "local" },
        success: false,
        message: "method_url is required for pipelex validation",
      };
    }

    try {
      await this.execStreaming(["validate", "method", url]);

      return {
        mthds_content: request.mthds_content ?? "",
        pipelex_bundle_blueprint: { domain: "local" },
        success: true,
        message: "Method validated via local CLI",
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Validation failed";
      return {
        mthds_content: request.mthds_content ?? "",
        pipelex_bundle_blueprint: { domain: "local" },
        success: false,
        message,
      };
    }
  }

  // ── Mermaid diagram generation ─────────────────────────────────────
  // pipelex mermaid method <github-url-or-local-path> --pipe <pipe_code>

  async generateMermaid(request: GenerateMermaidRequest): Promise<GenerateMermaidResponse> {
    const url = request.method_url;
    if (!url) {
      return {
        mermaid_code: "",
        pipe_code: request.pipe_code,
        success: false,
        message: "method_url is required for pipelex mermaid generation",
      };
    }

    try {
      const { stdout } = await this.exec([
        "mermaid",
        "method",
        url,
        "--pipe",
        request.pipe_code,
      ]);

      return {
        mermaid_code: stdout.trim(),
        pipe_code: request.pipe_code,
        success: true,
        message: "Mermaid diagram generated via local CLI",
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Mermaid generation failed";
      return {
        mermaid_code: "",
        pipe_code: request.pipe_code,
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
      mthds_content: options.mthds_content ?? undefined,
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
