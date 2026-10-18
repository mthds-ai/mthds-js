/**
 * API runner commands — registered only when --runner=api.
 *
 * Each command parses CLI args, builds request objects, calls the Runner
 * interface, and wraps results with agentSuccess(). No passthrough logic.
 */

import { Command, Option } from "commander";
import { existsSync, lstatSync, readFileSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import {
  agentError,
  agentProblem,
  agentSuccess,
  agentWarning,
  agentMarkdownSuccess,
  agentMarkdownError,
  chooseErrorFormat,
  errorFormat,
  problemOfError,
  unexpectedProblem,
} from "../output.js";
import { fileErrorReason } from "../problems.js";
import { buildProblem } from "../../problems/build.js";
import type { Problem, ProblemItem } from "../../problems/types.js";
import { isApiRunner } from "../../cli/commands/utils.js";
import { MethodTargetError, resolveMethodTarget } from "../../runners/method-target.js";
import type { ResolvedMethodTarget } from "../../runners/method-target.js";
import { MethodTreeError } from "../../method-tree/exceptions.js";
import { readMember } from "../../method-tree/file-reading.js";
import type { PipeIORequest, PipeIOResponse, Runner } from "../../runners/types.js";
import {
  INPUTS_TEMPLATE_FORMATS,
  projectInputsTemplate,
  renderInputsTemplate,
} from "../../protocol/inputs_template.js";
import type { InputsTemplateFormat } from "../../protocol/inputs_template.js";
import type { TemplateTable } from "../../protocol/toml_emitter.js";
import type { PipeInputFormDescriptor } from "../../protocol/input_form.js";
import { selectedInputDescriptor } from "../../runners/pipe-io.js";
import type { StartOptions, ValidateSource } from "../../protocol/options.js";
import type { ModelCategory } from "../../protocol/models.js";
import { MODEL_CATEGORIES } from "../../protocol/models.js";

/**
 * Register all API-runner commands on the program.
 * Only called when --runner=api.
 */
export function registerApiRunnerCommands(program: Command, makeRunner: () => Runner): void {
  // `-L` is a global option, which `enablePositionalOptions` parses only before the
  // subcommand. The validate and inputs subcommands declare it too, so the usual
  // `validate bundle <file> -L <dir>/` reaches them instead of being swallowed by
  // `allowUnknownOption`. Directories given in either position all count.
  const libraryDirsWith = (local: string[] | undefined): string[] => [
    ...((program.opts().libraryDir as string[] | undefined) ?? []),
    ...(local ?? []),
  ];

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
    .option(LIBRARY_DIR_FLAGS, LIBRARY_DIR_HELP, collectLibraryDir, [] as string[])
    .option("-g, --graph", "Save graph HTML files (pipelex runner only)")
    .option("-f, --graph-format <fmt>", "Graph format to generate (pipelex runner only)")
    .option("--view", "Include a GraphSpec in the output (pipelex runner only)")
    .option("--direction <dir>", "Flowchart direction (pipelex runner only)")
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
    .description("Validate a bundle file, directory or content")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(
      async (
        target: string | undefined,
        options: {
          allowSignatures?: boolean;
          content?: string;
          libraryDir?: string[];
          graph?: boolean;
          graphFormat?: string;
          view?: boolean;
          direction?: string;
          format?: string;
          errorFormat?: string;
        },
      ) => {
        const runner = safeCreateRunner(makeRunner);
        const resolved = await resolveMethodOrError(
          runner,
          target,
          options.content,
          libraryDirsWith(options.libraryDir),
        );
        // Returns only on a valid verdict: every other outcome exits through agentError.
        await runProtocolValidate(
          runner,
          resolved.method,
          options.allowSignatures ?? false,
          options.format,
          errorFormat(),
        );
        warnGraphNotDrawn(options);
      },
    );

  validateGroup
    .command("pipe")
    .argument("<target>", ".mthds bundle file")
    .option("--allow-signatures", "Tolerate unimplemented pipe signatures")
    .option(LIBRARY_DIR_FLAGS, LIBRARY_DIR_HELP, collectLibraryDir, [] as string[])
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
        options: {
          allowSignatures?: boolean;
          libraryDir?: string[];
          format?: string;
          errorFormat?: string;
        },
      ) => {
        const runner = safeCreateRunner(makeRunner);
        if (!target.endsWith(".mthds")) {
          agentError(
            agentProblem(
              "client.argument_invalid",
              { argument: "target", reason: "not_a_bundle_file" },
              "Validating a bare pipe code is not supported via the API runner — the protocol validate takes bundle contents. Pass a .mthds file.",
            ),
          );
          return;
        }
        const resolved = await resolveMethodOrError(
          runner,
          target,
          undefined,
          libraryDirsWith(options.libraryDir),
        );
        await runProtocolValidate(
          runner,
          resolved.method,
          options.allowSignatures ?? false,
          options.format,
          errorFormat(),
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
        unsupportedOnApiRunner(
          "validate_method",
          "'validate method' is not supported via the API runner — the protocol validate takes bundle contents, not a method URL. Pass a .mthds file to 'validate bundle', or use --runner pipelex.",
        ),
      );
    });

  // ── inputs ──
  // `bundle` and `pipe` send the method's tree as `validate` sends it, and ask for a
  // named bundle's own `main_pipe`, qualified with its domain, unless `--pipe` names one.
  // The template is PROJECTED here from the input-form descriptor `POST /v1/pipe-io`
  // returns (`projectInputsTemplate` / `renderInputsTemplate` in `mthds/protocol`),
  // so both rendering axes — `--format` and `--explicit` — are this CLI's own. The
  // TOML output is byte-for-byte the Python twin's; the JSON envelope carries the
  // same template as a value, a decimal placeholder printing as `0` rather than `0.0`.

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
    .option(LIBRARY_DIR_FLAGS, LIBRARY_DIR_HELP, collectLibraryDir, [] as string[])
    .addOption(inputsFormatOption())
    .option("--explicit", EXPLICIT_OPTION_DESCRIPTION)
    .description("Generate inputs from a bundle file, directory or content")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(
      async (
        target: string | undefined,
        options: InputsCommandOptions & { content?: string; libraryDir?: string[] },
      ) => {
        const runner = safeCreateRunner(makeRunner);
        // The method's tree, as `validate` and `run start` send it: a directory leaves the
        // pipe to the runner's entry rule, a named bundle or `--content` asks for its own.
        const resolved = await resolveMethodOrError(
          runner,
          target,
          options.content,
          libraryDirsWith(options.libraryDir),
        );
        await emitInputsTemplate(
          runner,
          resolved.method,
          options.pipe ?? resolved.entryPipeRef,
          inputsRendering(options),
        );
      },
    );

  inputsGroup
    .command("pipe")
    .argument("<target>", "Bundle file (.mthds) or pipe code")
    .option("--pipe <ref>", "Qualified pipe ref (domain.pipe_code); defaults to the main_pipe")
    .option(LIBRARY_DIR_FLAGS, LIBRARY_DIR_HELP, collectLibraryDir, [] as string[])
    .addOption(inputsFormatOption())
    .option("--explicit", EXPLICIT_OPTION_DESCRIPTION)
    .description("Generate inputs for a pipe")
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async (target: string, options: InputsCommandOptions & { libraryDir?: string[] }) => {
      const runner = safeCreateRunner(makeRunner);
      if (!target.endsWith(".mthds")) {
        agentError(
          agentProblem(
            "client.argument_invalid",
            { argument: "target", reason: "not_a_bundle_file" },
            "Pipe code without a bundle file is not supported yet. Provide a .mthds file.",
          ),
        );
      }
      const resolved = await resolveMethodOrError(
        runner,
        target,
        undefined,
        libraryDirsWith(options.libraryDir),
      );
      await emitInputsTemplate(
        runner,
        resolved.method,
        options.pipe ?? resolved.entryPipeRef,
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
        unsupportedOnApiRunner(
          "run_method",
          "'run method' is not yet supported via the API runner.",
        ),
      );
    });

  // ── run start ──
  // Submit a run and return its id immediately (the protocol `POST /v1/start`).
  // The returned `pipeline_run_id` is authoritative; how completion is later
  // delivered is implementation-defined. The durable poll-by-id lifecycle now
  // lives in `@pipelex/sdk`.

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
    .option(LIBRARY_DIR_FLAGS, LIBRARY_DIR_HELP, collectLibraryDir, [] as string[])
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
          libraryDir?: string[];
        },
      ): Promise<void> => {
        const runner = safeCreateRunner(makeRunner);
        const startOptions = await resolveStartOptions(
          runner,
          target,
          options,
          libraryDirsWith(options.libraryDir),
        );
        try {
          const ack = await runner.start(startOptions);
          agentSuccess({ ...ack });
        } catch (err) {
          agentError(problemOfError(err, unexpectedProblem));
        }
      },
    );

  // ── models ──

  program
    .command("models")
    .description("List the model deck (models, aliases, waterfalls)")
    .option("--type <type>", `Filter by model category (${MODEL_CATEGORIES.join(", ")})`)
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
        agentError(problemOfError(err, unexpectedProblem));
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
    .option("--type <type>", `Model category (${MODEL_CATEGORIES.join(", ")})`)
    .allowUnknownOption()
    .allowExcessArguments(true)
    .exitOverride()
    .action(async () => {
      agentError(
        unsupportedOnApiRunner(
          "check_model",
          "check-model is not available on the API runner — the Pipelex API has no check-model route. It is a local capability of the pipelex runner: re-run with --runner pipelex. To list what the API can route to, use: mthds-agent models",
        ),
      );
    });

  // ── codegen ──
  // codegen is a LOCAL CLI capability (pipelex runner) only for now — the MTHDS
  // API has no codegen routes yet. Registered here so the API runner errors
  // cleanly instead of Commander rejecting the args with a generic message.

  const codegenUnsupported = () => {
    agentError(
      unsupportedOnApiRunner(
        "codegen",
        "codegen is not available on the API runner — the Pipelex API has no codegen routes yet. It is a local capability of the pipelex runner: re-run with --runner pipelex.",
      ),
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

/**
 * An operation the API runner does not offer, `runtime.unsupported` naming it: the pipelex runner
 * offers it, so the step for whoever reads it is to choose that runner.
 */
function unsupportedOnApiRunner(capability: string, message: string): Problem {
  return agentProblem("runtime.unsupported", { capability }, message, { reader: "other" });
}

function safeCreateRunner(makeRunner: () => Runner): Runner {
  try {
    return makeRunner();
  } catch (err) {
    agentError(
      problemOfError(err, (message) =>
        agentProblem("client.not_configured", { setting: "runner" }, message),
      ),
    );
  }
}

function parseJsonOrError(raw: string, label: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    agentError(
      agentProblem(
        "client.argument_invalid",
        { argument: label, reason: "not_json" },
        `${label} must be valid JSON.`,
      ),
    );
  }
}

/** The inputs file a directory target is run with when the caller names none. */
const AUTO_DETECTED_INPUTS_NAME = "inputs.json";

/**
 * Refuse an inputs file found by name that is not a regular file, naming its path:
 * `client.argument_invalid` naming the inputs, which `--inputs` would have named.
 */
function refuseAutoDetectedInputs(path: string, what: string): never {
  agentError(
    agentProblem(
      "client.argument_invalid",
      { argument: "inputs", reason: "not_a_regular_file" },
      `'${path}' was found as the run's inputs because no --inputs was given, but it is ${what}. An inputs file found automatically must be a regular file, so that a link never carries data from outside the method's folder to the runner. Replace it with the file itself, or name the inputs with --inputs <path>.`,
    ),
  );
}

/** The inputs file found by name could not be read: `client.file_unreadable` naming it. */
function autoDetectedInputsUnreadable(path: string, err: unknown): never {
  agentError(
    agentProblem(
      "client.file_unreadable",
      { path, reason: fileErrorReason(err) },
      `Cannot read file: ${(err as Error).message}`,
    ),
  );
}

/**
 * A directory target's own `inputs.json`, parsed, or `undefined` when the directory holds none.
 * Found by name rather than named by the caller, it is read only when it is a regular file, judged
 * by `lstat` and opened without following a link, since a link could carry JSON from outside the
 * method's folder to the runner; the membership rule keeps a link of that name out of the tree
 * without following it, and the file found beside the tree is held to the same. An inputs file
 * the caller names with `--inputs` is read as given.
 */
async function readAutoDetectedInputs(
  target: string,
): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(target) || !statSync(target).isDirectory()) return undefined;
  const candidate = join(target, AUTO_DETECTED_INPUTS_NAME);
  let stats: Stats;
  try {
    stats = lstatSync(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    autoDetectedInputsUnreadable(candidate, err);
  }
  if (stats.isSymbolicLink()) refuseAutoDetectedInputs(candidate, "a symbolic link");
  if (!stats.isFile()) refuseAutoDetectedInputs(candidate, "not a regular file");
  let bytes: Buffer | null;
  try {
    // Opened without following a link, so a file swapped for one since the `lstat` is refused too.
    ({ bytes } = await readMember(candidate, AUTO_DETECTED_INPUTS_NAME, target, true));
  } catch (err) {
    if (err instanceof MethodTreeError && err.code === "symbolic_link") {
      refuseAutoDetectedInputs(candidate, "a symbolic link");
    }
    if (err instanceof MethodTreeError && err.code === "special_file") {
      refuseAutoDetectedInputs(candidate, "not a regular file");
    }
    autoDetectedInputsUnreadable(candidate, err);
  }
  return parseJsonOrError(bytes!.toString("utf-8"), "inputs file");
}

