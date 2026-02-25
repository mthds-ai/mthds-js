import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { printLogo } from "../index.js";
import { parseMethodsToml } from "../../../package/manifest/parser.js";
import { MANIFEST_FILENAME } from "../../../package/discovery.js";
import { ManifestError } from "../../../package/exceptions.js";

export function packageList(options: { directory?: string }): void {
  printLogo();
  p.intro("mthds package list");

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

  // Display package info
  p.log.info(`Package: ${manifest.address}`);
  p.log.info(`Version: ${manifest.version}`);
  p.log.info(`Description: ${manifest.description}`);

  if (manifest.displayName) {
    p.log.info(`Display Name: ${manifest.displayName}`);
  }
  if (manifest.authors.length > 0) {
    p.log.info(`Authors: ${manifest.authors.join(", ")}`);
  }
  if (manifest.license) {
    p.log.info(`License: ${manifest.license}`);
  }
  if (manifest.mthdsVersion) {
    p.log.info(`MTHDS Version: ${manifest.mthdsVersion}`);
  }

  // Exports
  const exportEntries = Object.entries(manifest.exports);
  if (exportEntries.length > 0) {
    p.log.info("");
    p.log.info(`Exports (${exportEntries.length} domains):`);
    for (const [domain, domainExport] of exportEntries) {
      p.log.info(`  ${domain}: ${domainExport.pipes.join(", ") || "(no pipes)"}`);
    }
  }

  p.outro("");
}
