/**
 * Runner-aware commands — registered at the top level.
 *
 * mthds-agent [--runner <type>] <cmd> [args...]
 *
 * Runner resolution: --runner flag → default runner from config.
 * For pipelex runner: run and validate use passthrough for full CLI compatibility.
 * For all runners: concept, pipe, assemble, inputs, models use the Runner interface.
 */

import { Command } from "commander";
import { readFileSync } from "node:fs";
import { agentError, agentSuccess, AGENT_ERROR_DOMAINS } from "../output.js";
import { createRunner } from "../../runners/registry.js";
import { isPipelexRunner } from "../../cli/commands/utils.js";
import type { RunnerType, AssembleRequest, Runner } from "../../runners/types.js";

function collect(val: string, prev: string[]): string[] {
  return [...prev, val];
}

/** Extract raw args after a command keyword, filtering out global options */
function extractPassthroughArgs(keyword: string): string[] {
  const argv = process.argv;
  const idx = argv.indexOf(keyword);
  if (idx === -1) return [];
  const raw = argv.slice(idx + 1);
  const result: string[] = [];
  let i = 0;
  while (i < raw.length) {
    if (
      raw[i] === "--runner" ||
      raw[i] === "-L" ||
      raw[i] === "--library-dir" ||
      raw[i] === "--log-level"
    ) {
      i += 2;
    } else if (
      raw[i]!.startsWith("--runner=") ||
      raw[i]!.startsWith("--library-dir=") ||
      raw[i]!.startsWith("--log-level=")
    ) {
      i += 1;
    } else if (raw[i] === "--auto-install") {
      i += 1;
    } else {
      result.push(raw[i]!);
      i++;
    }
  }
  return result;
}

/**
 * Register all runner-aware commands directly on the program.
 * Uses --runner flag or default runner from config.
 */