function readFileOrError(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    agentError(
      agentProblem(
        "client.file_unreadable",
        { path, reason: fileErrorReason(err) },
        `Cannot read file: ${(err as Error).message}`,
      ),
    );
  }
}

const LIBRARY_DIR_FLAGS = "-L, --library-dir <dir>";
const LIBRARY_DIR_HELP =
  "Library directory: one holding a lone bundle file becomes the root of the tree sent, one inside the tree adds nothing (can be repeated)";

/** Commander collector for the repeatable `-L, --library-dir`. */
function collectLibraryDir(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Resolve what a validate, inputs or run command sends: the method tree of the target, or
 * the inline `--content` as a one-file tree, with the library directories that
 * belong to it (`resolveMethodTarget`), listed within the limits the runner
 * announces. A target that cannot be sent as one tree, or a tree the standard's
 * lister refuses, is a `client.argument_invalid`; a file or directory that cannot be
 * read is a `client.file_unreadable`, a target that is not there refused before the runner is
 * asked anything; a handshake that fails is relayed as its problem.
 */
async function resolveMethodOrError(
  runner: Runner,
  target: string | undefined,
  content: string | undefined,
  libraryDirs: readonly string[],
): Promise<ResolvedMethodTarget> {
  if (!content && !target) {
    agentError(targetMissingProblem());
  }
  // A target that is not there is the caller's to fix, so it is refused before the runner is
  // asked anything, and an unreachable runner never hides it. The lister reads it again below.
  if (!content) {
    try {
      lstatSync(target!);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      methodUnreadable(
        target,
        new MethodTreeError("not_found", `Cannot read '${target}': ${reason}`, {
          names: [target!],
        }),
      );
    }
  }
  // Inline content is a one-file tree already in hand, so only a listed tree needs the limits.
  let limits = {};
  if (isApiRunner(runner) && !content) {
    try {
      limits = await runner.methodTreeLimits();
    } catch (err) {
      agentError(problemOfError(err, unexpectedProblem));
    }
  }
  try {
    return await resolveMethodTarget(
      content ? { content } : { path: target! },
      libraryDirs,
      limits,
    );
  } catch (err) {
    if (err instanceof MethodTargetError) agentError(err.problem);
    if (err instanceof MethodTreeError && err.code !== "not_found" && err.code !== "not_listable") {
      agentError(
        agentProblem(
          "client.argument_invalid",
          { argument: "target", reason: err.code },
          err.message,
        ),
      );
    }
    methodUnreadable(target, err);
  }
}

/** A method the CLI could not read, `client.file_unreadable`, unless the error carries its own problem. */
function methodUnreadable(target: string | undefined, err: unknown): never {
  agentError(
    problemOfError(err, (message) =>
      agentProblem(
        "client.file_unreadable",
        {
          path: target ?? "--content",
          reason: err instanceof MethodTreeError ? err.code : fileErrorReason(err),
        },
        `Cannot read the method: ${message}`,
      ),
    ),
  );
}

/** The `validate bundle` options of `pipelex-agent` that draw the method's graph locally. */
const GRAPH_OPTIONS = [
  ["graph", "--graph"],
  ["graphFormat", "--graph-format"],
  ["view", "--view"],
  ["direction", "--direction"],
] as const;

/**
 * Say that the graph options of `validate bundle` were not applied, which the API
 * runner cannot do: the graph files and the GraphSpec view are drawn locally by the
 * pipelex runner. The bundle is still validated, because the skills that pass
 * `--graph` rely on the verdict above all. Declaring the options keeps them from
 * being swallowed by `allowUnknownOption`, which would print the verdict as if the
 * graph had been drawn. Called once the verdict is a success, as the pipelex runner
 * draws the graph only then, so an invalid verdict's problem stays the one
 * document on stderr. The warning takes the error stream's form (`agentWarning`).
 */
function warnGraphNotDrawn(options: Record<string, unknown>): void {
  const given = GRAPH_OPTIONS.filter(([key]) => options[key] !== undefined).map(([, flag]) => flag);
  if (given.length === 0) return;
  const one = given.length === 1;
  agentWarning(
    `${given.join(", ")} ${one ? "was" : "were"} not applied: the API runner validated the method but cannot draw its graph, which only the pipelex runner draws. Re-run with --runner pipelex for the graph. On the API runner, the JSON verdict (--format json) carries the method's graph as graph_spec.`,
  );
}

// ── inputs: the pipe I/O read and the local projection ──

/**
 * The method `inputs` sends: exactly one of the three `/v1/pipe-io` takes, the method's
 * tree (a listed tree, or `--content` as a one-file `files` map), a published
 * method's address or a hosted catalog id.
 */
export type InputsSelector =
  | ResolvedMethodTarget["method"]
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
      agentProblem(
        "client.argument_invalid",
        { argument: "target", reason: "local_path" },
        `'${target}' is a local path, not a published method's address. On the API runner, 'inputs method' takes an address (github.com/<owner>/<repo>[/<selector>][@<tag>]) or a hosted catalog id (mt_…): pass a local bundle to 'inputs bundle', or re-run with --runner pipelex.`,
      ),
    );
  }
  if (trimmed.includes("/")) return { method_ref: trimmed };
  agentError(
    agentProblem(
      "client.argument_invalid",
      { argument: "target", reason: "not_a_method_address" },
      `'${target}' is neither a published method's address nor a catalog id. On the API runner, 'inputs method' takes an address (github.com/<owner>/<repo>[/<selector>][@<tag>]) or a hosted catalog id (mt_…). An installed method's name is resolved only by the pipelex runner: re-run with --runner pipelex, or pass the bundle to 'inputs bundle'.`,
    ),
  );
}

