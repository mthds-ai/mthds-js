/**
 * API runner commands — registered only when --runner=api.
 *
 * Each command parses CLI args, builds request objects, calls the Runner
 * interface, and wraps results with agentSuccess(). No passthrough logic.
 */

import { Command, Option } from "commander";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import {
  agentError,
  agentSuccess,
  agentMarkdownSuccess,
  agentMarkdownError,
  AGENT_ERROR_DOMAINS,
} from "../output.js";
import { isApiRunner } from "../../cli/commands/utils.js";
import type { MthdsFileItem, Runner } from "../../runners/types.js";
import type { StartOptions } from "../../protocol/options.js";
import type { ModelCategory } from "../../protocol/models.js";
import { MODEL_CATEGORIES } from "../../protocol/models.js";
import { ApiResponseError } from "../../runners/api/exceptions.js";

/**
 * Register all API-runner commands on the program.
 * Only called when --runner=api.
 */
export function registerApiRunnerCommands(program: Command, makeRunner: () => Runner): void {
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
    .addOption(
      new Option("--format <fmt>", "Success output format: markdown (default) or json").choices([
        "markdown",
        "json",
      ]),
    )
    .addOption(
      new Option(
        "--error-format <fmt>",
        "Error output format (defaults to --format): markdown or json",
      ).choices(["markdown", "json"]),
    )
    .description("Validate a bundle file or content")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(
      async (
        target: string | undefined,
        options: {
          allowSignatures?: boolean;
          content?: string;
          format?: string;
          errorFormat?: string;
        },
      ) => {
        const runner = safeCreateRunner(makeRunner);
        const mthdsContent = resolveContent(target, options.content);
        // A real file path (not inline --content) names the source for diagnostics.
        const mthdsSources = !options.content && target ? [target] : undefined;
        await runProtocolValidate(
          runner,
          [mthdsContent],
          options.allowSignatures ?? false,
          mthdsSources,
          options.format,
          options.errorFormat,
        );
      },
    );

  validateGroup
    .command("pipe")
    .argument("<target>", ".mthds bundle file")
    .option("--allow-signatures", "Tolerate unimplemented pipe signatures")
    .addOption(
      new Option("--format <fmt>", "Success output format: markdown (default) or json").choices([
        "markdown",
        "json",
      ]),
    )
    .addOption(
      new Option(
        "--error-format <fmt>",
        "Error output format (defaults to --format): markdown or json",
      ).choices(["markdown", "json"]),
    )
    .description("Validate a bundle file (protocol validate covers every pipe in it)")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(
      async (
        target: string,
        options: { allowSignatures?: boolean; format?: string; errorFormat?: string },
      ) => {
        const runner = safeCreateRunner(makeRunner);
        if (!target.endsWith(".mthds")) {
          agentError(
            "Validating a bare pipe code is not supported via the API runner — the protocol validate takes bundle contents. Pass a .mthds file.",
            "ArgumentError",
            { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT },
          );
          return;
        }
        const mthdsContent = readFileOrError(target);
        await runProtocolValidate(
          runner,
          [mthdsContent],
          options.allowSignatures ?? false,
          [target],
          options.format,
          options.errorFormat,
        );
      },
    );

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
        { error_domain: AGENT_ERROR_DOMAINS.RUNNER },
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
    .option("--pipe <ref>", "Qualified pipe ref (domain.pipe_code); defaults to the main_pipe")
    .option("--content <mthds>", "Bundle content as a string")
    .description("Generate inputs from a bundle file or content")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (target: string | undefined, options: { pipe?: string; content?: string }) => {
      const runner = safeCreateRunner(makeRunner);
      const content = resolveContent(target, options.content);
      // Only a real file path names the source — `--content` overrides the target, so
      // stamping diagnostics with `target` would point at a file we never submitted.
      // Same guard as `validate bundle` above.
      const source = !options.content && target ? target : undefined;
      await emitInputsTemplate(runner, { content, source }, options.pipe);
    });

  inputsGroup
    .command("pipe")
    .argument("<target>", "Bundle file (.mthds) or pipe code")
    .option("--pipe <ref>", "Qualified pipe ref (domain.pipe_code); defaults to the main_pipe")
    .description("Generate inputs for a pipe")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (target: string, options: { pipe?: string }) => {
      const runner = safeCreateRunner(makeRunner);
      if (!target.endsWith(".mthds")) {
        agentError(
          "Pipe code without a bundle file is not supported yet. Provide a .mthds file.",
          "ArgumentError",
          { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT },
        );
      }
      await emitInputsTemplate(
        runner,
        { content: readFileOrError(target), source: target },
        options.pipe,
      );
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
      agentError("'inputs method' is not yet supported via the API runner.", "UnsupportedError", {
        error_domain: AGENT_ERROR_DOMAINS.RUNNER,
      });
    });

  // ── inputs upload ──
  // Push a local file to pipelex storage and print its `pipelex-storage://` URI.
  // Used where inputs.json must reference remote URIs only (the hosted build
  // sandbox): generated files live on an ephemeral, runner-invisible filesystem,
  // so a local path can never execute on the hosted runner.

  inputsGroup
    .command("upload")
    .argument("<file>", "Path to the local file to upload")
    .description("Upload a file to pipelex storage; prints its pipelex-storage:// URI")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (file: string) => {
      const runner = safeCreateRunner(makeRunner);
      if (!isApiRunner(runner)) {
        agentError("'inputs upload' requires the API runner (--runner api).", "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }
      const data = readFileBase64OrError(file);
      const filename = basename(file);
      const contentType = guessContentType(filename);
      try {
        const result = await runner.uploadFile({ filename, data, contentType });
        agentSuccess({ success: true, uri: result.uri, filename: result.filename });
      } catch (err) {
        if (err instanceof ApiResponseError) {
          agentError(err.serverMessage ?? err.message, err.errorType ?? "RunnerError", {
            error_domain: AGENT_ERROR_DOMAINS.RUNNER,
          });
        }
        agentError((err as Error).message, "RunnerError", {
          error_domain: AGENT_ERROR_DOMAINS.RUNNER,
        });
      }
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
      agentError("'run method' is not yet supported via the API runner.", "UnsupportedError", {
        error_domain: AGENT_ERROR_DOMAINS.RUNNER,
      });
    });

  // ── run start ──
  // Submit a run and return its id immediately (the protocol `POST /v1/start`).
  // The returned `pipeline_run_id` is authoritative; how completion is later
  // delivered is implementation-defined. The durable poll-by-id lifecycle now
  // lives in `@pipelex/sdk` / `pipelex-agent`.

  runGroup
    .command("start")
    .argument("[target]", "Bundle file (.mthds) or directory")
    .option("--pipe <code>", "Pipe code to run")
    .option("-i, --inputs <file>", "Path to JSON inputs file")
    .option("--content <mthds>", "Bundle content as a string")
    .option("--inputs-json <json>", "Inputs as a JSON string")
    .option(
      "--extra <json>",
      "Server-specific extension args as a JSON object (e.g. a stored-method run) — forwarded to the runner verbatim",
    )
    .option("--output-name <name>", "Name of the output slot to write to")
    .option(
      "--output-multiplicity <value>",
      "Output multiplicity: 'false', 'true', or an exact count",
    )
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
        },
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
      },
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
        "check-model is not available on the API runner — the Pipelex API has no check-model route. It is a local capability of the pipelex runner: re-run with --runner pipelex. To list what the API can route to, use: mthds-agent models",
        "UnsupportedError",
        { error_domain: AGENT_ERROR_DOMAINS.RUNNER },
      );
    });

  // ── codegen ──
  // codegen is a LOCAL CLI capability (pipelex runner) only for now — the MTHDS
  // API has no codegen routes yet. Registered here so the API runner errors
  // cleanly instead of Commander rejecting the args with a generic message.

  const codegenUnsupported = () => {
    agentError(
      "codegen is not available on the API runner — the Pipelex API has no codegen routes yet. It is a local capability of the pipelex runner: re-run with --runner pipelex.",
      "UnsupportedError",
      { error_domain: AGENT_ERROR_DOMAINS.RUNNER },
    );
  };

  const codegenGroup = program
    .command("codegen")
    .description(
      "Project the crate into typed artifacts and check drift offline (pipelex runner only)",
    )
    .exitOverride();

  codegenGroup
    .command("types")
    .description("Project the crate's concept set into typed artifacts (pipelex runner only)")
    .argument("[paths...]", "Directories of .mthds bundles to resolve into the closure")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async () => {
      codegenUnsupported();
    });

  codegenGroup
    .command("check")
    .description("Verify generated artifacts are current (pipelex runner only)")
    .argument("[root]", "Directory holding codegen.lock and generated artifacts")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async () => {
      codegenUnsupported();
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

/** Read a file as raw bytes and base64-encode it, mapping read failures to an IO agent error. */
function readFileBase64OrError(path: string): string {
  try {
    return readFileSync(path).toString("base64");
  } catch (err) {
    agentError(`Cannot read file: ${(err as Error).message}`, "IOError", {
      error_domain: AGENT_ERROR_DOMAINS.IO,
    });
    throw err;
  }
}

// Extension → MIME map for uploaded synthetic inputs. Mirrors the /pub skill's
// table — enough coverage for the file types the inputs-skill generates (images,
// PDFs, office docs, text). An unknown extension returns undefined; the server
// then applies a provider default, so this never blocks an upload.
const CONTENT_TYPE_BY_EXT: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function guessContentType(filename: string): string | undefined {
  const ext = extname(filename).slice(1).toLowerCase();
  return CONTENT_TYPE_BY_EXT[ext];
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
  options: { content?: string; inputs?: string; inputsJson?: string },
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
    // order in resolveStartOptions changes, auto-discovery silently breaks with no compile-time signal.
    if (!options.inputs && !options.inputsJson) {
      const inputsCandidate = join(target, "inputs.json");
      if (existsSync(inputsCandidate)) {
        options.inputs = inputsCandidate;
      }
    }
  }
  return readFileOrError(bundlePath);
}

