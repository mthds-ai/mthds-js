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
import type { StartOptions } from "../../protocol/options.js";
import type { ModelCategory } from "../../protocol/models.js";
import { MODEL_CATEGORIES } from "../../protocol/models.js";
import { ApiResponseError, RunFailedError, RunTimeoutError } from "../../runners/api/exceptions.js";

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
    .option("--type <type>", "Pipe type (PipeLLM, PipeSequence, etc.)")
    .option("--spec <json>", "JSON string with pipe specification")
    .option("--spec-file <path>", "Path to JSON file with pipe specification")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (options: { type?: string; spec?: string; specFile?: string }) => {
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
      const specObj = spec as Record<string, unknown>;

      // Accept "pipe_type" as alias for "type" in spec JSON (matches Python tolerance)
      if (specObj.pipe_type && !specObj.type) {
        specObj.type = specObj.pipe_type;
      }
      delete specObj.pipe_type;

      // Resolve: CLI --type takes precedence, then spec.type
      const pipeType = options.type ?? (specObj.type as string | undefined);
      if (!pipeType) {
        agentError(
          "Pipe type must be provided either via --type or as 'type' in the spec JSON.",
          "ArgumentError",
          { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT },
        );
      }

      // Clean type fields from spec — API expects pipe_type as a separate field
      delete specObj.type;

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
    .option("--allow-signatures", "Tolerate unimplemented pipe signatures")
    .option("--content <mthds>", "Bundle content as a string")
    .description("Validate a bundle file or content")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (target: string | undefined, options: { allowSignatures?: boolean; content?: string }) => {
      const runner = safeCreateRunner(makeRunner);
      const mthdsContent = resolveContent(target, options.content);
      await runProtocolValidate(runner, [mthdsContent], options.allowSignatures ?? false);
    });

  validateGroup
    .command("pipe")
    .argument("<target>", ".mthds bundle file")
    .option("--allow-signatures", "Tolerate unimplemented pipe signatures")
    .description("Validate a bundle file (protocol validate covers every pipe in it)")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (target: string, options: { allowSignatures?: boolean }) => {
      const runner = safeCreateRunner(makeRunner);
      if (!target.endsWith(".mthds")) {
        agentError(
          "Validating a bare pipe code is not supported via the API runner — the protocol validate takes bundle contents. Pass a .mthds file.",
          "ArgumentError",
          { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT }
        );
        return;
      }
      const mthdsContent = readFileOrError(target);
      await runProtocolValidate(runner, [mthdsContent], options.allowSignatures ?? false);
    });

  validateGroup
    .command("method")
    .argument("<target>", "Method name, GitHub URL, or local path")
    .option("--pipe <code>", "Pipe code to validate")
    .description("Validate a method")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async () => {
      agentError(
        "'validate method' is not supported via the API runner — the protocol validate takes bundle contents, not a method URL. Pass a .mthds file to 'validate bundle', or use --runner pipelex.",
        "UnsupportedError",
        { error_domain: AGENT_ERROR_DOMAINS.RUNNER }
      );
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
    options: { pipe?: string; inputs?: string; content?: string; inputsJson?: string; dryRun?: boolean; mockInputs?: boolean }
  ): Promise<void> => {
    if (options.dryRun || options.mockInputs) {
      agentError(
        "--dry-run and --mock-inputs are not yet supported via the API runner.",
        "UnsupportedError",
        { error_domain: AGENT_ERROR_DOMAINS.RUNNER }
      );
    }
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
      const result = await runner.startAndWaitForResult({
        mthds_contents: [mthdsContent],
        pipe_code: pipeCode,
        inputs,
      });
      agentSuccess({
        state: "completed",
        pipeline_run_id: result.pipeline_run_id,
        main_stuff: result.main_stuff ?? result.pipe_output ?? null,
        graph_spec: result.graph_spec ?? null,
      });
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

  // ── run start ──
  // Submit a run and return its id immediately. All run state lives behind the
  // returned `pipeline_run_id` (DB + Temporal), so an agent can submit here,
  // disconnect, and later resume with `run status` / `run result` / `run poll`.

  runGroup
    .command("start")
    .argument("[target]", "Bundle file (.mthds) or directory")
    .option("--pipe <code>", "Pipe code to run")
    .option("-i, --inputs <file>", "Path to JSON inputs file")
    .option("--content <mthds>", "Bundle content as a string")
    .option("--inputs-json <json>", "Inputs as a JSON string")
    .option("--extra <json>", "Server-specific extension args as a JSON object (e.g. a stored-method run) — forwarded to the runner verbatim")
    .option("--output-name <name>", "Name of the output slot to write to")
    .option("--output-multiplicity <value>", "Output multiplicity: 'false', 'true', or an exact count")
    .option("--dynamic-output <concept_ref>", "Override for the dynamic output concept ref")
    .description("Start a run and return its id without waiting")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(
      async (
        target: string | undefined,
        options: {
          pipe?: string;
          inputs?: string;
          content?: string;
          inputsJson?: string;
          extra?: string;
          outputName?: string;
          outputMultiplicity?: string;
          dynamicOutput?: string;
        }
      ): Promise<void> => {
        const runner = safeCreateRunner(makeRunner);
        const startOptions = resolveStartOptions(target, options);
        try {
          const ack = await runner.start(startOptions);
          agentSuccess({ ...ack });
        } catch (err) {
          agentError((err as Error).message, "RunnerError", {
            error_domain: AGENT_ERROR_DOMAINS.RUNNER,
          });
        }
      }
    );

  // ── run status ──

  runGroup
    .command("status")
    .argument("<pipeline_run_id>", "Run id")
    .description("Fetch a run's current status by id (self-healing)")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (runId: string): Promise<void> => {
      const runner = safeCreateRunner(makeRunner);
      try {
        const run = await runner.getRunStatus(runId);
        agentSuccess({ ...run });
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }
    });

  // ── run result ──
  // Single-shot result lookup: 202 → still running, 200 → result, 409 → failed.

  runGroup
    .command("result")
    .argument("<pipeline_run_id>", "Run id")
    .description("Fetch a run's result by id, once (does not wait)")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (runId: string): Promise<void> => {
      const runner = safeCreateRunner(makeRunner);
      let state;
      try {
        state = await runner.getRunResult(runId);
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
        return;
      }
      switch (state.state) {
        case "running":
          agentSuccess({
            state: "running",
            pipeline_run_id: state.pipeline_run_id,
            retry_after_seconds: state.retry_after_seconds,
            hint: `Run is still in progress. Poll with: mthds-agent run poll ${runId}`,
          });
          break;
        case "completed":
          agentSuccess({
            state: "completed",
            pipeline_run_id: state.pipeline_run_id,
            main_stuff: state.result.main_stuff ?? null,
            graph_spec: state.result.graph_spec ?? null,
          });
          break;
        case "failed":
          agentError(state.message, "RunFailedError", {
            error_domain: AGENT_ERROR_DOMAINS.PIPELINE,
            retryable: false,
          });
          break;
      }
    });

  // ── run poll ──
  // Block until the run reaches a terminal state. Ctrl-C (or any SIGINT) stops
  // waiting WITHOUT cancelling the run — the run keeps executing server-side
  // and can be resumed by id.

  runGroup
    .command("poll")
    .argument("<pipeline_run_id>", "Run id")
    .option("--interval <seconds>", "Base poll interval in seconds (default 2)")
    .option("--timeout <seconds>", "Max seconds to wait before giving up (default 1200)")
    .description("Poll a run to completion, then return its result")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(
      async (
        runId: string,
        options: { interval?: string; timeout?: string }
      ): Promise<void> => {
        const runner = safeCreateRunner(makeRunner);
        const intervalMs = parsePositiveSeconds(options.interval, "--interval");
        const timeoutMs = parsePositiveSeconds(options.timeout, "--timeout");

        const controller = new AbortController();
        const onSigint = (): void => controller.abort();
        process.once("SIGINT", onSigint);

        try {
          const result = await runner.waitForResult(runId, {
            intervalMs,
            timeoutMs,
            signal: controller.signal,
          });
          agentSuccess({
            state: "completed",
            pipeline_run_id: runId,
            main_stuff: result.main_stuff ?? null,
            graph_spec: result.graph_spec ?? null,
          });
        } catch (err) {
          if (controller.signal.aborted) {
            // Walk-away: not an error. Report the run as still resumable by id.
            agentSuccess({
              state: "running",
              pipeline_run_id: runId,
              resumable: true,
              hint: `Stopped waiting; the run continues. Resume with: mthds-agent run poll ${runId}`,
            });
          } else if (err instanceof RunFailedError) {
            agentError(err.message, "RunFailedError", {
              error_domain: AGENT_ERROR_DOMAINS.PIPELINE,
              retryable: false,
            });
          } else if (err instanceof RunTimeoutError) {
            agentError(err.message, "RunTimeoutError", {
              error_domain: AGENT_ERROR_DOMAINS.RUNNER,
              retryable: true,
              hint: `The run is still executing. Resume with: mthds-agent run poll ${runId}`,
            });
          } else {
            agentError((err as Error).message, "RunnerError", {
              error_domain: AGENT_ERROR_DOMAINS.RUNNER,
            });
          }
        } finally {
          process.removeListener("SIGINT", onSigint);
        }
      }
    );

  // ── models ──

  program
    .command("models")
    .description("List the model deck (models, aliases, waterfalls)")
    .option("--type <type>", "Filter by model category (llm, extract, img_gen, search)")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (options: { type?: string }) => {
      const runner = safeCreateRunner(makeRunner);
      const category = parseModelCategory(options.type);
      try {
        const result = await runner.models(category);
        agentSuccess({ ...result });
      } catch (err) {
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }
    });

  // ── check-model ──
  // check-model is a LOCAL CLI capability (pipelex runner) only — the MTHDS
  // API has no check-model route. Registered here so the API runner errors
  // cleanly instead of failing with an opaque 404.

  program
    .command("check-model")
    .description("Validate a model reference with fuzzy suggestions (pipelex runner only)")
    .argument("<reference>", "Model reference to check")
    .option("--type <type>", "Model category (llm, extract, img_gen, search)")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async () => {
      agentError(
        "check-model is not available on the API runner — the MTHDS API has no check-model route. It is a local capability of the pipelex runner: re-run with --runner pipelex. To list what the API can route to, use: mthds-agent models",
        "UnsupportedError",
        { error_domain: AGENT_ERROR_DOMAINS.RUNNER }
      );
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

// TODO: resolveContent() doesn't handle directory targets (unlike resolveContentForRun()).
// validate bundle and inputs bundle use this function and will fail when passed a directory.
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
    // TODO: refactor to return { bundleContent, resolvedInputsPath } instead of mutating
    // the caller's options object. This side-effect coupling is fragile — if the call
    // order in runAction changes, auto-discovery silently breaks with no compile-time signal.
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

function resolveRunInputs(options: {
  inputs?: string;
  inputsJson?: string;
}): Record<string, unknown> | undefined {
  if (options.inputsJson) return parseJsonOrError(options.inputsJson, "--inputs-json");
  if (options.inputs) {
    const raw = readFileOrError(options.inputs);
    return parseJsonOrError(raw, "inputs file");
  }
  return undefined;
}

function resolveStartOptions(
  target: string | undefined,
  options: {
    pipe?: string;
    inputs?: string;
    content?: string;
    inputsJson?: string;
    outputName?: string;
    outputMultiplicity?: string;
    dynamicOutput?: string;
    extra?: string;
  }
): StartOptions {
  const outputs = {
    output_name: options.outputName,
    output_multiplicity: parseMultiplicity(options.outputMultiplicity),
    dynamic_output_concept_ref: options.dynamicOutput,
  };
  const extra = parseExtraOption(options.extra);
  // No inline bundle → an extension-only start: the run is identified entirely by
  // server-specific args passed through `--extra` (e.g. a stored-method run). The
  // runner is the source of truth for what `extra` it accepts — the SDK and CLI
  // never name those args.
  if (!target && !options.content) {
    return { pipe_code: options.pipe, inputs: resolveRunInputs(options), ...outputs, extra };
  }
  // resolveContentForRun may set options.inputs (directory auto-discovery), so
  // resolve the bundle before reading inputs.
  const mthdsContent = resolveContentForRun(target, options);
  const pipeCode = resolvePipeCode(mthdsContent, options.pipe);
  return { pipe_code: pipeCode, mthds_contents: [mthdsContent], inputs: resolveRunInputs(options), ...outputs, extra };
}

/** Parse `--extra <json>` into the generic extension passthrough — a JSON object of server-defined args. */
function parseExtraOption(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const parsed = parseJsonOrError(raw, "--extra");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    agentError("--extra must be a JSON object of server-specific args.", "ArgumentError", {
      error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
    });
    throw new Error("unreachable");
  }
  return parsed;
}

