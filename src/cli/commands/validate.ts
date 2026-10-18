import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import { isPipelexRunner, isApiRunner, extractPassthroughArgs } from "./utils.js";
import { formatCliError, formatItemLines, verdictSummary } from "./error-output.js";
import { createRunner } from "../../runners/registry.js";
import { resolveMethodTarget } from "../../runners/method-target.js";
import type { ResolvedMethodTarget } from "../../runners/method-target.js";
import type { RunnerType } from "../../runners/types.js";

interface ValidateOptions {
  pipe?: string;
  bundle?: string;
  runner?: RunnerType;
  libraryDir?: string[];
}

async function validateWithPipelexPassthrough(
  introLabel: string,
  fallbackMsg: string,
  options: ValidateOptions,
): Promise<void> {
  printLogo();
  p.intro(introLabel);

  const libraryDirs = options.libraryDir?.length ? options.libraryDir : undefined;
  const runner = createRunner("mthds-cli", options.runner, libraryDirs);

  if (isPipelexRunner(runner)) {
    p.log.step("Validating via pipelex...");
    try {
      await runner.validatePassthrough(extractPassthroughArgs("validate", 1));
      p.outro("Done");
    } catch (err) {
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }
    return;
  }

  p.log.error(fallbackMsg);
  p.outro("");
  process.exit(1);
}

export async function validateMethod(_target: string, options: ValidateOptions): Promise<void> {
  return validateWithPipelexPassthrough(
    "mthds validate method",
    "Method target is not yet supported for the API runner. Use 'mthds validate pipe <target>' instead.\nYou can also specify a different runner with --runner <name>, or change the default with 'mthds runner set-default <name>'.",
    options,
  );
}

export async function validateBundle(_target: string, options: ValidateOptions): Promise<void> {
  return validateWithPipelexPassthrough(
    "mthds validate bundle",
    "Bundle target is only supported with the pipelex runner.\nYou can specify a different runner with --runner <name>, or change the default with 'mthds runner set-default <name>'.",
    options,
  );
}

export async function validatePipe(target: string, options: ValidateOptions): Promise<void> {
  printLogo();
  p.intro("mthds validate pipe");

  const libraryDirs = options.libraryDir?.length ? options.libraryDir : undefined;
  const runner = createRunner("mthds-cli", options.runner, libraryDirs);

  if (isPipelexRunner(runner)) {
    p.log.step("Validating via pipelex...");
    try {
      // The pipelex CLI dispatches `validate pipe <code>` vs
      // `validate bundle <path>` — map a file target onto the bundle
      // subcommand (the user-facing `mthds validate pipe` accepts both).
      const isBundlePath = target.endsWith(".mthds") || existsSync(target);
      const passthrough = extractPassthroughArgs("validate", 2);
      await runner.validatePassthrough([isBundlePath ? "bundle" : "pipe", ...passthrough]);
      p.outro("Done");
    } catch (err) {
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }
    return;
  }

  // Resolve the bundle content from either the positional target or --bundle
  const bundlePath = options.bundle ?? (target.endsWith(".mthds") ? target : undefined);

  if (!bundlePath) {
    p.log.error("Provide a .mthds bundle file to validate (positional or --bundle).");
    p.outro("");
    process.exit(1);
  }

  if (options.pipe) {
    p.log.warning("--pipe is not yet supported by the API runner and will be ignored.");
  }

  // The bundle's method tree, with the `-L` directories that belong to it, so a
  // method split across files validates as it does on the pipelex runner, and its
  // Python, templates and other files are judged with it.
  let resolved: ResolvedMethodTarget;
  try {
    const limits = isApiRunner(runner) ? await runner.methodTreeLimits() : {};
    resolved = await resolveMethodTarget({ path: bundlePath }, options.libraryDir ?? [], limits);
  } catch (err) {
    p.log.error(formatCliError(err));
    p.outro("");
    process.exit(1);
  }

  const s = p.spinner();
  s.start("Validating...");

  try {
    const report = await runner.validate(resolved.method);
    if (report.is_valid === false) {
      // A produced "invalid" verdict (the 200 InvalidReport arm) — report the
      // diagnostics and exit non-zero, rather than mistaking a 200 for success.
      s.stop("Validation failed.");
      p.log.error(verdictSummary(report.message));
      for (const item of report.errors) {
        // The runner names each item's file by its tree path; fall back to the
        // path the user passed so a diagnostic always names its file.
        const located =
          item.location?.file === undefined
            ? { ...item, location: { ...item.location, file: bundlePath } }
            : item;
        p.log.error(formatItemLines(located).join("\n"));
      }
      p.outro("");
      process.exit(1);
    }
    s.stop("Validation passed.");
    p.log.success("MTHDS content validated successfully");
    p.outro("Done");
  } catch (err) {
    // A no-verdict condition (a local CLI runner raising, or a transport fault).
    s.stop("Validation failed.");
    p.log.error(formatCliError(err));
    p.outro("");
    process.exit(1);
  }
}