/**
 * Resolve the pipe for a RUN request (`/execute`, `/start`), whose `pipe_code` is
 * still a bare code. The build routes no longer come through here: they take a
 * qualified `pipe_ref` and let the SERVER default it off the closure's `main_pipe`,
 * which knows the whole closure rather than one file's regex.
 */
function resolvePipeCode(mthdsContent: string, pipeCodeOption: string | undefined): string {
  if (pipeCodeOption) return pipeCodeOption;
  const match = mthdsContent.match(/^main_pipe\s*=\s*"([^"]+)"/m);
  if (match?.[1]) return match[1];
  agentError("Could not determine pipe code. Use --pipe to specify it.", "ArgumentError", {
    error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
  });
  throw new Error("unreachable");
}

/**
 * Run `/v1/build/inputs` for one bundle and emit the agent envelope.
 *
 * The route answers an unresolvable closure with a **200** carrying diagnostics
 * (`is_valid: false`), not a throw — so this branches on the verdict first and only
 * then treats a throw as a transport/no-verdict failure. `pipe_ref` in the success
 * envelope is the RESOLVED qualified ref the server picked, not the `--pipe` string
 * the caller may have omitted.
 */
export async function emitInputsTemplate(
  runner: Runner,
  file: MthdsFileItem,
  pipeRef: string | undefined,
): Promise<void> {
  try {
    const result = await runner.buildInputs({ files: [file], pipe_ref: pipeRef });
    if (!result.is_valid) {
      // A 200 `is_valid: false` is a PRODUCED verdict, not a transport/runtime
      // failure — the `ValidateBundleError` arm, same envelope as
      // `runProtocolValidate` (`ValidationError` is the no-verdict type; `is_valid`
      // and `validation_errors` ride only a verdict). `error_domain` stays
      // `validation` for machine triage — the catch below is the `runner` arm.
      agentError(result.message, "ValidateBundleError", {
        error_domain: AGENT_ERROR_DOMAINS.VALIDATION,
        is_valid: false,
        validation_errors: result.validation_errors,
      });
    }
    agentSuccess({ success: true, pipe_ref: result.pipe_ref, inputs: result.inputs ?? {} });
  } catch (err) {
    agentError((err as Error).message, "RunnerError", {
      error_domain: AGENT_ERROR_DOMAINS.RUNNER,
    });
  }
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
  },
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
  return {
    pipe_code: pipeCode,
    mthds_contents: [mthdsContent],
    inputs: resolveRunInputs(options),
    ...outputs,
    extra,
  };
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
    { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT },
  );
  throw new Error("unreachable");
}

