import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { printLogo } from "../index.js";
import { parseMethodsToml } from "../../../package/manifest/parser.js";
import { MANIFEST_FILENAME } from "../../../package/discovery.js";
import { ManifestError } from "../../../package/exceptions.js";

export async function packageUpdate(options: { directory?: string }): Promise<void> {
  printLogo();
  p.intro("mthds package update");

  const targetDir = resolve(options.directory ?? process.cwd());
  const manifestPath = join(targetDir, MANIFEST_FILENAME);

  if (!existsSync(manifestPath)) {
    p.log.error(`No ${MANIFEST_FILENAME} found in ${targetDir}. Run 'mthds package init' first.`);
    p.outro("");
    return;
  }

  try {
    const content = readFileSync(manifestPath, "utf-8");
    parseMethodsToml(content);
  } catch (err) {
    if (err instanceof ManifestError) {
      p.log.error(`Invalid ${MANIFEST_FILENAME}: ${err.message}`);
      p.outro("");
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // Dependencies are not supported in this version
  p.log.info("No dependencies to update.");
  p.outro("");
}