/**
 * Read a pipe's input form from `POST /v1/pipe-io`, project its fill-in template
 * locally, and emit it.
 *
 * - **A refusal** is the runner's problem, relayed whole: a refused selection is coded
 *   by one of `PIPE_SELECTION_CODES` (an unknown `--pipe`, no entry pipe, several),
 *   whose parameters list the candidates.
 * - **An invalid method** is a PRODUCED verdict, a 200 `is_valid: false`, and is the
 *   `method.invalid` problem holding its items, the same one `validate` writes.
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
    agentError(
      agentProblem(
        "client.not_configured",
        { setting: "runner" },
        "'inputs' on this path requires the API runner (--runner api).",
      ),
    );
  }
  // An empty `--pipe ""` is still a selection: sent as given, the runner refuses it,
  // where dropping it would template the default pipe and report success.
  const request: PipeIORequest =
    pipeRef !== undefined ? { ...selector, pipe_ref: pipeRef } : { ...selector };
  let result: PipeIOResponse;
  try {
    result = await runner.pipeIo(request);
  } catch (err) {
    agentError(problemOfError(err, unexpectedProblem));
  }

  if (!result.is_valid) {
    // A 200 `is_valid: false` is a PRODUCED verdict, not a transport/runtime
    // failure — the `method.invalid` problem holding the verdict's items, the same
    // one `runProtocolValidate` writes, with `is_valid: false` beside it.
    agentError(methodInvalidProblem(result.errors, result.message), { is_valid: false });
  }

  let resolvedRef: string;
  let descriptor: PipeInputFormDescriptor;
  try {
    ({ pipeRef: resolvedRef, descriptor } = selectedInputDescriptor(result));
  } catch (err) {
    agentError(problemOfError(err, unexpectedProblem));
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
      unexpectedProblem(
        `Cannot render the inputs template of '${resolvedRef}': ${(err as Error).message}`,
      ),
    );
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

/** The refusal of a run command naming neither a target nor `--content`. */
function targetMissingProblem(): Problem {
  return agentProblem(
    "client.argument_invalid",
    { argument: "target", reason: "missing" },
    "Either <target> or --content is required.",
  );
}

