import { existsSync, readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import { isPipelexRunner, isApiRunner, extractPassthroughArgs } from "./utils.js";
import { createRunner } from "../../runners/registry.js";
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
  const runner = createRunner(options.runner, libraryDirs);

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
  const runner = createRunner(options.runner, libraryDirs);

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

  let mthdsContent: string;
  try {
    mthdsContent = readFileSync(bundlePath, "utf-8");
  } catch (err) {
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }

  const s = p.spinner();
  s.start("Validating...");

  try {
    // Name the submitted file so cross-file diagnostics resolve the owning file.
    // `mthds_sources` is a Pipelex-API extension carried only by the concrete
    // client (not the pure protocol) — reach it through `isApiRunner`.
    const report = isApiRunner(runner)
      ? await runner.validate([mthdsContent], false, [bundlePath])
      : await runner.validate([mthdsContent]);
    if (report.is_valid === false) {
      // A produced "invalid" verdict (the 200 InvalidReport arm) — report the
      // diagnostics and exit non-zero, rather than mistaking a 200 for success.
      s.stop("Validation failed.");
      p.log.error(report.message);
      for (const item of report.validation_errors) {
        // The server attributes `source` from `mthds_sources`; fall back to the
        // path the user passed so a diagnostic always names its file.
        const source = (item as { source?: string }).source ?? bundlePath;
        p.log.error(`${source}: [${item.category}] ${item.message}`);
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
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }
}
