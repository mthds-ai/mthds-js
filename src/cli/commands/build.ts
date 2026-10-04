import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import { isApiRunner, isPipelexRunner, extractPassthroughArgs } from "./utils.js";
import { formatCliError, withSuggestedFix } from "./error-output.js";
import { createRunner } from "../../runners/registry.js";
import type { CrateInvalidReport, RunnerType } from "../../runners/types.js";
import { INPUTS_TEMPLATE_FORMATS, renderInputsTemplate } from "../../protocol/inputs_template.js";
import type { InputsTemplateFormat } from "../../protocol/inputs_template.js";
import { selectedInputDescriptor } from "../../runners/pipe-io.js";
import { closureEntryPipeRef, resolveBundleClosure } from "../../runners/bundle.js";
import type { BundleClosure } from "../../runners/bundle.js";

interface WithRunner {
  runner?: RunnerType;
  libraryDir?: string[];
}

/**
 * Render an invalid-closure VERDICT (the `is_valid: false` arm) and exit non-zero.
 *
 * `POST /v1/pipe-io` answers a bad closure with a 200 carrying diagnostics, not an
 * exception — so a CLI that only caught throws would print a success message over
 * an unusable result. Returns true when the verdict is valid and the caller should
 * carry on. It never returns on the invalid arm (`process.exit`), but TypeScript
 * cannot narrow through that, hence the boolean + the `is_valid` type guard.
 */
function reportIfInvalid(
  spinner: ReturnType<typeof p.spinner>,
  result: { is_valid: true } | CrateInvalidReport,
): result is { is_valid: true } {
  if (result.is_valid) return true;
  spinner.stop("Build failed.");
  p.log.error(result.message);
  for (const item of result.validation_errors) {
    const where = [item.source, item.pipe_code].filter(Boolean).join(" · ");
    p.log.error(withSuggestedFix(where ? `${where}: ${item.message}` : item.message, item));
  }
  p.outro("");
  process.exit(1);
}

// ── mthds build inputs method <name> ─────────────────────────────────

export async function buildInputsMethod(
  _name: string,
  options: { pipe?: string } & WithRunner,
): Promise<void> {
  printLogo();
  p.intro("mthds build inputs method");

  const libraryDirs = options.libraryDir?.length ? options.libraryDir : undefined;
  const runner = createRunner("mthds-cli", options.runner, libraryDirs);

  if (isPipelexRunner(runner)) {
    p.log.step("Building via pipelex...");
    try {
      await runner.buildPassthrough("inputs", extractPassthroughArgs("build", 2));
      p.outro("Done");
    } catch (err) {
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }
    return;
  }

  p.log.error(
    "Method target is not yet supported for the API runner. Use 'mthds build inputs pipe <target>' instead.\nYou can also specify a different runner with --runner <name>, or change the default with 'mthds runner set-default <name>'.",
  );
  p.outro("");
  process.exit(1);
}

// ── mthds build inputs pipe <target> ─────────────────────────────────

export async function buildInputsPipe(
  target: string,
  options: { pipe?: string; format?: string; explicit?: boolean } & WithRunner,
): Promise<void> {
  printLogo();
  p.intro("mthds build inputs pipe");

  const libraryDirs = options.libraryDir?.length ? options.libraryDir : undefined;
  const runner = createRunner("mthds-cli", options.runner, libraryDirs);

  if (isPipelexRunner(runner)) {
    p.log.step("Building via pipelex...");
    try {
      await runner.buildPassthrough("inputs", extractPassthroughArgs("build", 2));
      p.outro("Done");
    } catch (err) {
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }
    return;
  }

  const format = (options.format ?? "json") as InputsTemplateFormat;
  if (!(INPUTS_TEMPLATE_FORMATS as readonly string[]).includes(format)) {
    p.log.error(
      `Invalid format "${format}". Must be one of: ${INPUTS_TEMPLATE_FORMATS.join(", ")}`,
    );
    p.outro("");
    process.exit(1);
  }
  // Every runner that is not the pipelex one is the API runner, whose `pipeIo` lives
  // on the concrete client rather than on the shared `Runner` interface.
  if (!isApiRunner(runner)) {
    p.log.error("build inputs pipe needs the API runner or the pipelex runner.");
    p.outro("");
    process.exit(1);
  }

  // The bundle file first, then every `.mthds` file of the `-L` directories, so a
  // method split across files gets its template as it does on the pipelex runner.
  let closure: BundleClosure;
  try {
    closure = resolveBundleClosure({ path: target }, options.libraryDir ?? []);
  } catch (err) {
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }

  const s = p.spinner();
  s.start("Generating example inputs...");

  try {
    // The template is projected here from the pipe's input-form descriptor, which
    // `POST /v1/pipe-io` returns, rather than fetched from a build route.
    const result = await runner.pipeIo({
      files: closure.files,
      pipe_ref: options.pipe ?? closureEntryPipeRef(closure),
    });
    if (!reportIfInvalid(s, result)) return;
    const { pipeRef, descriptor } = selectedInputDescriptor(result);
    const rendered = renderInputsTemplate(descriptor, {
      explicit: options.explicit ?? false,
      format,
    });
    s.stop(`Inputs generated for ${pipeRef}.`);
    p.log.info(rendered.length > 0 ? rendered : `# Pipe '${pipeRef}' declares no inputs.`);
    p.outro("Done");
  } catch (err) {
    s.stop("Build failed.");
    p.log.error(formatCliError(err));
    p.outro("");
    process.exit(1);
  }
}
