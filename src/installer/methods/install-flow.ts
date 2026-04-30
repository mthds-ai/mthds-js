import { join } from "node:path";
import { homedir } from "node:os";
import { trackInstall } from "../telemetry/posthog.js";
import { writeMethodFiles } from "./writer.js";
import { InstallLocation } from "./types.js";
import type { ResolvedRepo } from "../../package/manifest/types.js";

export interface InstallFlowInput {
  readonly resolved: ResolvedRepo;
  readonly location: InstallLocation;
  readonly orgRepo?: string;
}

export interface InstallFlowResult {
  readonly targetDir: string;
  readonly installedMethods: string[];
  readonly shimDir: string;
  readonly shimsGenerated: string[];
}

/**
 * Shared install flow used by both `mthds install` (interactive) and
 * `mthds-agent install` (non-interactive JSON). Handles target-dir
 * computation, telemetry, file writes, and shim generation.
 *
 * The on-disk layout is agent-agnostic — methods always go under
 * `.mthds/methods/` (project-local) or `~/.mthds/methods/` (global).
 *
 * Resolution, runner setup, validation, and prompts/output formatting are
 * the caller's responsibility.
 */
export function runInstallFlow(input: InstallFlowInput): InstallFlowResult {
  const { resolved, location, orgRepo } = input;

  const localDir = join(process.cwd(), ".mthds", "methods");
  const globalDir = join(homedir(), ".mthds", "methods");
  const targetDir = location === InstallLocation.Global ? globalDir : localDir;

  if (resolved.source === "github" && resolved.isPublic) {
    for (const method of resolved.methods) {
      const pkg = method.manifest.package;
      trackInstall({
        address: orgRepo ?? pkg.address.replace(/^github\.com\//, ""),
        name: pkg.name,
        main_pipe: pkg.main_pipe,
        version: pkg.version,
        description: pkg.description,
        display_name: pkg.display_name,
        authors: pkg.authors,
        license: pkg.license,
        mthds_version: pkg.mthds_version,
        exports: method.manifest.exports,
        manifest_raw: method.rawManifest,
      });
    }
  }

  writeMethodFiles(resolved, targetDir);

  // writeMethodFiles always generates a shim per method (creating ~/.mthds/bin
  // if needed), so installed methods and generated shims are the same set.
  const installedNames = resolved.methods.map((method) => method.name);

  return {
    targetDir,
    installedMethods: installedNames,
    shimDir: join(homedir(), ".mthds", "bin"),
    shimsGenerated: installedNames,
  };
}
