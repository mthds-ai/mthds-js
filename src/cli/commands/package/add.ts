import * as p from "@clack/prompts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { printLogo } from "../index.js";
import { parseMethodsToml, serializeManifestToToml } from "../../../package/manifest/parser.js";
import { MANIFEST_FILENAME } from "../../../package/discovery.js";
import { isValidAddress, isValidVersionConstraint } from "../../../package/manifest/schema.js";
import { ManifestError } from "../../../package/exceptions.js";
import { isSnakeCase } from "../../../package/manifest/validation.js";

export function packageAdd(
  dep: string,
  options: { directory?: string; alias?: string; version?: string; path?: string },
): void {
  printLogo();
  p.intro("mthds package add");

  const targetDir = resolve(options.directory ?? process.cwd());
  const manifestPath = join(targetDir, MANIFEST_FILENAME);

  if (!existsSync(manifestPath)) {
    p.log.error(`No ${MANIFEST_FILENAME} found in ${targetDir}. Run 'mthds package init' first.`);
    p.outro("");
    return;
  }

  // Validate the address
  if (!isValidAddress(dep)) {
    p.log.error(
      `Invalid address '${dep}'. Must follow hostname/path pattern (e.g. github.com/org/repo).`,
    );
    p.outro("");
    return;
  }

  // Validate local path if provided
  if (options.path !== undefined) {
    const resolvedPath = resolve(targetDir, options.path);
    if (!existsSync(resolvedPath)) {
      p.log.error(`Local path '${options.path}' resolves to '${resolvedPath}' which does not exist.`);
      p.outro("");
      return;
    }
  }

  // Determine alias
  const alias = options.alias ?? dep.split("/").pop()!.replace(/\.git$/, "").replace(/-/g, "_");
  if (!isSnakeCase(alias)) {
    p.log.error(
      `Derived alias '${alias}' is not snake_case. Use --alias to specify a valid alias.`,
    );
    p.outro("");
    return;
  }

  // Determine version constraint
  const versionConstraint = options.version ?? "*";
  if (!isValidVersionConstraint(versionConstraint)) {
    p.log.error(`Invalid version constraint '${versionConstraint}'.`);
    p.outro("");
    return;
  }

  // Parse existing manifest
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

  // Check for existing dependency
  if (alias in manifest.dependencies) {
    p.log.warning(`Dependency '${alias}' already exists. Updating.`);
  }

  // Add/update dependency
  const updatedDeps = { ...manifest.dependencies };
  updatedDeps[alias] = {
    address: dep,
    version: versionConstraint,
    ...(options.path !== undefined ? { path: options.path } : {}),
  };

  const updatedManifest = { ...manifest, dependencies: updatedDeps };
  const tomlContent = serializeManifestToToml(updatedManifest);
  writeFileSync(manifestPath, tomlContent, "utf-8");

  const pathNote = options.path ? ` (local: ${options.path})` : "";
  p.log.success(`Added dependency '${alias}' -> ${dep} ${versionConstraint}${pathNote}`);
  p.outro("");
}