/**
 * The problem of a method that does not validate, `method.invalid`, holding one item per fault of
 * the verdict. Whoever validates a method reads it as its author, so it carries the author's step.
 */
export function methodInvalidProblem(errors: ProblemItem[], message: string | undefined): Problem {
  return buildProblem("method.invalid", {}, { reader: "actor", errors, extra: { message } });
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

async function resolveStartOptions(
  runner: Runner,
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
  libraryDirs: readonly string[],
): Promise<StartOptions> {
  const outputs = {
    output_name: options.outputName,
    output_multiplicity: parseMultiplicity(options.outputMultiplicity),
    dynamic_output_concept_ref: options.dynamicOutput,
  };
  const extra = parseExtraOption(options.extra);
  // No method → an extension-only start: the run is identified entirely by
  // server-specific args passed through `--extra` (e.g. a stored-method run). The
  // runner is the source of truth for what `extra` it accepts — the SDK and CLI
  // never name those args.
  if (!target && !options.content) {
    return { pipe_code: options.pipe, inputs: resolveRunInputs(options), ...outputs, extra };
  }
  // A directory target's own `inputs.json` is its inputs when none are given, read only when it
  // is a regular file. The membership rule keeps a run's inputs file out of every tree, so it
  // never travels with the method.
  const autoDetectedInputs =
    target && !options.content && !options.inputs && !options.inputsJson
      ? await readAutoDetectedInputs(target)
      : undefined;
  // The method's whole tree travels, so its Python, templates and other files reach
  // the runner with its bundles. `--content` is a one-file tree of its own.
  const resolved = await resolveMethodOrError(runner, target, options.content, libraryDirs);
  // A named bundle runs its own `main_pipe`; a directory leaves the choice to the
  // runner, which starts at the manifest's `main_pipe` or the tree's one `main_pipe`.
  const pipeCode = options.pipe ?? resolved.entryMainPipe;
  if (pipeCode === undefined && resolved.entry !== null) {
    agentError(
      agentProblem(
        "client.argument_invalid",
        { argument: "pipe", reason: "missing" },
        "Could not determine pipe code. Use --pipe to specify it.",
      ),
    );
  }
  return {
    ...resolved.method,
    pipe_code: pipeCode,
    inputs: autoDetectedInputs ?? resolveRunInputs(options),
    ...outputs,
    extra,
  };
}

/** Parse `--extra <json>` into the generic extension passthrough — a JSON object of server-defined args. */
function parseExtraOption(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  const parsed = parseJsonOrError(raw, "--extra");
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    agentError(
      agentProblem(
        "client.argument_invalid",
        { argument: "--extra", reason: "not_an_object" },
        "--extra must be a JSON object of server-specific args.",
      ),
    );
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
    agentProblem(
      "client.argument_invalid",
      { argument: "--output-multiplicity", reason: "unknown_value" },
      "--output-multiplicity must be 'true', 'false', or a positive integer.",
    ),
  );
}

