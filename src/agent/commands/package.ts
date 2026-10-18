/**
 * Agent package commands — manage METHODS.toml with JSON output.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { agentSuccess, agentError, agentProblem } from "../output.js";
import { fileErrorReason } from "../problems.js";
import { parseMethodsToml, serializeManifestToToml } from "../../package/manifest/parser.js";
import {
  isValidAddress,
  isValidSemver,
  isValidMethodName,
  MTHDS_STANDARD_VERSION,
} from "../../package/manifest/schema.js";
import { isPipeCodeValid } from "../../package/manifest/validation.js";
import { MANIFEST_FILENAME } from "../../package/discovery.js";
import { ManifestParseError, ManifestValidationError } from "../../package/exceptions.js";
import type { ParsedManifest } from "../../package/manifest/schema.js";

// ── Helpers ─────────────────────────────────────────────────────────

function readManifest(manifestPath: string, notFoundMessage: string): ParsedManifest {
  if (!existsSync(manifestPath)) {
    agentError(
      agentProblem(
        "client.file_unreadable",
        { path: manifestPath, reason: "enoent" },
        `${notFoundMessage} Run 'mthds-agent package init' to create a METHODS.toml, or use -C to specify the correct directory.`,
      ),
    );
  }

  try {
    const content = readFileSync(manifestPath, "utf-8");
    return parseMethodsToml(content);
  } catch (err) {
    if (err instanceof ManifestParseError) {
      agentError(
        agentProblem(
          "method.package_invalid",
          { reason: "manifest_syntax" },
          `TOML syntax error: ${err.message}. Fix the TOML syntax in METHODS.toml and try again.`,
          { reader: "actor" },
        ),
      );
    }
    if (err instanceof ManifestValidationError) {
      agentError(
        agentProblem(
          "method.package_invalid",
          { reason: "manifest_invalid" },
          `Validation error: ${err.message}. Fix the validation errors in METHODS.toml and try again.`,
          { reader: "actor" },
        ),
      );
    }
    throw err;
  }
}

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
      agentProblem(
        "client.argument_invalid",
        { argument: "--address", reason: "invalid_address" },
        `Invalid package address '${options.address}'. Must follow hostname/path pattern (e.g. 'github.com/org/repo').`,
      ),
    );
  }

  if (!isValidSemver(options.version)) {
    agentError(
      agentProblem(
        "client.argument_invalid",
        { argument: "--version", reason: "invalid_semver" },
        `Invalid version '${options.version}'. Must be valid semver (e.g. '1.0.0'). Provide a valid semver version (e.g. '1.0.0', '0.1.0-beta.1').`,
      ),
    );
  }

  if (!options.description.trim()) {
    agentError(
      agentProblem(
        "client.argument_invalid",
        { argument: "--description", reason: "empty" },
        "Description is required and must be a non-empty string. Provide a non-empty --description value.",
      ),
    );
  }

  if (options.name !== undefined && !isValidMethodName(options.name)) {
    agentError(
      agentProblem(
        "client.argument_invalid",
        { argument: "--name", reason: "invalid_name" },
        `Invalid method name '${options.name}'. Must be 2-25 lowercase snake_case chars (letters, digits, underscores), starting with a letter. Provide a valid --name: 2-25 lowercase snake_case chars, starting with a letter (e.g. 'my_tool').`,
      ),
    );
  }

  if (options.displayName !== undefined) {
    const dn = options.displayName.trim();
    if (!dn) {
      agentError(
        agentProblem(
          "client.argument_invalid",
          { argument: "--display-name", reason: "empty" },
          "Display name must not be empty or whitespace when provided. Provide a non-empty --display-name value, or omit the flag.",
        ),
      );
    }
    if (dn.length > 128) {
      agentError(
        agentProblem(
          "client.argument_invalid",
          { argument: "--display-name", reason: "too_long" },
          `Display name must not exceed 128 characters (got ${dn.length}). Shorten the --display-name to 128 characters or fewer.`,
        ),
      );
    }
  }

  if (options.mainPipe !== undefined && !isPipeCodeValid(options.mainPipe)) {
    agentError(
      agentProblem(
        "client.argument_invalid",
        { argument: "--main-pipe", reason: "invalid_pipe_code" },
        `Invalid main_pipe '${options.mainPipe}'. Must be a valid snake_case pipe code. Provide a valid --main-pipe in snake_case (e.g. 'extract_data').`,
      ),
    );
  }

  if (existsSync(manifestPath) && !options.force) {
    agentError(
      agentProblem(
        "client.target_exists",
        { path: manifestPath },
        `${MANIFEST_FILENAME} already exists at ${manifestPath}. Use --force to overwrite.`,
      ),
    );
  }

  const authors = options.authors
    ? options.authors
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean)
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
      agentProblem(
        "client.write_failed",
        { path: manifestPath, reason: fileErrorReason(err, "unwritable") },
        `Failed to write ${MANIFEST_FILENAME}: ${(err as Error).message}`,
      ),
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
  const manifest = readManifest(
    manifestPath,
    `No ${MANIFEST_FILENAME} found at ${manifestPath}. Run 'mthds-agent package init' first.`,
  );

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
  const manifest = readManifest(manifestPath, `No ${MANIFEST_FILENAME} found at ${manifestPath}.`);

  agentSuccess({
    success: true,
    valid: true,
    path: manifestPath,
    manifest: manifestToJson(manifest),
  });
}
