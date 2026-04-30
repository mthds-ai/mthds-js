/**
 * Non-interactive agent install command.
 * All choices are required CLI flags — no prompts, no clack.
 */

import { agentSuccess, agentError, AGENT_ERROR_DOMAINS } from "../output.js";
import { parseAddress } from "../../installer/resolver/address.js";
import { resolveFromGitHub } from "../../installer/resolver/github.js";
import { resolveFromLocal } from "../../installer/resolver/local.js";
import { isPipelexInstalled } from "../../installer/runtime/check.js";
import { ensureRuntime } from "../../installer/runtime/installer.js";
import { shutdown } from "../../installer/telemetry/posthog.js";
import { InstallLocation } from "../../installer/methods/types.js";
import { runInstallFlow } from "../../installer/methods/install-flow.js";
import type { InstallFlowResult } from "../../installer/methods/install-flow.js";
import type { ParsedAddress, ResolvedRepo } from "../../package/manifest/types.js";

interface AgentInstallOptions {
  local?: string;
  location?: string;
  method?: string;
  noRunner?: boolean;
}

export async function agentInstall(
  address: string | undefined,
  options: AgentInstallOptions
): Promise<void> {
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

  const selectedLocation = options.location as InstallLocation;
  const methodFilter = options.method;

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
    let parsed: ParsedAddress;
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

  if (methodFilter) {
    const match = resolved.methods.find((method) => method.name === methodFilter);
    if (!match) {
      const available = resolved.methods.map((method) => method.name).join(", ");
      agentError(
        `Method "${methodFilter}" not found. Available methods: ${available || "(none)"}`,
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

  let result: InstallFlowResult;
  try {
    result = runInstallFlow({ resolved, location: selectedLocation, orgRepo });
  } catch (err) {
    agentError(
      `Install failed: ${(err as Error).message}`,
      "InstallError",
      { error_domain: AGENT_ERROR_DOMAINS.INSTALL }
    );
  }

  await shutdown();

  agentSuccess({
    success: true,
    installed_methods: result.installedMethods,
    location: selectedLocation,
    target_dir: result.targetDir,
    shim_dir: result.shimDir,
    shims_generated: result.shimsGenerated,
  });
}
