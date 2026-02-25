import * as p from "@clack/prompts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { printLogo } from "../index.js";
import { parseMethodsToml } from "../../../package/manifest/parser.js";
import { MANIFEST_FILENAME } from "../../../package/discovery.js";
import { resolveAllDependencies } from "../../../package/dependency-resolver.js";
import { generateLockFile, serializeLockFile, LOCK_FILENAME } from "../../../package/lock-file.js";
import { ManifestError, MthdsPackageError } from "../../../package/exceptions.js";

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

  let manifest;
  try {
    const content = readFileSync(manifestPath, "utf-8");
    manifest = parseMethodsToml(content);
  } catch (err) {
    if (err instanceof ManifestError) {
      p.log.error(`Invalid ${MANIFEST_FILENAME}: ${err.message}`);
      p.outro("");
      return;
    }
    throw err;
  }

  const depCount = Object.keys(manifest.dependencies).length;
  if (depCount === 0) {
    p.log.info("No dependencies to resolve.");
    writeFileSync(join(targetDir, LOCK_FILENAME), "", "utf-8");
    p.log.success(`Wrote ${LOCK_FILENAME} (empty).`);
    p.outro("");
    return;
  }

  const spinner = p.spinner();
  spinner.start(`Resolving ${depCount} dependencies...`);

  try {
    const resolved = await resolveAllDependencies(manifest, targetDir);
    spinner.stop(`Resolved ${resolved.length} dependencies.`);

    const lockFile = generateLockFile(manifest, resolved.map((dep) => ({
      alias: dep.alias,
      address: dep.address,
      manifest: dep.manifest,
      packageRoot: dep.packageRoot,
    })));

    const lockContent = serializeLockFile(lockFile);
    writeFileSync(join(targetDir, LOCK_FILENAME), lockContent, "utf-8");

    const lockCount = Object.keys(lockFile.packages).length;
    p.log.success(`Wrote ${LOCK_FILENAME} with ${lockCount} locked packages.`);
  } catch (err) {
    spinner.stop("Resolution failed.");
    if (err instanceof MthdsPackageError) {
      p.log.error(err.message);
      p.outro("");
      return;
    }
    throw err;
  }

  p.outro("");
}