/** Parse the `--type` model-category filter, erroring on unknown values. */
function parseModelCategory(raw: string | undefined): ModelCategory | undefined {
  if (raw === undefined) return undefined;
  if ((MODEL_CATEGORIES as readonly string[]).includes(raw)) {
    return raw as ModelCategory;
  }
  agentError(
    agentProblem(
      "client.argument_invalid",
      { argument: "--type", reason: "unknown_value" },
      `--type must be one of: ${MODEL_CATEGORIES.join(", ")}.`,
    ),
  );
}

/** Normalize a `--format` / `--error-format` value: markdown unless explicitly `json`. */
function normValidateFormat(format?: string): "markdown" | "json" {
  return (format ?? "markdown").trim().toLowerCase() === "json" ? "json" : "markdown";
}

/**
 * Run the protocol validate (`POST /v1/validate`) and emit the verdict.
 * `/validate` is a diagnostic endpoint: a valid bundle returns the structural
 * artifacts (`is_valid: true`); an invalid bundle is a produced verdict (a 200
 * `is_valid: false` body), written as the `method.invalid` problem holding its
 * items — not a thrown error. A non-2xx (a no-verdict condition) still throws,
 * and its problem is relayed whole.
 *
 * `outputFormat` (default `markdown`, matching the local `pipelex-agent`) governs
 * the success arm; `errorFormat` (default = `outputFormat`) governs the failure
 * arm. When Markdown is wanted, the request opts into the server's `rendered_markdown`
 * extra (`render: ["markdown"]`) and emits it verbatim — stdout on the valid arm,
 * stderr (exit 1) on the invalid arm — so the API runner matches the local CLI.
 * If the server omits `rendered_markdown` (older server), the valid arm falls back to its
 * JSON envelope and the invalid arm to this CLI's own Markdown rendering of the problem,
 * so output is never empty. A no-verdict condition is written in the error format too,
 * rendered by this CLI, since no server Markdown rides a non-200.
 */
