import * as p from "@clack/prompts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { printLogo } from "../index.js";
import { parseMethodsToml } from "../../../package/manifest/parser.js";
import { MANIFEST_FILENAME } from "../../../package/discovery.js";
import { LOCK_FILENAME } from "../../../package/lock-file.js";
import { ManifestError } from "../../../package/exceptions.js";

export async function packageLock(options: { directory?: string }): Promise<void> {
  printLogo();
  p.intro("mthds package lock");

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
      return;
    }
    throw err;
  }

  // Dependencies are not supported in this version — write empty lock file
  p.log.info("No dependencies to resolve.");
  writeFileSync(join(targetDir, LOCK_FILENAME), "", "utf-8");
  p.log.success(`Wrote ${LOCK_FILENAME} (empty).`);
  p.outro("");
}
