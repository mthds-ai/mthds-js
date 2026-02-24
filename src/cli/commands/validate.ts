import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import { createRunner } from "../../runners/registry.js";
import type { RunnerType } from "../../runners/types.js";

export async function validateBundle(
  target: string,
  options: {
    pipe?: string;
    bundle?: string;
    runner?: RunnerType;
    directory?: string;
  }
): Promise<void> {
  printLogo();
  p.intro("mthds validate");

  const libraryDirs = options.directory
    ? [resolve(options.directory)]
    : undefined;
  const runner = createRunner(options.runner, libraryDirs);

  // Resolve the bundle content from either the positional target or --bundle
  const bundlePath = options.bundle ?? (target.endsWith(".mthds") ? target : undefined);

  if (!bundlePath) {
    p.log.error(
      "Provide a .mthds bundle file to validate (positional or --bundle)."
    );
    p.outro("");
    process.exit(1);
  }

  const mthdsContent = readFileSync(bundlePath, "utf-8");

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
