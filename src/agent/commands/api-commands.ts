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
  runnerProblemExtras,
} from "../output.js";
import { isApiRunner } from "../../cli/commands/utils.js";
import { collectBundleFiles, pickMainBundleFile, resolveRunBundle } from "../../runners/bundle.js";
import { readBundleMeta } from "../../runners/pipe-ref.js";
import type { MthdsFileItem, PipeIORequest, PipeIOResponse, Runner } from "../../runners/types.js";
import { PIPE_SELECTION_ERROR_TYPES } from "../../runners/types.js";
import {
  INPUTS_TEMPLATE_FORMATS,
  projectInputsTemplate,
  renderInputsTemplate,
} from "../../protocol/inputs_template.js";
import type { InputsTemplateFormat } from "../../protocol/inputs_template.js";
import type { TemplateTable } from "../../protocol/toml_emitter.js";
import type { PipeInputFormDescriptor } from "../../protocol/input_form.js";
import { selectedInputDescriptor } from "../../runners/pipe-io.js";
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
          ...runnerProblemExtras(err),
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
          ...runnerProblemExtras(err),
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
  // The template is PROJECTED here from the input-form descriptor `POST /v1/pipe-io`
  // returns (`projectInputsTemplate` / `renderInputsTemplate` in `mthds/protocol`),
  // so both rendering axes — `--format` and `--explicit` — are this CLI's own and
  // agree byte-for-byte with the Python twin.

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
    .addOption(inputsFormatOption())
    .option("--explicit", EXPLICIT_OPTION_DESCRIPTION)
    .description("Generate inputs from a bundle file or content")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(
      async (target: string | undefined, options: InputsCommandOptions & { content?: string }) => {
        const runner = safeCreateRunner(makeRunner);
        const content = resolveContent(target, options.content);
        // Only a real file path names the source — `--content` overrides the target, so
        // stamping diagnostics with `target` would point at a file we never submitted.
        // Same guard as `validate bundle` above.
        const source = !options.content && target ? target : undefined;
        await emitInputsTemplate(
          runner,
          { files: [{ content, source }] },
          options.pipe,
          inputsRendering(options),
        );
      },
    );

  inputsGroup
    .command("pipe")
    .argument("<target>", "Bundle file (.mthds) or pipe code")
    .option("--pipe <ref>", "Qualified pipe ref (domain.pipe_code); defaults to the main_pipe")
    .addOption(inputsFormatOption())
    .option("--explicit", EXPLICIT_OPTION_DESCRIPTION)
    .description("Generate inputs for a pipe")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (target: string, options: InputsCommandOptions) => {
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
        { files: [{ content: readFileOrError(target), source: target }] },
        options.pipe,
        inputsRendering(options),
      );
    });

  // On the API runner a "method" is one the server can reach without a bundle on
  // disk: a published method's address (`method_ref`) or, on a hosted API, a stored
  // method's catalog id (`method_id`). An installed method's NAME is resolved only by
  // the pipelex runner, which reads the local install.
  inputsGroup
    .command("method")
    .argument(
      "<target>",
      "Published method address (github.com/owner/repo[/selector][@tag]) or catalog id (mt_…)",
    )
    .option("--pipe <ref>", "Qualified pipe ref (domain.pipe_code); defaults to the main_pipe")
    .addOption(inputsFormatOption())
    .option("--explicit", EXPLICIT_OPTION_DESCRIPTION)
    .description("Generate inputs for a published or stored method")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (target: string, options: InputsCommandOptions) => {
      const runner = safeCreateRunner(makeRunner);
      await emitInputsTemplate(
        runner,
        methodSelector(target),
        options.pipe,
        inputsRendering(options),
      );
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
            ...runnerProblemExtras(err),
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
            ...runnerProblemExtras(err),
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
          ...runnerProblemExtras(err),
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
    // Resolve the entrypoint from the directory's bundle files rather than
    // assuming it is literally named `bundle.mthds` — a custom-Python method's
    // main `.mthds` can have any name, and hardcoding `bundle.mthds` rejected
    // otherwise-valid bundles before they could run.
    const files = collectBundleFiles(target);
    if (!Object.keys(files).some((rel) => rel.endsWith(".mthds"))) {
      agentError(`No .mthds file found in directory: ${target}`, "IOError", {
        error_domain: AGENT_ERROR_DOMAINS.IO,
      });
    }
    bundlePath = join(target, pickMainBundleFile(files));
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
  // Read `main_pipe` with the real TOML parser, not a regex: a `.mthds` file IS
  // TOML and spells the key more ways than a regex matches (literal strings
  // `'run'`, quoted keys `"main_pipe" = …`, comments), so the regex rejected
  // valid bundles as having no derivable pipe.
  const { mainPipe } = readBundleMeta(mthdsContent);
  if (mainPipe) return mainPipe;
  agentError("Could not determine pipe code. Use --pipe to specify it.", "ArgumentError", {
    error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
  });
  throw new Error("unreachable");
}

