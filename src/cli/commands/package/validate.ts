import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { printLogo } from "../index.js";
import { parseMethodsToml } from "../../../package/manifest/parser.js";
import { MANIFEST_FILENAME } from "../../../package/discovery.js";
import { ManifestParseError, ManifestValidationError, VCSFetchError } from "../../../package/exceptions.js";
import { addressToCloneUrl, listRemoteVersionTags, resolveVersionFromTags } from "../../../package/vcs-resolver.js";

export async function packageValidate(options: { directory?: string }): Promise<void> {
  printLogo();
  p.intro("mthds package validate");

  const targetDir = resolve(options.directory ?? process.cwd());
  const manifestPath = join(targetDir, MANIFEST_FILENAME);

  if (!existsSync(manifestPath)) {
    p.log.error(`No ${MANIFEST_FILENAME} found in ${targetDir}.`);
    p.outro("");
    process.exitCode = 1;
    return;
  }

  const content = readFileSync(manifestPath, "utf-8");

  let manifest;
  try {
    manifest = parseMethodsToml(content);
  } catch (err) {
    if (err instanceof ManifestParseError) {
      p.log.error(`TOML syntax error: ${err.message}`);
      p.outro("");
      process.exitCode = 1;
      return;
    }
    if (err instanceof ManifestValidationError) {
      p.log.error(`Validation error: ${err.message}`);
      p.outro("");
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  p.log.success(`${MANIFEST_FILENAME} is valid.`);

  // Display all fields
  p.log.info(`  Address:       ${manifest.address}`);
  if (manifest.displayName !== undefined) {
    p.log.info(`  Display name:  ${manifest.displayName}`);
  }
  p.log.info(`  Version:       ${manifest.version}`);
  p.log.info(`  Description:   ${manifest.description}`);
  if (manifest.authors.length > 0) {
    p.log.info(`  Authors:       ${manifest.authors.join(", ")}`);
  }
  if (manifest.license !== undefined) {
    p.log.info(`  License:       ${manifest.license}`);
  }
  if (manifest.mthdsVersion !== undefined) {
    p.log.info(`  MTHDS version: ${manifest.mthdsVersion}`);
  }

  // Display exports
  const exportEntries = Object.entries(manifest.exports);
  if (exportEntries.length > 0) {
    p.log.info(`  Exports:       ${exportEntries.length} domain(s)`);
    for (const [domain, exp] of exportEntries) {
      p.log.info(`    ${domain}: ${exp.pipes.join(", ")}`);
    }
  } else {
    p.log.info(`  Exports:       none`);
  }

  // Check dependencies are accessible
  const depEntries = Object.entries(manifest.dependencies);
  if (depEntries.length > 0) {
    const spinner = p.spinner();
    spinner.start(`Checking ${depEntries.length} dependencies...`);

    let allOk = true;
    const results: Array<{ alias: string; address: string; ok: boolean; detail: string }> = [];

    for (const [alias, dep] of depEntries) {
      if (dep.path !== undefined) {
        // Local dependency — check directory exists
        const localPath = resolve(targetDir, dep.path);
        if (existsSync(localPath)) {
          results.push({ alias, address: dep.address, ok: true, detail: `local (${dep.path})` });
        } else {
          results.push({ alias, address: dep.address, ok: false, detail: `local path not found: ${dep.path}` });
          allOk = false;
        }
        continue;
      }

      // Remote dependency — check git remote is reachable and has matching versions
      const cloneUrl = addressToCloneUrl(dep.address);
      try {
        const tags = await listRemoteVersionTags(cloneUrl);
        if (tags.length === 0) {
          results.push({ alias, address: dep.address, ok: false, detail: "reachable but no version tags found" });
          allOk = false;
          continue;
        }

        try {
          const [resolved] = resolveVersionFromTags(tags, dep.version);
          results.push({ alias, address: dep.address, ok: true, detail: `v${resolved.version} (${dep.version})` });
        } catch {
          const available = tags.map(([v]) => v.version).sort().slice(0, 5).join(", ");
          results.push({ alias, address: dep.address, ok: false, detail: `no version matching '${dep.version}' (available: ${available})` });
          allOk = false;
        }
      } catch (err) {
        const msg = err instanceof VCSFetchError ? err.message : (err as Error).message;
        results.push({ alias, address: dep.address, ok: false, detail: msg });
        allOk = false;
      }
    }

    spinner.stop(allOk ? `All ${depEntries.length} dependencies OK.` : "Dependency check complete.");

    for (const r of results) {
      if (r.ok) {
        p.log.success(`  ${r.alias} -> ${r.address}: ${r.detail}`);
      } else {
        p.log.error(`  ${r.alias} -> ${r.address}: ${r.detail}`);
      }
    }

    if (!allOk) {
      process.exitCode = 1;
    }
  } else {
    p.log.info(`  Dependencies:  none`);
  }

  p.outro("");
}
