import { readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import { createRunner } from "../runners/registry.js";
import type { RunnerType } from "../runners/types.js";

export async function validatePlx(
  target: string,
  options: { pipe?: string; bundle?: string; runner?: RunnerType }
): Promise<void> {
  printLogo();
  p.intro("mthds validate");

  const runner = createRunner(options.runner);

  // Resolve the PLX content from either the positional target or --bundle
  const bundlePath = options.bundle ?? (target.endsWith(".plx") ? target : undefined);

  if (!bundlePath) {
    p.log.error(
      "Provide a .plx bundle file to validate (positional or --bundle)."
    );
    p.outro("");
    process.exit(1);
  }

  const plxContent = readFileSync(bundlePath, "utf-8");

  const s = p.spinner();
  s.start("Validating...");

  try {
    const result = await runner.validate({ plx_content: plxContent });

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
