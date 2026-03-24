/**
 * API runner commands — registered only when --runner=api.
 *
 * Each command parses CLI args, builds request objects, calls the Runner
 * interface, and wraps results with agentSuccess(). No passthrough logic.
 */

import { Command } from "commander";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { agentError, agentSuccess, AGENT_ERROR_DOMAINS } from "../output.js";
import type { Runner } from "../../runners/types.js";

function collect(val: string, prev: string[]): string[] {
  return [...prev, val];
}

/**
 * Register all API-runner commands on the program.
 * Only called when --runner=api.
 */
export function registerApiRunnerCommands(
  program: Command,
  makeRunner: () => Runner
): void {

  // ── concept ──

  program
    .command("concept")
    .description("Structure a concept from JSON spec and output TOML")
    .option("--spec <json>", "JSON string with concept specification")
    .option("--spec-file <path>", "Path to JSON file with concept specification")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (options: { spec?: string; specFile?: string }) => {
      const runner = safeCreateRunner(makeRunner);

      let specStr = options.spec;
      if (!specStr && options.specFile) {
        try {
          specStr = readFileSync(options.specFile, "utf-8");
        } catch (err) {
          agentError(`Cannot read spec file: ${(err as Error).message}`, "IOError", {
            error_domain: AGENT_ERROR_DOMAINS.IO,
          });
        }
      }
      if (!specStr) {
        agentError("--spec or --spec-file is required.", "ArgumentError", {
          error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
        });
      }

      const spec = parseJsonOrError(specStr, "--spec");
      try {
        const result = await runner.concept({ spec });
        agentSuccess({ ...result });
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }
    });

  // ── pipe ──

  program
    .command("pipe")
    .description("Structure a pipe from JSON spec and output TOML")
    .option("--spec <json>", "JSON string with pipe specification")
    .option("--spec-file <path>", "Path to JSON file with pipe specification")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (options: { spec?: string; specFile?: string }) => {
      const runner = safeCreateRunner(makeRunner);

      let specStr = options.spec;
      if (!specStr && options.specFile) {
        try {
          specStr = readFileSync(options.specFile, "utf-8");
        } catch (err) {
          agentError(`Cannot read spec file: ${(err as Error).message}`, "IOError", {
            error_domain: AGENT_ERROR_DOMAINS.IO,
          });
        }
      }
      if (!specStr) {
        agentError("--spec or --spec-file is required.", "ArgumentError", {
          error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
        });
      }

      const spec = parseJsonOrError(specStr, "--spec");
      const pipeType = (spec as Record<string, unknown>).type as string | undefined;
      if (!pipeType) {
        agentError("'type' field is required in the spec JSON.", "ArgumentError", {
          error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
        });
      }

      try {
        const result = await runner.pipeSpec({ pipe_type: pipeType, spec });
        agentSuccess({ ...result });
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }
    });

  // ── validate ──

  const validateGroup = program
    .command("validate")
    .description("Validate a method, pipe, or bundle")
    .passThroughOptions()
    .allowUnknownOption();

  validateGroup
    .command("bundle")
    .argument("[target]", "Bundle file (.mthds) or directory")
    .option("--pipe <code>", "Pipe code to validate within the bundle")
    .option("--content <mthds>", "Bundle content as a string")
    .description("Validate a bundle file or content")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (target: string | undefined, options: { pipe?: string; content?: string }) => {
      const runner = safeCreateRunner(makeRunner);
      const mthdsContent = resolveContent(target, options.content);
      try {
        const result = await runner.validate({
          mthds_contents: [mthdsContent],
          pipe_code: options.pipe,
        });
        if (result.success) {
          agentSuccess({ ...result });
        } else {
          agentError(result.message, "ValidationError", {
            error_domain: AGENT_ERROR_DOMAINS.VALIDATION,
          });
        }
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }
    });

  validateGroup
    .command("pipe")
    .argument("<target>", "Pipe code or .mthds bundle file")
    .option("--pipe <code>", "Pipe code to validate")
    .description("Validate a pipe by code or bundle file")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (target: string, options: { pipe?: string }) => {
      const runner = safeCreateRunner(makeRunner);
      if (target.endsWith(".mthds")) {
        const mthdsContent = readFileOrError(target);
        try {
          const result = await runner.validate({
            mthds_contents: [mthdsContent],
            pipe_code: options.pipe,
          });
          handleValidateResult(result);
        } catch (err) {
          agentError((err as Error).message, "RunnerError", {
            error_domain: AGENT_ERROR_DOMAINS.RUNNER,
          });
        }
      } else {
        try {
          const result = await runner.validate({ pipe_code: target });
          handleValidateResult(result);
        } catch (err) {
          agentError((err as Error).message, "RunnerError", {
            error_domain: AGENT_ERROR_DOMAINS.RUNNER,
          });
        }
      }
    });

  validateGroup
    .command("method")
    .argument("<target>", "Method name, GitHub URL, or local path")
    .option("--pipe <code>", "Pipe code to validate")
    .description("Validate a method")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (target: string, options: { pipe?: string }) => {
      const runner = safeCreateRunner(makeRunner);
      try {
        const result = await runner.validate({
          method_url: target,
          pipe_code: options.pipe,
        });
        handleValidateResult(result);
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }
    });

  // ── inputs ──

  const inputsGroup = program
    .command("inputs")
    .description("Generate example input JSON for a pipe")
    .passThroughOptions()
    .allowUnknownOption();

  inputsGroup
    .command("bundle")
    .argument("[target]", "Bundle file (.mthds) or directory")
    .option("--pipe <code>", "Pipe code to generate inputs for")
    .option("--content <mthds>", "Bundle content as a string")
    .description("Generate inputs from a bundle file or content")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (target: string | undefined, options: { pipe?: string; content?: string }) => {
      const runner = safeCreateRunner(makeRunner);
      const mthdsContent = resolveContent(target, options.content);
      const pipeCode = resolvePipeCode(mthdsContent, options.pipe);
      try {
        const result = await runner.buildInputs({
          mthds_contents: [mthdsContent],
          pipe_code: pipeCode,
        });
        agentSuccess({ success: true, pipe_code: pipeCode, inputs: result });
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }
    });

  inputsGroup
    .command("pipe")
    .argument("<target>", "Bundle file (.mthds) or pipe code")
    .option("--pipe <code>", "Pipe code to generate inputs for")
    .description("Generate inputs for a pipe")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (target: string, options: { pipe?: string }) => {
      const runner = safeCreateRunner(makeRunner);
      if (target.endsWith(".mthds")) {
        const mthdsContent = readFileOrError(target);
        const pipeCode = resolvePipeCode(mthdsContent, options.pipe);
        try {
          const result = await runner.buildInputs({
            mthds_contents: [mthdsContent],
            pipe_code: pipeCode,
          });
          agentSuccess({ success: true, pipe_code: pipeCode, inputs: result });
        } catch (err) {
          agentError((err as Error).message, "RunnerError", {
            error_domain: AGENT_ERROR_DOMAINS.RUNNER,
          });
        }
      } else {
        agentError(
          "Pipe code without a bundle file is not supported yet. Provide a .mthds file.",
          "ArgumentError",
          { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT }
        );
      }
    });

  inputsGroup
    .command("method")
    .argument("<name>", "Method name")
    .option("--pipe <code>", "Pipe code to generate inputs for")
    .description("Generate inputs for an installed method")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async () => {
      agentError(
        "'inputs method' is not yet supported via the API runner.",
        "UnsupportedError",
        { error_domain: AGENT_ERROR_DOMAINS.RUNNER }
      );
    });

  // ── run ──

  const runGroup = program
    .command("run")
    .description("Execute a pipeline")
    .passThroughOptions()
    .allowUnknownOption();

  runGroup
    .command("method")
    .argument("<name>", "Name of the installed method")
    .option("--pipe <code>", "Pipe code (overrides method's main_pipe)")
    .option("-i, --inputs <file>", "Path to JSON inputs file")
    .description("Run an installed method by name")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async () => {
      agentError(
        "'run method' is not yet supported via the API runner.",
        "UnsupportedError",
        { error_domain: AGENT_ERROR_DOMAINS.RUNNER }
      );
    });

  const runAction = async (
    target: string | undefined,
    options: { pipe?: string; inputs?: string; content?: string; inputsJson?: string }
  ): Promise<void> => {
    const runner = safeCreateRunner(makeRunner);
    const mthdsContent = resolveContentForRun(target, options);
    const pipeCode = resolvePipeCode(mthdsContent, options.pipe);

    let inputs: Record<string, unknown> | undefined;
    if (options.inputsJson) {
      inputs = parseJsonOrError(options.inputsJson, "--inputs-json");
    } else if (options.inputs) {
      const raw = readFileOrError(options.inputs);
      inputs = parseJsonOrError(raw, "inputs file");
    }

    try {
      const result = await runner.execute({
        mthds_contents: [mthdsContent],
        pipe_code: pipeCode,
        inputs,
      });
      agentSuccess({ ...result });
    } catch (err) {
      agentError((err as Error).message, "RunnerError", {
        error_domain: AGENT_ERROR_DOMAINS.RUNNER,
      });
    }
  };

  runGroup
    .command("pipe")
    .argument("[target]", "Bundle file (.mthds) or directory")
    .option("--pipe <code>", "Pipe code to run")
    .option("-i, --inputs <file>", "Path to JSON inputs file")
    .option("--content <mthds>", "Bundle content as a string")
    .option("--inputs-json <json>", "Inputs as a JSON string")
    .option("--dry-run", "Validate without executing")
    .option("--mock-inputs", "Use mock inputs for dry run")
    .description("Run a pipe from a bundle file, directory, or content")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(runAction);

  runGroup
    .command("bundle")
    .argument("[target]", "Bundle file (.mthds) or directory")
    .option("--pipe <code>", "Pipe code to run")
    .option("-i, --inputs <file>", "Path to JSON inputs file")
    .option("--content <mthds>", "Bundle content as a string")
    .option("--inputs-json <json>", "Inputs as a JSON string")
    .description("Run a bundle file or content")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(runAction);

  // ── models ──

  program
    .command("models")
    .description("List available model presets, aliases, and waterfalls")
    .option("--type <type>", "Filter by model category (repeatable)", collect, [] as string[])
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (options: { type?: string[] }) => {
      const runner = safeCreateRunner(makeRunner);
      try {
        const request = options.type?.length ? { type: options.type } : undefined;
        const result = await runner.models(request);
        agentSuccess({ ...result });
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }
    });

  // ── check-model ──

  program
    .command("check-model")
    .description("Validate a model reference with fuzzy suggestions")
    .argument("<reference>", "Model reference to check")
    .option("--type <type>", "Model category (llm, extract, img_gen, search)")
    .option("--format <format>", "Output format (markdown, json)")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (reference: string, options: { type?: string; format?: string }) => {
      const runner = safeCreateRunner(makeRunner);
      try {
        const result = await runner.checkModel({ reference, type: options.type, format: options.format });
        agentSuccess({ ...result });
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }
    });
}

