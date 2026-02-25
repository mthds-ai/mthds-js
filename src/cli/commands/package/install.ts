import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { printLogo } from "../index.js";
import { parseLockFile, verifyLockFile, LOCK_FILENAME } from "../../../package/lock-file.js";
import { isCached, storeInCache } from "../../../package/package-cache.js";
import { addressToCloneUrl, cloneAtVersion, listRemoteVersionTags } from "../../../package/vcs-resolver.js";
import { LockFileError, IntegrityError, MthdsPackageError } from "../../../package/exceptions.js";

export async function packageInstall(options: { directory?: string }): Promise<void> {
  printLogo();
  p.intro("mthds package install");

  const targetDir = resolve(options.directory ?? process.cwd());
  const lockPath = join(targetDir, LOCK_FILENAME);

  if (!existsSync(lockPath)) {
    p.log.error(`No ${LOCK_FILENAME} found in ${targetDir}. Run 'mthds package lock' first.`);
    p.outro("");
    return;
  }

  let lockFile;
  try {
    const content = readFileSync(lockPath, "utf-8");
    lockFile = parseLockFile(content);
  } catch (err) {
    if (err instanceof LockFileError) {
      p.log.error(`Invalid ${LOCK_FILENAME}: ${err.message}`);
      p.outro("");
      return;
    }
    throw err;
  }

  const entries = Object.entries(lockFile.packages);
  if (entries.length === 0) {
    p.log.info("No packages to install.");
    p.outro("");
    return;
  }

  const spinner = p.spinner();
  spinner.start(`Installing ${entries.length} packages...`);

  let installed = 0;
  let cached = 0;
  let spinnerStopped = false;

  try {
    for (const [address, locked] of entries) {
      if (isCached(address, locked.version)) {
        cached++;
        continue;
      }

      // Fetch and cache
      const cloneUrl = addressToCloneUrl(address);
      const tmpDir = mkdtempSync(join(tmpdir(), "mthds_install_"));
      try {
        // Find the tag matching this version
        const tags = await listRemoteVersionTags(cloneUrl);
        const matchingTag = tags.find(([ver]) => ver.version === locked.version);
        const tagName = matchingTag ? matchingTag[1] : `v${locked.version}`;

        const cloneDest = join(tmpDir, "pkg");
        await cloneAtVersion(cloneUrl, tagName, cloneDest);
        storeInCache(cloneDest, address, locked.version);
        installed++;
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }

    spinner.stop(`Done. ${installed} installed, ${cached} already cached.`);
    spinnerStopped = true;

    // Verify integrity
    try {
      verifyLockFile(lockFile);
      p.log.success("All packages verified.");
    } catch (err) {
      if (err instanceof IntegrityError) {
        p.log.error(`Integrity check failed: ${err.message}`);
        p.outro("");
        return;
      }
      throw err;
    }
  } catch (err) {
    if (!spinnerStopped) {
      spinner.stop("Installation failed.");
    }
    if (err instanceof MthdsPackageError) {
      p.log.error(err.message);
      p.outro("");
      return;
    }
    throw err;
  }

  p.outro("");
}