export function registerRunnerCommands(
  program: Command,
  _logLevelArgs: () => string[],
  _autoInstall: () => boolean
): void {
  const getLibraryDirs = () => (program.optsWithGlobals().libraryDir ?? []) as string[];

  function makeRunner(): Runner {
    const runnerType = program.optsWithGlobals().runner as RunnerType | undefined;
    const libraryDirs = getLibraryDirs();
    return createRunner(runnerType, libraryDirs.length ? libraryDirs : undefined);
  }

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
      let runner: Runner;
      try {
        runner = makeRunner();
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }

      let specStr = options.spec;
      if (!specStr && options.specFile) {
        specStr = readFileSync(options.specFile, "utf-8");
      }
      if (!specStr) {
        agentError("--spec or --spec-file is required.", "ArgumentError", {
          error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
        });
      }

      let spec: Record<string, unknown>;
      try {
        spec = JSON.parse(specStr) as Record<string, unknown>;
      } catch {
        agentError("--spec must be valid JSON.", "ArgumentError", {
          error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
        });
      }

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
    .option("--type <type>", "Pipe type (PipeLLM, PipeSequence, etc.)")
    .option("--spec <json>", "JSON string with pipe specification")
    .option("--spec-file <path>", "Path to JSON file with pipe specification")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (options: { type?: string; spec?: string; specFile?: string }) => {
      let runner: Runner;
      try {
        runner = makeRunner();
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }

      if (!options.type) {
        agentError("--type is required.", "ArgumentError", {
          error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
        });
      }

      let specStr = options.spec;
      if (!specStr && options.specFile) {
        specStr = readFileSync(options.specFile, "utf-8");
      }
      if (!specStr) {
        agentError("--spec or --spec-file is required.", "ArgumentError", {
          error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
        });
      }

      let spec: Record<string, unknown>;
      try {
        spec = JSON.parse(specStr) as Record<string, unknown>;
      } catch {
        agentError("--spec must be valid JSON.", "ArgumentError", {
          error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
        });
      }

      try {
        const result = await runner.pipeSpec({ pipe_type: options.type, spec });
        agentSuccess({ ...result });
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }
    });

  // ── assemble ──

  program
    .command("assemble")
    .description("Assemble a complete .mthds bundle from TOML parts")
    .requiredOption("--domain <domain>", "Domain code for the bundle")
    .requiredOption("--main-pipe <pipe>", "Main pipe code for the bundle")
    .option("--description <desc>", "Description of the bundle")
    .option("--system-prompt <prompt>", "Default system prompt for LLM pipes")
    .option("--concepts <toml>", "TOML for concepts (repeatable)", collect, [] as string[])
    .option("--pipes <toml>", "TOML for pipes (repeatable)", collect, [] as string[])
    .option("-o, --output <file>", "Path to write assembled .mthds file")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (options: {
      domain: string;
      mainPipe: string;
      description?: string;
      systemPrompt?: string;
      concepts?: string[];
      pipes?: string[];
      output?: string;
    }) => {
      let runner: Runner;
      try {
        runner = makeRunner();
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }

      // Read file contents for concepts/pipes so both runners get TOML content
      let concepts: string[] | undefined;
      if (options.concepts?.length) {
        concepts = options.concepts.map((c) => {
          try {
            return readFileSync(c, "utf-8");
          } catch {
            return c; // treat as inline TOML if not a readable file
          }
        });
      }
      let pipes: string[] | undefined;
      if (options.pipes?.length) {
        pipes = options.pipes.map((p) => {
          try {
            return readFileSync(p, "utf-8");
          } catch {
            return p; // treat as inline TOML if not a readable file
          }
        });
      }

      const request: AssembleRequest = {
        domain: options.domain,
        main_pipe: options.mainPipe,
        description: options.description,
        system_prompt: options.systemPrompt,
        concepts,
        pipes,
      };

      try {
        const result = await runner.assemble(request);
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
    .option("--content <mthds>", "Bundle content as a string (alternative to file path)")
    .description("Validate a bundle file or content")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (target: string | undefined, options: { pipe?: string; content?: string }) => {
      let runner: Runner;
      try {
        runner = makeRunner();
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }

      // Passthrough for pipelex runner (forwards all CLI flags like --graph)
      if (isPipelexRunner(runner)) {
        try {
          await runner.validatePassthrough(extractPassthroughArgs("validate"));
        } catch (err) {
          agentError((err as Error).message, "ValidationError", {
            error_domain: AGENT_ERROR_DOMAINS.VALIDATION,
          });
        }
        return;
      }

      let mthdsContent: string;
      if (options.content) {
        mthdsContent = options.content;
      } else if (target) {
        try {
          mthdsContent = readFileSync(target, "utf-8");
        } catch (err) {
          agentError(`Cannot read bundle: ${(err as Error).message}`, "IOError", {
            error_domain: AGENT_ERROR_DOMAINS.IO,
          });
        }
      } else {
        agentError("Either <target> or --content is required.", "ArgumentError", {
          error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
        });
      }

      try {
        const result = await runner.validate({
          mthds_contents: [mthdsContent],
          pipe_code: options.pipe,
        });
        agentSuccess({ ...result });
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
    .option("--bundle <file>", "Bundle file path (alternative to positional)")
    .description("Validate a pipe by code or bundle file")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (target: string, options: { pipe?: string; bundle?: string }) => {
      let runner: Runner;
      try {
        runner = makeRunner();
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }

      // Passthrough for pipelex runner
      if (isPipelexRunner(runner)) {
        try {
          await runner.validatePassthrough(extractPassthroughArgs("validate"));
        } catch (err) {
          agentError((err as Error).message, "ValidationError", {
            error_domain: AGENT_ERROR_DOMAINS.VALIDATION,
          });
        }
        return;
      }

      if (target.endsWith(".mthds")) {
        let mthdsContent: string;
        try {
          mthdsContent = readFileSync(target, "utf-8");
        } catch (err) {
          agentError(`Cannot read bundle: ${(err as Error).message}`, "IOError", {
            error_domain: AGENT_ERROR_DOMAINS.IO,
          });
        }
        try {
          const result = await runner.validate({
            mthds_contents: [mthdsContent],
            pipe_code: options.pipe,
          });
          agentSuccess({ ...result });
        } catch (err) {
          agentError((err as Error).message, "RunnerError", {
            error_domain: AGENT_ERROR_DOMAINS.RUNNER,
          });
        }
      } else {
        try {
          const result = await runner.validate({ pipe_code: target });
          agentSuccess({ ...result });
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
      let runner: Runner;
      try {
        runner = makeRunner();
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }

      // Passthrough for pipelex runner
      if (isPipelexRunner(runner)) {
        try {
          await runner.validatePassthrough(extractPassthroughArgs("validate"));
        } catch (err) {
          agentError((err as Error).message, "ValidationError", {
            error_domain: AGENT_ERROR_DOMAINS.VALIDATION,
          });
        }
        return;
      }

      try {
        const result = await runner.validate({
          method_url: target,
          pipe_code: options.pipe,
        });
        agentSuccess({ ...result });
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
    .option("--content <mthds>", "Bundle content as a string (alternative to file path)")
    .description("Generate inputs from a bundle file or content")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (target: string | undefined, options: { pipe?: string; content?: string }) => {
      let runner: Runner;
      try {
        runner = makeRunner();
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }

      let mthdsContent: string;
      if (options.content) {
        mthdsContent = options.content;
      } else if (target) {
        try {
          mthdsContent = readFileSync(target, "utf-8");
        } catch (err) {
          agentError(`Cannot read bundle: ${(err as Error).message}`, "IOError", {
            error_domain: AGENT_ERROR_DOMAINS.IO,
          });
        }
      } else {
        agentError("Either <target> or --content is required.", "ArgumentError", {
          error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
        });
      }

      let pipeCode = options.pipe;
      if (!pipeCode) {
        const match = mthdsContent.match(/^main_pipe\s*=\s*"([^"]+)"/m);
        if (match) pipeCode = match[1];
      }
      if (!pipeCode) {
        agentError("Could not determine pipe code. Use --pipe to specify it.", "ArgumentError", {
          error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
        });
      }

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
      let runner: Runner;
      try {
        runner = makeRunner();
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }

      if (target.endsWith(".mthds")) {
        let mthdsContent: string;
        try {
          mthdsContent = readFileSync(target, "utf-8");
        } catch (err) {
          agentError(`Cannot read bundle: ${(err as Error).message}`, "IOError", {
            error_domain: AGENT_ERROR_DOMAINS.IO,
          });
        }

        let pipeCode = options.pipe;
        if (!pipeCode) {
          const match = mthdsContent.match(/^main_pipe\s*=\s*"([^"]+)"/m);
          if (match) pipeCode = match[1];
        }
        if (!pipeCode) {
          agentError("Could not determine pipe code. Use --pipe to specify it.", "ArgumentError", {
            error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
          });
        }

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
        "'inputs method' is not yet supported via the runner interface.",
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
      let runner: Runner;
      try {
        runner = makeRunner();
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }

      // Passthrough for pipelex runner
      if (isPipelexRunner(runner)) {
        try {
          await runner.runPassthrough(extractPassthroughArgs("run"));
        } catch (err) {
          agentError((err as Error).message, "RunError", {
            error_domain: AGENT_ERROR_DOMAINS.RUNNER,
          });
        }
        return;
      }

      agentError(
        "Method target is not yet supported for the API runner. Use 'mthds-agent run pipe <target>' instead, or specify a different runner with --runner <name>.",
        "ArgumentError",
        { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT }
      );
    });

  // run pipe [target] [--pipe <code>] [-i <inputs>] [--content <mthds>] [--inputs-json <json>]
  runGroup
    .command("pipe")
    .argument("[target]", "Bundle file (.mthds) or directory")
    .option("--pipe <code>", "Pipe code to run")
    .option("-i, --inputs <file>", "Path to JSON inputs file")
    .option("--content <mthds>", "Bundle content as a string (alternative to file path)")
    .option("--inputs-json <json>", "Inputs as a JSON string (alternative to inputs file)")
    .option("--dry-run", "Validate without executing")
    .option("--mock-inputs", "Use mock inputs for dry run")
    .description("Run a pipe from a bundle file, directory, or content")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (target: string | undefined, options: {
      pipe?: string;
      inputs?: string;
      content?: string;
      inputsJson?: string;
      dryRun?: boolean;
      mockInputs?: boolean;
    }) => {
      let runner: Runner;
      try {
        runner = makeRunner();
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }

      // Passthrough for pipelex runner (forwards all CLI flags like --dry-run, --output-dir, etc.)
      if (isPipelexRunner(runner)) {
        try {
          await runner.runPassthrough(extractPassthroughArgs("run"));
        } catch (err) {
          agentError((err as Error).message, "RunError", {
            error_domain: AGENT_ERROR_DOMAINS.RUNNER,
          });
        }
        return;
      }

      // API runner: use Runner interface
      let mthdsContent: string;
      if (options.content) {
        mthdsContent = options.content;
      } else if (target) {
        // Resolve target: if directory, look for bundle.mthds inside
        let bundlePath = target;
        const { existsSync, statSync } = await import("node:fs");
        const { join } = await import("node:path");
        if (existsSync(target) && statSync(target).isDirectory()) {
          const candidate = join(target, "bundle.mthds");
          if (existsSync(candidate)) {
            bundlePath = candidate;
          } else {
            agentError(`No bundle.mthds found in directory: ${target}`, "IOError", {
              error_domain: AGENT_ERROR_DOMAINS.IO,
            });
          }
          // Also check for inputs.json in directory if not specified
          if (!options.inputs && !options.inputsJson) {
            const inputsCandidate = join(target, "inputs.json");
            if (existsSync(inputsCandidate)) {
              options.inputs = inputsCandidate;
            }
          }
        }
        try {
          mthdsContent = readFileSync(bundlePath, "utf-8");
        } catch (err) {
          agentError(`Cannot read bundle: ${(err as Error).message}`, "IOError", {
            error_domain: AGENT_ERROR_DOMAINS.IO,
          });
        }
      } else {
        agentError("Either <target> or --content is required.", "ArgumentError", {
          error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
        });
      }

      let pipeCode = options.pipe;
      if (!pipeCode) {
        const match = mthdsContent.match(/^main_pipe\s*=\s*"([^"]+)"/m);
        if (match) pipeCode = match[1];
      }

      let inputs: Record<string, unknown> | undefined;
      if (options.inputsJson) {
        try {
          inputs = JSON.parse(options.inputsJson) as Record<string, unknown>;
        } catch {
          agentError("--inputs-json must be valid JSON.", "ArgumentError", {
            error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
          });
        }
      } else if (options.inputs) {
        try {
          inputs = JSON.parse(readFileSync(options.inputs, "utf-8")) as Record<string, unknown>;
        } catch (err) {
          agentError(`Cannot read inputs: ${(err as Error).message}`, "IOError", {
            error_domain: AGENT_ERROR_DOMAINS.IO,
          });
        }
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
    });

  // run bundle [target] (alias for run pipe)
  runGroup
    .command("bundle")
    .argument("[target]", "Bundle file (.mthds) or directory")
    .option("--pipe <code>", "Pipe code to run")
    .option("-i, --inputs <file>", "Path to JSON inputs file")
    .option("--content <mthds>", "Bundle content as a string (alternative to file path)")
    .option("--inputs-json <json>", "Inputs as a JSON string (alternative to inputs file)")
    .description("Run a bundle file or content")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (target: string | undefined, options: { pipe?: string; inputs?: string; content?: string; inputsJson?: string }) => {
      let runner: Runner;
      try {
        runner = makeRunner();
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }

      // Passthrough for pipelex runner
      if (isPipelexRunner(runner)) {
        try {
          await runner.runPassthrough(extractPassthroughArgs("run"));
        } catch (err) {
          agentError((err as Error).message, "RunError", {
            error_domain: AGENT_ERROR_DOMAINS.RUNNER,
          });
        }
        return;
      }

      // API runner: use Runner interface
      let mthdsContent: string;
      if (options.content) {
        mthdsContent = options.content;
      } else if (target) {
        try {
          mthdsContent = readFileSync(target, "utf-8");
        } catch (err) {
          agentError(`Cannot read bundle: ${(err as Error).message}`, "IOError", {
            error_domain: AGENT_ERROR_DOMAINS.IO,
          });
        }
      } else {
        agentError("Either <target> or --content is required.", "ArgumentError", {
          error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
        });
      }

      let pipeCode = options.pipe;
      if (!pipeCode) {
        const match = mthdsContent.match(/^main_pipe\s*=\s*"([^"]+)"/m);
        if (match) pipeCode = match[1];
      }

      let inputs: Record<string, unknown> | undefined;
      if (options.inputsJson) {
        try {
          inputs = JSON.parse(options.inputsJson) as Record<string, unknown>;
        } catch {
          agentError("--inputs-json must be valid JSON.", "ArgumentError", {
            error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
          });
        }
      } else if (options.inputs) {
        try {
          inputs = JSON.parse(readFileSync(options.inputs, "utf-8")) as Record<string, unknown>;
        } catch (err) {
          agentError(`Cannot read inputs: ${(err as Error).message}`, "IOError", {
            error_domain: AGENT_ERROR_DOMAINS.IO,
          });
        }
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
    });

  // ── models ──

  program
    .command("models")
    .description("List available model presets, aliases, and talent mappings")
    .option("--type <type>", "Filter by model category (repeatable): llm, extract, img_gen, search", collect, [] as string[])
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (options: { type?: string[] }) => {
      let runner: Runner;
      try {
        runner = makeRunner();
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }

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
}
