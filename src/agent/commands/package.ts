/**
 * Agent package commands — manage METHODS.toml with JSON output.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { agentSuccess, agentError, AGENT_ERROR_DOMAINS } from "../output.js";
import { parseMethodsToml, serializeManifestToToml } from "../../package/manifest/parser.js";
import { isValidAddress, isValidSemver, isValidMethodName, MTHDS_STANDARD_VERSION } from "../../package/manifest/schema.js";
import { isPipeCodeValid } from "../../package/manifest/validation.js";
import { MANIFEST_FILENAME } from "../../package/discovery.js";
import { ManifestParseError, ManifestValidationError } from "../../package/exceptions.js";
import type { ParsedManifest } from "../../package/manifest/schema.js";

// ── Helpers ─────────────────────────────────────────────────────────

function manifestToJson(manifest: ParsedManifest): Record<string, unknown> {
  const result: Record<string, unknown> = {
    address: manifest.address,
    version: manifest.version,
    description: manifest.description,
    authors: manifest.authors,
    exports: manifest.exports,
  };
  if (manifest.name !== undefined) result.name = manifest.name;
  if (manifest.displayName !== undefined) result.display_name = manifest.displayName;
  if (manifest.license !== undefined) result.license = manifest.license;
  if (manifest.mthdsVersion !== undefined) result.mthds_version = manifest.mthdsVersion;
  if (manifest.mainPipe !== undefined) result.main_pipe = manifest.mainPipe;
  return result;
}

function resolveManifestPath(directory?: string): string {
  const targetDir = resolve(directory ?? process.cwd());
  return join(targetDir, MANIFEST_FILENAME);
}

// ── Init ────────────────────────────────────────────────────────────

export interface AgentPackageInitOptions {
  directory?: string;
  address: string;
  version: string;
  description: string;
  authors?: string;
  license?: string;
  name?: string;
  displayName?: string;
  mainPipe?: string;
  force?: boolean;
}

export async function agentPackageInit(options: AgentPackageInitOptions): Promise<void> {
  const manifestPath = resolveManifestPath(options.directory);

  if (!isValidAddress(options.address)) {
    agentError(
      `Invalid package address '${options.address}'. Must follow hostname/path pattern (e.g. 'github.com/org/repo').`,
      "PackageError",
      { error_domain: AGENT_ERROR_DOMAINS.PACKAGE, hint: "Provide a valid address in hostname/path format (e.g. 'github.com/org/repo')." },
    );
  }

  if (!isValidSemver(options.version)) {
    agentError(
      `Invalid version '${options.version}'. Must be valid semver (e.g. '1.0.0').`,
      "PackageError",
      { error_domain: AGENT_ERROR_DOMAINS.PACKAGE, hint: "Provide a valid semver version (e.g. '1.0.0', '0.1.0-beta.1')." },
    );
  }

  if (!options.description.trim()) {
    agentError(
      "Description is required and must be a non-empty string.",
      "PackageError",
      { error_domain: AGENT_ERROR_DOMAINS.PACKAGE, hint: "Provide a non-empty --description value." },
    );
  }

  if (options.name !== undefined && !isValidMethodName(options.name)) {
    agentError(
      `Invalid method name '${options.name}'. Must be 2-25 lowercase chars (letters, digits, hyphens, underscores), starting with a letter.`,
      "PackageError",
      { error_domain: AGENT_ERROR_DOMAINS.PACKAGE, hint: "Provide a valid --name: 2-25 lowercase chars, starting with a letter (e.g. 'my-tool')." },
    );
  }

  if (options.displayName !== undefined) {
    const dn = options.displayName.trim();
    if (!dn) {
      agentError(
        "Display name must not be empty or whitespace when provided.",
        "PackageError",
        { error_domain: AGENT_ERROR_DOMAINS.PACKAGE, hint: "Provide a non-empty --display-name value, or omit the flag." },
      );
    }
    if (dn.length > 128) {
      agentError(
        `Display name must not exceed 128 characters (got ${dn.length}).`,
        "PackageError",
        { error_domain: AGENT_ERROR_DOMAINS.PACKAGE, hint: "Shorten the --display-name to 128 characters or fewer." },
      );
    }
  }

  if (options.mainPipe !== undefined && !isPipeCodeValid(options.mainPipe)) {
    agentError(
      `Invalid main_pipe '${options.mainPipe}'. Must be a valid snake_case pipe code.`,
      "PackageError",
      { error_domain: AGENT_ERROR_DOMAINS.PACKAGE, hint: "Provide a valid --main-pipe in snake_case (e.g. 'extract_data')." },
    );
  }

  if (existsSync(manifestPath) && !options.force) {
    agentError(
      `${MANIFEST_FILENAME} already exists at ${manifestPath}. Use --force to overwrite.`,
      "PackageError",
      { error_domain: AGENT_ERROR_DOMAINS.PACKAGE, hint: "Add --force to overwrite the existing METHODS.toml." },
    );
  }

  const authors = options.authors
    ? options.authors.split(",").map((a) => a.trim()).filter(Boolean)
    : [];

  const manifest: ParsedManifest = {
    address: options.address,
    version: options.version,
    description: options.description.trim(),
    authors,
    exports: {},
    mthdsVersion: `>=${MTHDS_STANDARD_VERSION}`,
    ...(options.name ? { name: options.name } : {}),
    ...(options.displayName ? { displayName: options.displayName.trim() } : {}),
    ...(options.license ? { license: options.license } : {}),
    ...(options.mainPipe ? { mainPipe: options.mainPipe } : {}),
  };

  const tomlContent = serializeManifestToToml(manifest);
  try {
    writeFileSync(manifestPath, tomlContent, "utf-8");
  } catch (err) {
    agentError(
      `Failed to write ${MANIFEST_FILENAME}: ${(err as Error).message}`,
      "PackageError",
      { error_domain: AGENT_ERROR_DOMAINS.IO },
    );
  }

  agentSuccess({
    success: true,
    path: manifestPath,
    manifest: manifestToJson(manifest),
  });
}

// ── List ────────────────────────────────────────────────────────────

export interface AgentPackageListOptions {
  directory?: string;
}

export async function agentPackageList(options: AgentPackageListOptions): Promise<void> {
  const manifestPath = resolveManifestPath(options.directory);

  if (!existsSync(manifestPath)) {
    agentError(
      `No ${MANIFEST_FILENAME} found at ${manifestPath}. Run 'mthds-agent package init' first.`,
      "PackageError",
      { error_domain: AGENT_ERROR_DOMAINS.PACKAGE, hint: "Run 'mthds-agent package init' to create a METHODS.toml, or use -C to specify the correct directory." },
    );
  }

  let manifest: ParsedManifest;
  try {
    const content = readFileSync(manifestPath, "utf-8");
    manifest = parseMethodsToml(content);
  } catch (err) {
    if (err instanceof ManifestParseError) {
      agentError(`TOML syntax error: ${err.message}`, "PackageError", {
        error_domain: AGENT_ERROR_DOMAINS.PACKAGE,
        hint: "Fix the TOML syntax in METHODS.toml and try again.",
      });
    }
    if (err instanceof ManifestValidationError) {
      agentError(`Validation error: ${err.message}`, "PackageError", {
        error_domain: AGENT_ERROR_DOMAINS.PACKAGE,
        hint: "Fix the validation errors in METHODS.toml and try again.",
      });
    }
    throw err;
  }

  agentSuccess({
    success: true,
    path: manifestPath,
    manifest: manifestToJson(manifest),
  });
}

// ── Validate ────────────────────────────────────────────────────────

export interface AgentPackageValidateOptions {
  directory?: string;
}

export async function agentPackageValidate(options: AgentPackageValidateOptions): Promise<void> {
  const manifestPath = resolveManifestPath(options.directory);

  if (!existsSync(manifestPath)) {
    agentError(
      `No ${MANIFEST_FILENAME} found at ${manifestPath}.`,
      "PackageError",
      { error_domain: AGENT_ERROR_DOMAINS.PACKAGE, hint: "Run 'mthds-agent package init' to create a METHODS.toml, or use -C to specify the correct directory." },
    );
  }

  const content = readFileSync(manifestPath, "utf-8");

  let manifest: ParsedManifest;
  try {
    manifest = parseMethodsToml(content);
  } catch (err) {
    if (err instanceof ManifestParseError) {
      agentError(`TOML syntax error: ${err.message}`, "PackageError", {
        error_domain: AGENT_ERROR_DOMAINS.PACKAGE,
        hint: "Fix the TOML syntax in METHODS.toml and try again.",
      });
    }
    if (err instanceof ManifestValidationError) {
      agentError(`Validation error: ${err.message}`, "PackageError", {
        error_domain: AGENT_ERROR_DOMAINS.PACKAGE,
        hint: "Fix the validation errors in METHODS.toml and try again.",
      });
    }
    throw err;
  }

  agentSuccess({
    success: true,
    valid: true,
    path: manifestPath,
    manifest: manifestToJson(manifest),
  });
}