// ── Helpers ──

function safeCreateRunner(makeRunner: () => Runner): Runner {
  try {
    return makeRunner();
  } catch (err) {
    agentError((err as Error).message, "RunnerError", {
      error_domain: AGENT_ERROR_DOMAINS.RUNNER,
    });
    throw err; // unreachable, agentError exits
  }
}

function parseJsonOrError(raw: string, label: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    agentError(`${label} must be valid JSON.`, "ArgumentError", {
      error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
    });
    throw new Error("unreachable");
  }
}

function readFileOrError(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    agentError(`Cannot read file: ${(err as Error).message}`, "IOError", {
      error_domain: AGENT_ERROR_DOMAINS.IO,
    });
    throw err;
  }
}

function resolveContent(target: string | undefined, content: string | undefined): string {
  if (content) return content;
  if (target) return readFileOrError(target);
  agentError("Either <target> or --content is required.", "ArgumentError", {
    error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
  });
  throw new Error("unreachable");
}

function resolveContentForRun(
  target: string | undefined,
  options: { content?: string; inputs?: string; inputsJson?: string }
): string {
  if (options.content) return options.content;
  if (!target) {
    agentError("Either <target> or --content is required.", "ArgumentError", {
      error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
    });
  }
  let bundlePath = target;
  if (existsSync(target) && statSync(target).isDirectory()) {
    const candidate = join(target, "bundle.mthds");
    if (existsSync(candidate)) {
      bundlePath = candidate;
    } else {
      agentError(`No bundle.mthds found in directory: ${target}`, "IOError", {
        error_domain: AGENT_ERROR_DOMAINS.IO,
      });
    }
    if (!options.inputs && !options.inputsJson) {
      const inputsCandidate = join(target, "inputs.json");
      if (existsSync(inputsCandidate)) {
        options.inputs = inputsCandidate;
      }
    }
  }
  return readFileOrError(bundlePath);
}

function resolvePipeCode(mthdsContent: string, pipeCodeOption: string | undefined): string {
  if (pipeCodeOption) return pipeCodeOption;
  const match = mthdsContent.match(/^main_pipe\s*=\s*"([^"]+)"/m);
  if (match?.[1]) return match[1];
  agentError("Could not determine pipe code. Use --pipe to specify it.", "ArgumentError", {
    error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
  });
  throw new Error("unreachable");
}

function handleValidateResult(result: { success: boolean; message: string }): void {
  if (result.success) {
    agentSuccess({ ...result });
  } else {
    agentError(result.message, "ValidationError", {
      error_domain: AGENT_ERROR_DOMAINS.VALIDATION,
    });
  }
}