export async function runProtocolValidate(
  runner: Runner,
  source: ValidateSource,
  allowSignatures: boolean,
  outputFormat?: string,
  errorFormat?: string,
): Promise<void> {
  const successWantsMarkdown = normValidateFormat(outputFormat) === "markdown";
  const errorWantsMarkdown = normValidateFormat(errorFormat ?? outputFormat) === "markdown";
  chooseErrorFormat(errorWantsMarkdown ? "markdown" : "json");
  // Opt into the server's rendered_markdown extra when either arm wants Markdown.
  const render = successWantsMarkdown || errorWantsMarkdown ? ["markdown"] : undefined;
  try {
    // `render` is a Pipelex-API extension (not the pure protocol), so it rides only
    // the concrete client — reach it via `isApiRunner`. When asked, the server
    // attaches `rendered_markdown` to the verdict body. Each item names its file by
    // tree path in its `location.file`.
    const report = isApiRunner(runner)
      ? await runner.validate(source, allowSignatures, render)
      : await runner.validate(source, allowSignatures);
    // `rendered_markdown` is an optional Pipelex-API extra present on both verdict
    // arms only when `render` was requested; read it through a safe optional access
    // (the pure-protocol union does not declare it).
    const renderedMarkdownRaw = (report as { rendered_markdown?: unknown }).rendered_markdown;
    const renderedMarkdown =
      typeof renderedMarkdownRaw === "string" && renderedMarkdownRaw.length > 0
        ? renderedMarkdownRaw
        : undefined;
    if (report.is_valid === false) {
      const problem = methodInvalidProblem(report.errors, report.message);
      if (errorWantsMarkdown && renderedMarkdown !== undefined) {
        agentMarkdownError(renderedMarkdown, problem);
      }
      agentError(problem, { is_valid: false });
    }
    if (successWantsMarkdown && renderedMarkdown !== undefined) {
      agentMarkdownSuccess(renderedMarkdown);
      return;
    }
    agentSuccess({ success: true, ...report });
  } catch (err) {
    // Only no-verdict conditions reach here now: a request-shape 422 (a malformed
    // body, a tree the runner refuses), auth, or a server fault. Their problem is
    // relayed whole, and never carries `is_valid`, which rides only a verdict.
    agentError(problemOfError(err, unexpectedProblem));
  }
}