/** Parse the `--type` model-category filter, erroring on unknown values. */
function parseModelCategory(raw: string | undefined): ModelCategory | undefined {
  if (raw === undefined) return undefined;
  if ((MODEL_CATEGORIES as readonly string[]).includes(raw)) {
    return raw as ModelCategory;
  }
  agentError(`--type must be one of: ${MODEL_CATEGORIES.join(", ")}.`, "ArgumentError", {
    error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
  });
  throw new Error("unreachable");
}

/** Normalize a `--format` / `--error-format` value: markdown unless explicitly `json`. */
function normValidateFormat(format?: string): "markdown" | "json" {
  return (format ?? "markdown").trim().toLowerCase() === "json" ? "json" : "markdown";
}

/**
 * Run the protocol validate (`POST /v1/validate`) and emit the agent envelope.
 * `/validate` is a diagnostic endpoint: a valid bundle returns the structural
 * artifacts (`is_valid: true`); an invalid bundle is a produced verdict (a 200
 * `is_valid: false` body), surfaced as a structured ValidateBundleError envelope —
 * not a thrown error. A non-2xx (a no-verdict condition) still throws.
 *
 * `outputFormat` (default `markdown`, matching the local `pipelex-agent`) governs
 * the success arm; `errorFormat` (default = `outputFormat`) governs the failure
 * arm. When Markdown is wanted, the request opts into the server's `rendered_markdown`
 * extra (`render: ["markdown"]`) and emits it verbatim — stdout on the valid arm,
 * stderr (exit 1) on the invalid arm — so the API runner matches the local CLI.
 * If the server omits `rendered_markdown` (older server), each arm falls back to its
 * JSON envelope so output is never empty. No-verdict conditions stay JSON (no server
 * Markdown rides a non-200).
 */