// ── inputs: the pipe I/O read and the local projection ──

/** The closure selector `inputs` sends: exactly one of the three `/v1/pipe-io` takes. */
export type InputsSelector =
  | { files: MthdsFileItem[] }
  | { method_ref: string }
  | { method_id: string };

/** How `inputs` renders the projected template: the two axes of `renderInputsTemplate`. */
export interface InputsRendering {
  format: InputsTemplateFormat;
  explicit: boolean;
}

interface InputsCommandOptions {
  pipe?: string;
  format?: string;
  explicit?: boolean;
}

const EXPLICIT_OPTION_DESCRIPTION =
  "Emit the ceremonial {concept, content} envelope on every input instead of the light values";

// The catalog id prefix of a stored method on a hosted API (`mt_…`).
const CATALOG_ID_PREFIX = "mt_";

function inputsFormatOption(): Option {
  return new Option(
    "--format <fmt>",
    "Template format: json (the result envelope, default) or toml (raw TOML on stdout)",
  )
    .choices([...INPUTS_TEMPLATE_FORMATS])
    .default("json");
}

function inputsRendering(options: InputsCommandOptions): InputsRendering {
  // Commander has already refused a value outside the choices, so this only narrows.
  const format = (options.format ?? "json") as InputsTemplateFormat;
  return { format, explicit: options.explicit ?? false };
}

/**
 * The selector `inputs method <target>` sends. A catalog id (`mt_…`) is a hosted
 * `method_id`; anything with a path separator is a `method_ref`, whose address form
 * the server resolves and whose registry form it answers `501`. A bare name is
 * neither: it names an installed method, which only the pipelex runner can read.
 */
export function methodSelector(target: string): InputsSelector {
  const trimmed = target.trim();
  if (trimmed.startsWith(CATALOG_ID_PREFIX)) return { method_id: trimmed };
  // A local path has a separator too, and sent as a `method_ref` it would come back
  // as the runner's registry-form `501`, which says nothing about local files.
  if (looksLikeLocalPath(trimmed)) {
    agentError(
      `'${target}' is a local path, not a published method's address. On the API runner, 'inputs method' takes an address (github.com/<owner>/<repo>[/<selector>][@<tag>]) or a hosted catalog id (mt_…): pass a local bundle to 'inputs bundle', or re-run with --runner pipelex.`,
      "ArgumentError",
      { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT },
    );
  }
  if (trimmed.includes("/")) return { method_ref: trimmed };
  agentError(
    `'${target}' is neither a published method's address nor a catalog id. On the API runner, 'inputs method' takes an address (github.com/<owner>/<repo>[/<selector>][@<tag>]) or a hosted catalog id (mt_…). An installed method's name is resolved only by the pipelex runner: re-run with --runner pipelex, or pass the bundle to 'inputs bundle'.`,
    "ArgumentError",
    { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT },
  );
  throw new Error("unreachable");
}

/**
 * Read a pipe's input form from `POST /v1/pipe-io`, project its fill-in template
 * locally, and emit it.
 *
 * - **A refused selection** — a `422` typed by one of `PIPE_SELECTION_ERROR_TYPES`
 *   (an unknown `--pipe`, no entry pipe, several) — is an `ArgumentError` carrying
 *   the runner's own sentence, which is where it lists the candidates. Every other
 *   refusal is a `RunnerError` quoting it. Both carry the problem document's members.
 * - **An invalid closure** is a PRODUCED verdict, a 200 `is_valid: false`, and is the
 *   `ValidateBundleError` arm, the same envelope `validate` emits.
 * - **A valid answer** is projected from `input_form[pipe_ref]`, the RESOLVED
 *   qualified ref the server picked rather than the `--pipe` the caller may have
 *   omitted. JSON prints the `{success, pipe_ref, inputs}` envelope; TOML prints the
 *   raw template on stdout, as `pipelex-agent inputs --format toml` does.
 */
