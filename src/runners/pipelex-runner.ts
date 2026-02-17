import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  writeFileSync,
  readFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  Runner,
  RunnerType,
  BuildInputsRequest,
  BuildOutputRequest,
  BuildPipeRequest,
  BuildPipeResponse,
  BuildRunnerRequest,
  BuildRunnerResponse,
  ExecuteRequest,
  PipelineResponse,
  ValidateRequest,
  ValidateResponse,
} from "./types.js";

const execFileAsync = promisify(execFile);

function notSupported(method: string): never {
  throw new Error(
    `PipelexRunner.${method}() has no CLI equivalent. Use the API runner instead.`
  );
}

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "mthds-"));
}

export class PipelexRunner implements Runner {
  readonly type: RunnerType = "pipelex";

  private async exec(
    args: string[]
  ): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync("pipelex", args, { encoding: "utf-8" });
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

  async buildInputs(_request: BuildInputsRequest): Promise<unknown> {
    notSupported("buildInputs");
  }

  async buildOutput(_request: BuildOutputRequest): Promise<unknown> {
    notSupported("buildOutput");
  }

  // pipelex build pipe "PROMPT" -o <file>
  async buildPipe(request: BuildPipeRequest): Promise<BuildPipeResponse> {
    const tmp = makeTmpDir();
    try {
      const outPath = join(tmp, "bundle.plx");
      await this.exec(["build", "pipe", request.brief, "-o", outPath]);
      const plxContent = readFileSync(outPath, "utf-8");
      return {
        plx_content: plxContent,
        pipelex_bundle_blueprint: {},
        success: true,
        message: "Pipeline generated via local CLI",
      };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  // pipelex build runner <bundle.plx> --pipe <pipe_code> -o <file>
  async buildRunner(
    request: BuildRunnerRequest
  ): Promise<BuildRunnerResponse> {
    const tmp = makeTmpDir();
    try {
      const bundlePath = join(tmp, "bundle.plx");
      writeFileSync(bundlePath, request.plx_content, "utf-8");

      const outPath = join(tmp, "runner.py");
      await this.exec([
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
  // pipelex run <target> [--pipe code] [--inputs file] [--output file]

  async execute(request: ExecuteRequest): Promise<PipelineResponse> {
    const tmp = makeTmpDir();
    try {
      const args: string[] = ["run"];

      if (request.plx_content) {
        const bundlePath = join(tmp, "bundle.plx");
        writeFileSync(bundlePath, request.plx_content, "utf-8");
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

      const outputPath = join(tmp, "output.json");
      args.push("--output", outputPath);

      await this.exec(args);

      const raw = JSON.parse(
        readFileSync(outputPath, "utf-8")
      ) as Record<string, unknown>;

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
  // pipelex validate --bundle <file.plx>

  async validate(request: ValidateRequest): Promise<ValidateResponse> {
    const tmp = makeTmpDir();
    try {
      const bundlePath = join(tmp, "bundle.plx");
      writeFileSync(bundlePath, request.plx_content, "utf-8");

      await this.exec(["validate", "--bundle", bundlePath]);

      return {
        plx_content: request.plx_content,
        pipelex_bundle_blueprint: {
          domain: "local",
        },
        success: true,
        message: "PLX content validated via local CLI",
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Validation failed";
      return {
        plx_content: request.plx_content,
        pipelex_bundle_blueprint: { domain: "local" },
        success: false,
        message,
      };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
