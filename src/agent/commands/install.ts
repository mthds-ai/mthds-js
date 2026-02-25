/**
 * Non-interactive agent install command.
 * All choices are required CLI flags — no prompts, no clack.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { agentSuccess, agentError, AGENT_ERROR_DOMAINS } from "../output.js";
import { parseAddress } from "../../installer/resolver/address.js";
import { resolveFromGitHub } from "../../installer/resolver/github.js";
import { resolveFromLocal } from "../../installer/resolver/local.js";
import { getAllAgents, getAgentHandler } from "../../installer/agents/registry.js";
import { isPipelexInstalled } from "../../installer/runtime/check.js";
import { ensureRuntime } from "../../installer/runtime/installer.js";
import { trackInstall, shutdown } from "../../installer/telemetry/posthog.js";
import { InstallLocation as Loc } from "../../installer/agents/types.js";
import type { Agent, InstallLocation } from "../../installer/agents/types.js";
import type { ResolvedRepo } from "../../package/manifest/types.js";

const execAsync = promisify(exec);

interface AgentInstallOptions {
  local?: string;
  agent?: string;
  location?: string;
  method?: string;
  skills?: boolean;
  noRunner?: boolean;
}

export async function agentInstall(
  address: string | undefined,
  options: AgentInstallOptions
): Promise<void> {
  // Validate required flags
  if (!options.agent) {
    agentError("--agent is required", "ArgumentError", {
      error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
    });
  }

  if (!options.location) {
    agentError("--location is required (local or global)", "ArgumentError", {
      error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
    });
  }

  if (options.location !== "local" && options.location !== "global") {
    agentError(
      `Invalid location: ${options.location}. Must be "local" or "global".`,
      "ArgumentError",
      { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT }
    );
  }

  // Validate agent ID
  const agents = getAllAgents();
  const validAgentIds = agents.map((a) => a.id);
  if (!validAgentIds.includes(options.agent as Agent)) {
    agentError(
      `Unknown agent: ${options.agent}. Valid agents: ${validAgentIds.join(", ")}`,
      "ArgumentError",
      { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT }
    );
  }

  if (address && options.local) {
    agentError(
      "Cannot use both an address and --local at the same time.",
      "ArgumentError",
      { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT }
    );
  }

  if (!address && !options.local) {
    agentError(
      "Provide an address (org/repo) or use --local <path>.",
      "ArgumentError",
      { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT }
    );
  }

  const selectedAgent = options.agent as Agent;
  const selectedLocation = options.location as InstallLocation;
  const methodFilter = options.method;

  // Resolve repo
  let resolved: ResolvedRepo;
  let orgRepo: string | undefined;

  if (options.local) {
    try {
      resolved = resolveFromLocal(options.local);
    } catch (err) {
      agentError(
        `Failed to resolve local methods: ${(err as Error).message}`,
        "InstallError",
        { error_domain: AGENT_ERROR_DOMAINS.INSTALL }
      );
    }
    if (resolved.methods.length > 0) {
      const addr = resolved.methods[0]!.manifest.package.address;
      orgRepo = addr.replace(/^github\.com\//, "");
    }
  } else if (address) {
    let parsed;
    try {
      parsed = parseAddress(address);
    } catch (err) {
      agentError((err as Error).message, "InstallError", {
        error_domain: AGENT_ERROR_DOMAINS.INSTALL,
      });
    }

    try {
      resolved = await resolveFromGitHub(parsed);
    } catch (err) {
      agentError(
        `Failed to resolve methods: ${(err as Error).message}`,
        "InstallError",
        { error_domain: AGENT_ERROR_DOMAINS.INSTALL }
      );
    }
    orgRepo = `${parsed.org}/${parsed.repo}`;
  } else {
    // unreachable due to earlier validation
    agentError("No address or local path provided.", "ArgumentError", {
      error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
    });
  }

  // Filter by --method
  if (methodFilter) {
    const match = resolved.methods.find((m) => m.slug === methodFilter);
    if (!match) {
      const available = resolved.methods.map((m) => m.slug).join(", ");
      agentError(
        `Method "${methodFilter}" not found. Available slugs: ${available || "(none)"}`,
        "InstallError",
        { error_domain: AGENT_ERROR_DOMAINS.INSTALL }
      );
    }
    resolved = { ...resolved, methods: [match] };
  }

  if (resolved.methods.length === 0) {
    agentError("No valid methods to install.", "InstallError", {
      error_domain: AGENT_ERROR_DOMAINS.INSTALL,
    });
  }

  // Optional runner install
  if (!options.noRunner) {
    if (!isPipelexInstalled()) {
      try {
        await ensureRuntime();
      } catch (err) {
        agentError(
          `Failed to install pipelex runtime: ${(err as Error).message}`,
          "InstallError",
          { error_domain: AGENT_ERROR_DOMAINS.INSTALL, retryable: true }
        );
      }
    }
  }

  // Determine target directory
  const localDir = join(process.cwd(), ".claude", "methods");
  const globalDir = join(homedir(), ".claude", "methods");
  const targetDir = selectedLocation === Loc.Global ? globalDir : localDir;

  mkdirSync(targetDir, { recursive: true });

  // Telemetry for public GitHub repos
  if (resolved.source === "github" && resolved.isPublic) {
    for (const method of resolved.methods) {
      const pkg = method.manifest.package;
      trackInstall({
        address: orgRepo ?? pkg.address.replace(/^github\.com\//, ""),
        slug: method.slug,
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

  // Install methods
  const handler = getAgentHandler(selectedAgent);
  try {
    await handler.installMethod({
      repo: resolved,
      agent: selectedAgent,
      location: selectedLocation,
      targetDir,
    });
  } catch (err) {
    agentError(
      `Install failed: ${(err as Error).message}`,
      "InstallError",
      { error_domain: AGENT_ERROR_DOMAINS.INSTALL }
    );
  }

  // Optional skills install
  const installedSkills: string[] = [];
  if (options.skills) {
    const SKILLS_REPO = "https://github.com/mthds-ai/skills";
    const globalFlag = selectedLocation === Loc.Global ? " -g" : "";

    try {
      await execAsync(
        `npx skills add ${SKILLS_REPO} --skill '*' --agent ${selectedAgent}${globalFlag} -y`,
        { cwd: process.cwd() }
      );
      installedSkills.push("*");
    } catch {
      // Skills install failures are non-fatal
    }
  }

  await shutdown();

  agentSuccess({
    success: true,
    installed_methods: resolved.methods.map((m) => m.slug),
    location: selectedLocation,
    target_dir: targetDir,
    installed_skills: installedSkills,
  });
}
