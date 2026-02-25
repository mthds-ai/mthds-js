import { readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import { isPipelexRunner, extractPassthroughArgs } from "./utils.js";
import { createRunner } from "../../runners/registry.js";
import type { RunnerType } from "../../runners/types.js";

interface ValidateOptions {
  pipe?: string;
  bundle?: string;
  runner?: RunnerType;
  libraryDir?: string[];
}

export async function validateMethod(
  name: string,
  options: ValidateOptions
): Promise<void> {
  printLogo();
  p.intro("mthds validate method");

  const libraryDirs = options.libraryDir?.length
    ? options.libraryDir
    : undefined;
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

  p.log.error("Method target is not yet supported for the API runner. Use 'mthds validate pipe <target>' instead.\nYou can also specify a different runner with --runner <name>, or change the default with 'mthds set-default runner <name>'.");
  p.outro("");
  process.exit(1);
}

export async function validatePipe(
  target: string,
  options: ValidateOptions
): Promise<void> {
  printLogo();
  p.intro("mthds validate pipe");

  const libraryDirs = options.libraryDir?.length
    ? options.libraryDir
    : undefined;
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

  // Resolve the bundle content from either the positional target or --bundle
  const bundlePath = options.bundle ?? (target.endsWith(".mthds") ? target : undefined);

  if (!bundlePath) {
    p.log.error(
      "Provide a .mthds bundle file to validate (positional or --bundle)."
    );
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
    const result = await runner.validate({ mthds_content: mthdsContent });

    if (result.success) {
      s.stop("Validation passed.");
      p.log.success(result.message);
    } else {
      s.stop("Validation failed.");
      p.log.error(result.message);
    }

    p.outro("Done");

    if (!result.success) {
      process.exit(1);
    }
  } catch (err) {
    s.stop("Validation failed.");
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }
}