export async function runProtocolValidate(
  runner: Runner,
  mthdsContents: string[],
  allowSignatures: boolean,
  mthdsSources?: string[],
  outputFormat?: string,
  errorFormat?: string,
): Promise<void> {
  const successWantsMarkdown = normValidateFormat(outputFormat) === "markdown";
  const errorWantsMarkdown = normValidateFormat(errorFormat ?? outputFormat) === "markdown";
  // Opt into the server's rendered_markdown extra when either arm wants Markdown.
  const render = successWantsMarkdown || errorWantsMarkdown ? ["markdown"] : undefined;
  try {
    // `mthds_sources` + `render` are Pipelex-API extensions (not the pure protocol),
    // so they ride only the concrete client — reach it via `isApiRunner`. The server
    // threads each source onto `validation_errors[].source` and (when `render` asks)
    // attaches `rendered_markdown` to the verdict body.
    const report = isApiRunner(runner)
      ? await runner.validate(mthdsContents, allowSignatures, mthdsSources, render)
      : await runner.validate(mthdsContents, allowSignatures);
    // `rendered_markdown` is an optional Pipelex-API extra present on both verdict
    // arms only when `render` was requested; read it through a safe optional access
    // (the pure-protocol union does not declare it).
    const renderedMarkdownRaw = (report as { rendered_markdown?: unknown }).rendered_markdown;
    const renderedMarkdown =
      typeof renderedMarkdownRaw === "string" && renderedMarkdownRaw.length > 0
        ? renderedMarkdownRaw
        : undefined;
    if (report.is_valid === false) {
      if (errorWantsMarkdown && renderedMarkdown !== undefined) {
        agentMarkdownError(renderedMarkdown);
      }
      agentError(report.message, "ValidateBundleError", {
        error_domain: AGENT_ERROR_DOMAINS.VALIDATION,
        is_valid: false,
        validation_errors: report.validation_errors,
      });
    }
    if (successWantsMarkdown && renderedMarkdown !== undefined) {
      agentMarkdownSuccess(renderedMarkdown);
      return;
    }
    agentSuccess({ success: true, ...report });
  } catch (err) {
    // Only no-verdict conditions reach here now: a request-shape 422 (malformed
    // body / mthds_sources mismatch), auth, or a server fault.
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
