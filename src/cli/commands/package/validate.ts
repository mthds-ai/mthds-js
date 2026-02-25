import * as p from "@clack/prompts";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { printLogo } from "../index.js";
import { parseMethodsToml } from "../../../package/manifest/parser.js";
import { MANIFEST_FILENAME } from "../../../package/discovery.js";
import { ManifestParseError, ManifestValidationError } from "../../../package/exceptions.js";

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
  if (manifest.name !== undefined) {
    p.log.info(`  Name:          ${manifest.name}`);
  }
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
  if (manifest.mainPipe !== undefined) {
    p.log.info(`  Main pipe:     ${manifest.mainPipe}`);
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

  p.log.info(`  Dependencies:  none`);

  p.outro("");
}