export async function emitInputsTemplate(
  runner: Runner,
  selector: InputsSelector,
  pipeRef: string | undefined,
  rendering: InputsRendering,
): Promise<void> {
  if (!isApiRunner(runner)) {
    agentError("'inputs' on this path requires the API runner (--runner api).", "RunnerError", {
      error_domain: AGENT_ERROR_DOMAINS.RUNNER,
    });
    return;
  }
  const request: PipeIORequest = pipeRef ? { ...selector, pipe_ref: pipeRef } : { ...selector };
  let result: PipeIOResponse;
  try {
    result = await runner.pipeIo(request);
  } catch (err) {
    if (isPipeSelectionRefusal(err)) {
      agentError(err.serverMessage ?? err.message, "ArgumentError", {
        error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
        ...runnerProblemExtras(err),
      });
      return;
    }
    agentError((err as Error).message, "RunnerError", {
      error_domain: AGENT_ERROR_DOMAINS.RUNNER,
      ...runnerProblemExtras(err),
    });
    return;
  }

  if (!result.is_valid) {
    // A 200 `is_valid: false` is a PRODUCED verdict, not a transport/runtime
    // failure — the `ValidateBundleError` arm, same envelope as
    // `runProtocolValidate` (`ValidationError` is the no-verdict type; `is_valid`
    // rides only a verdict, while a refusal above may carry `validation_errors`
    // through `runnerProblemExtras`, never `is_valid`). `error_domain` stays
    // `validation` for machine triage.
    agentError(result.message, "ValidateBundleError", {
      error_domain: AGENT_ERROR_DOMAINS.VALIDATION,
      is_valid: false,
      validation_errors: result.validation_errors,
    });
    return;
  }

  let resolvedRef: string;
  let descriptor: PipeInputFormDescriptor;
  try {
    ({ pipeRef: resolvedRef, descriptor } = selectedInputDescriptor(result));
  } catch (err) {
    agentError((err as Error).message, "RunnerError", { error_domain: AGENT_ERROR_DOMAINS.RUNNER });
    return;
  }

  let rendered: string | undefined;
  let template: TemplateTable | undefined;
  try {
    if (rendering.format === "toml") {
      rendered = renderInputsTemplate(descriptor, rendering);
    } else {
      template = projectInputsTemplate(descriptor, { explicit: rendering.explicit });
    }
  } catch (err) {
    // The descriptor came from the runner, so a template it cannot yield (a concept
    // ref a TOML comment cannot hold) is the runner's answer at fault.
    agentError(
      `Cannot render the inputs template of '${resolvedRef}': ${(err as Error).message}`,
      "RunnerError",
      { error_domain: AGENT_ERROR_DOMAINS.RUNNER },
    );
    return;
  }

  if (rendered !== undefined) {
    // An input-less pipe renders as an empty document; say so in a comment, which
    // still loads back as an empty table, rather than printing nothing.
    process.stdout.write(
      rendered.length > 0 ? rendered : `# Pipe '${resolvedRef}' declares no inputs.\n`,
    );
    return;
  }
  // `TemplateFloat` serializes through its `toJSON`, so the envelope carries plain numbers.
  agentSuccess({ success: true, pipe_ref: resolvedRef, inputs: template ?? {} });
}

/** A target that names something on this machine: a relative or absolute path, a `.mthds` file, or anything that exists on disk. */
function looksLikeLocalPath(target: string): boolean {
  return (
    target.startsWith(".") ||
    target.startsWith("/") ||
    target.startsWith("~") ||
    target.endsWith(".mthds") ||
    existsSync(target)
  );
}

function isPipeSelectionRefusal(err: unknown): err is ApiResponseError {
  return (
    err instanceof ApiResponseError &&
    err.status === 422 &&
    err.errorType !== undefined &&
    PIPE_SELECTION_ERROR_TYPES.has(err.errorType)
  );
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
  // resolve the bundle before reading inputs. It also reads the main `.mthds` text,
  // which resolvePipeCode needs to derive `main_pipe`.
  const mthdsContent = resolveContentForRun(target, options);
  const pipeCode = resolvePipeCode(mthdsContent, options.pipe);
  const inputs = resolveRunInputs(options);
  // A bundle whose directory carries custom PipeFunc Python (a sibling `.py`) must ship the whole
  // bundle as `files` so that Python travels to the runner and into the sandbox crate — otherwise
  // the runner registers the pipes from the `.mthds` alone, builds a crate with no function source,
  // and the sandbox fails with "Function '<name>' not found in registry". A plain `.mthds` (no
  // sibling `.py`) stays on the lighter `mthds_contents` path. `--content` is always inline text
  // with no sibling files to collect, so it never becomes a bundle.
  if (target && !options.content) {
    const bundle = resolveRunBundle(target);
    if (bundle.files) {
      return { pipe_code: pipeCode, files: bundle.files, inputs, ...outputs, extra };
    }
  }
  return {
    pipe_code: pipeCode,
    mthds_contents: [mthdsContent],
    inputs,
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
    // body / mthds_sources mismatch), auth, or a server fault. Their envelope never
    // carries `is_valid`, though a refusal that lists items carries them as
    // `validation_errors` through `runnerProblemExtras`.
    if (err instanceof ApiResponseError && err.status === 422) {
      agentError(err.serverMessage ?? err.message, "ValidationError", {
        error_domain: AGENT_ERROR_DOMAINS.VALIDATION,
        ...runnerProblemExtras(err),
      });
      return;
    }
    agentError((err as Error).message, "RunnerError", {
      error_domain: AGENT_ERROR_DOMAINS.RUNNER,
      ...runnerProblemExtras(err),
    });
  }
}
