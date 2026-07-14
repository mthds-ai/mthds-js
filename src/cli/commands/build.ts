import { basename } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import { isPipelexRunner, extractPassthroughArgs } from "./utils.js";
import { createRunner } from "../../runners/registry.js";
import type {
  ConceptRepresentationFormat,
  CrateInvalidReport,
  InputsTemplateFormat,
  MthdsFileItem,
  RunnerType,
} from "../../runners/types.js";

interface WithRunner {
  runner?: RunnerType;
  libraryDir?: string[];
}

/**
 * Read a bundle into a `/v1/build/*` file item, labelled with its own filename so
 * any diagnostic the server raises points back at the file the user named.
 */
function readBundleFile(target: string): MthdsFileItem {
  return { content: readFileSync(target, "utf-8"), source: basename(target) };
}

/**
 * Render an invalid-closure VERDICT (the `is_valid: false` arm) and exit non-zero.
 *
 * The build routes answer a bad closure with a 200 carrying diagnostics, not an
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
    p.log.error(where ? `${where}: ${item.message}` : item.message);
  }
  p.outro("");
  process.exit(1);
}

// ── mthds build runner method <name> ─────────────────────────────────

export async function buildRunnerMethod(
  _name: string,
  options: { pipe?: string; output?: string } & WithRunner,
): Promise<void> {
  printLogo();
  p.intro("mthds build runner method");

  const libraryDirs = options.libraryDir?.length ? options.libraryDir : undefined;
  const runner = createRunner(options.runner, libraryDirs);

  if (isPipelexRunner(runner)) {
    p.log.step("Building via pipelex...");
    try {
      await runner.buildPassthrough("runner", extractPassthroughArgs("build", 2));
      p.outro("Done");
    } catch (err) {
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }
    return;
  }

  p.log.error(
    "Method target is not yet supported for the API runner. Use 'mthds build runner pipe <target>' instead.\nYou can also specify a different runner with --runner <name>, or change the default with 'mthds runner set-default <name>'.",
  );
  p.outro("");
  process.exit(1);
}

// ── mthds build runner pipe <target> ─────────────────────────────────

export async function buildRunnerPipe(
  target: string,
  options: { pipe?: string; output?: string } & WithRunner,
): Promise<void> {
  printLogo();
  p.intro("mthds build runner pipe");

  const libraryDirs = options.libraryDir?.length ? options.libraryDir : undefined;
  const runner = createRunner(options.runner, libraryDirs);

  if (isPipelexRunner(runner)) {
    p.log.step("Building via pipelex...");
    try {
      await runner.buildPassthrough("runner", extractPassthroughArgs("build", 2));
      p.outro("Done");
    } catch (err) {
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }
    return;
  }

  if (!target.endsWith(".mthds")) {
    p.log.error("build runner requires a .mthds bundle file. Pass the bundle path as the target.");
    p.outro("");
    process.exit(1);
  }

  const s = p.spinner();
  s.start("Generating runner code...");

  try {
    const result = await runner.buildRunner({
      files: [readBundleFile(target)],
      pipe_ref: options.pipe,
    });
    if (!reportIfInvalid(s, result)) return;
    s.stop(result.message);

    if (options.output) {
      writeFileSync(options.output, result.python_code, "utf-8");
      p.log.success(`Runner written to ${options.output}`);
    } else {
      p.log.info(result.python_code);
    }

    p.outro("Done");
  } catch (err) {
    s.stop("Build failed.");
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }
}

// ── mthds build inputs method <name> ─────────────────────────────────

export async function buildInputsMethod(
  _name: string,
  options: { pipe?: string } & WithRunner,
): Promise<void> {
  printLogo();
  p.intro("mthds build inputs method");

  const libraryDirs = options.libraryDir?.length ? options.libraryDir : undefined;
  const runner = createRunner(options.runner, libraryDirs);

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
  const runner = createRunner(options.runner, libraryDirs);

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

  const validFormats: InputsTemplateFormat[] = ["json", "toml"];
  const format = (options.format ?? "json") as InputsTemplateFormat;
  if (!validFormats.includes(format)) {
    p.log.error(`Invalid format "${format}". Must be one of: ${validFormats.join(", ")}`);
    p.outro("");
    process.exit(1);
  }

  let file: MthdsFileItem;
  try {
    file = readBundleFile(target);
  } catch (err) {
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }

  const s = p.spinner();
  s.start("Generating example inputs...");

  try {
    const result = await runner.buildInputs({
      files: [file],
      pipe_ref: options.pipe,
      format,
      explicit: options.explicit ?? false,
    });
    if (!reportIfInvalid(s, result)) return;
    s.stop(`Inputs generated for ${result.pipe_ref}.`);
    // The template rides the field its `format` names — print it as the caller
    // asked for it, not as a re-encoded blob.
    p.log.info(
      result.format === "toml"
        ? (result.inputs_toml ?? "")
        : JSON.stringify(result.inputs, null, 2),
    );
    p.outro("Done");
  } catch (err) {
    s.stop("Build failed.");
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }
}

// ── mthds build output method <name> ─────────────────────────────────

export async function buildOutputMethod(
  _name: string,
  options: { pipe?: string; format?: string } & WithRunner,
): Promise<void> {
  printLogo();
  p.intro("mthds build output method");

  const libraryDirs = options.libraryDir?.length ? options.libraryDir : undefined;
  const runner = createRunner(options.runner, libraryDirs);

  if (isPipelexRunner(runner)) {
    p.log.step("Building via pipelex...");
    try {
      await runner.buildPassthrough("output", extractPassthroughArgs("build", 2));
      p.outro("Done");
    } catch (err) {
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }
    return;
  }

  p.log.error(
    "Method target is not yet supported for the API runner. Use 'mthds build output pipe <target>' instead.\nYou can also specify a different runner with --runner <name>, or change the default with 'mthds runner set-default <name>'.",
  );
  p.outro("");
  process.exit(1);
}

// ── mthds build output pipe <target> ─────────────────────────────────

export async function buildOutputPipe(
  target: string,
  options: { pipe?: string; format?: string } & WithRunner,
): Promise<void> {
  printLogo();
  p.intro("mthds build output pipe");

  const libraryDirs = options.libraryDir?.length ? options.libraryDir : undefined;
  const runner = createRunner(options.runner, libraryDirs);

  if (isPipelexRunner(runner)) {
    p.log.step("Building via pipelex...");
    try {
      await runner.buildPassthrough("output", extractPassthroughArgs("build", 2));
      p.outro("Done");
    } catch (err) {
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }
    return;
  }

  const validFormats: ConceptRepresentationFormat[] = ["json", "python", "schema"];
  const format = (options.format ?? "schema") as ConceptRepresentationFormat;
  if (!validFormats.includes(format)) {
    p.log.error(`Invalid format "${format}". Must be one of: ${validFormats.join(", ")}`);
    p.outro("");
    process.exit(1);
  }

  let file: MthdsFileItem;
  try {
    file = readBundleFile(target);
  } catch (err) {
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }

  const s = p.spinner();
  s.start("Generating output schema...");

  try {
    const result = await runner.buildOutput({
      files: [file],
      pipe_ref: options.pipe,
      format,
    });
    if (!reportIfInvalid(s, result)) return;
    s.stop(`Output generated for ${result.pipe_ref}.`);
    // 'python' is source text, the others are objects — print each in its own form.
    p.log.info(
      result.format === "python"
        ? (result.output_python ?? "")
        : JSON.stringify(result.output, null, 2),
    );
    p.outro("Done");
  } catch (err) {
    s.stop("Build failed.");
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }
}