/** Parse `--output-multiplicity`: "false"/"true" → boolean, a positive integer → count. */
function parseMultiplicity(raw: string | undefined): boolean | number | undefined {
  if (raw === undefined) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  const count = Number(raw);
  if (Number.isInteger(count) && count > 0) return count;
  agentError(
    "--output-multiplicity must be 'true', 'false', or a positive integer.",
    "ArgumentError",
    { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT }
  );
  throw new Error("unreachable");
}

function parsePositiveSeconds(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    agentError(`${label} must be a positive number of seconds.`, "ArgumentError", {
      error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
    });
    throw new Error("unreachable");
  }
  return seconds * 1000;
}

/** Parse the `--type` model-category filter, erroring on unknown values. */
function parseModelCategory(raw: string | undefined): ModelCategory | undefined {
  if (raw === undefined) return undefined;
  if ((MODEL_CATEGORIES as readonly string[]).includes(raw)) {
    return raw as ModelCategory;
  }
  agentError(
    `--type must be one of: ${MODEL_CATEGORIES.join(", ")}.`,
    "ArgumentError",
    { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT }
  );
  throw new Error("unreachable");
}

/**
 * Run the protocol validate (`POST /v1/validate`) and emit the agent envelope.
 * A valid bundle returns the structural artifacts; an invalid bundle is an
 * HTTP 422 problem, surfaced as a ValidationError.
 */
async function runProtocolValidate(
  runner: Runner,
  mthdsContents: string[],
  allowSignatures: boolean
): Promise<void> {
  try {
    const report = await runner.validate(mthdsContents, allowSignatures);
    agentSuccess({ success: true, ...report });
  } catch (err) {
    if (err instanceof ApiResponseError && err.status === 422) {
      agentError(err.serverMessage ?? err.message, "ValidationError", {
        error_domain: AGENT_ERROR_DOMAINS.VALIDATION,
      });
      return;
    }
    agentError((err as Error).message, "RunnerError", {
      error_domain: AGENT_ERROR_DOMAINS.RUNNER,
    });
  }
}
