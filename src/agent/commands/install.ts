/**
 * Non-interactive agent install command.
 * All choices are required CLI flags — no prompts, no clack.
 */

import { agentSuccess, agentError, agentProblem } from "../output.js";
import {
  errorPath,
  fileErrorReason,
  noUsableMethodProblem,
  resolveFailureProblem,
  toolInstallProblem,
  unusableMethodProblem,
} from "../problems.js";
import { parseAddress } from "../../installer/resolver/address.js";
import { resolveFromGitHub } from "../../installer/resolver/github.js";
import { resolveFromLocal } from "../../installer/resolver/local.js";
import { skippedMethodReports } from "../../installer/resolver/skipped.js";
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
  options: AgentInstallOptions,
): Promise<void> {
  if (!options.location) {
    agentError(
      agentProblem(
        "client.argument_invalid",
        { argument: "--location", reason: "missing" },
        "--location is required (local or global)",
      ),
    );
  }

  if (options.location !== "local" && options.location !== "global") {
    agentError(
      agentProblem(
        "client.argument_invalid",
        { argument: "--location", reason: "unknown_value" },
        `Invalid location: ${options.location}. Must be "local" or "global".`,
      ),
    );
  }

  if (address && options.local) {
    agentError(
      agentProblem(
        "client.argument_invalid",
        { argument: "--local", reason: "conflicts_with_address" },
        "Cannot use both an address and --local at the same time.",
      ),
    );
  }

  if (!address && !options.local) {
    agentError(
      agentProblem(
        "client.argument_invalid",
        { argument: "address", reason: "missing" },
        "Provide an address (org/repo) or use --local <path>.",
      ),
    );
  }

  const selectedLocation = options.location as InstallLocation;
  const methodFilter = options.method;

  let resolved: ResolvedRepo;
  let orgRepo: string | undefined;

  if (options.local) {
    try {
      resolved = await resolveFromLocal(options.local);
    } catch (err) {
      agentError(
        resolveFailureProblem(
          err,
          options.local!,
          `Failed to resolve local methods: ${(err as Error).message}`,
        ),
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
      agentError(
        agentProblem(
          "client.argument_invalid",
          { argument: "address", reason: "invalid_address" },
          (err as Error).message,
        ),
      );
    }

    try {
      resolved = await resolveFromGitHub(parsed);
    } catch (err) {
      agentError(
        resolveFailureProblem(
          err,
          address!,
          `Failed to resolve methods: ${(err as Error).message}`,
        ),
      );
    }
    orgRepo = `${parsed.org}/${parsed.repo}`;
  } else {
    // unreachable due to earlier validation
    agentError(
      agentProblem(
        "client.argument_invalid",
        { argument: "address", reason: "missing" },
        "No address or local path provided.",
      ),
    );
  }

  // The repository has been read, so its refusals are known from here on and
  // every envelope below carries them — see `skippedMethodReports`.
  if (methodFilter) {
    const match = resolved.methods.find((method) => method.name === methodFilter);
    if (!match) {
      agentError(unusableMethodProblem(resolved, methodFilter), {
        skipped_methods: skippedMethodReports(resolved),
      });
    }
    resolved = { ...resolved, methods: [match] };
  }

  if (resolved.methods.length === 0) {
    agentError(
      noUsableMethodProblem(resolved, address ?? options.local!, "No valid methods to install."),
      { skipped_methods: skippedMethodReports(resolved) },
    );
  }

  if (!options.noRunner) {
    if (!isPipelexInstalled()) {
      try {
        await ensureRuntime();
      } catch (err) {
        agentError(
          toolInstallProblem(
            err,
            "pipelex",
            `Failed to install pipelex runtime: ${(err as Error).message}`,
          ),
          { skipped_methods: skippedMethodReports(resolved) },
        );
      }
    }
  }

  let result: InstallFlowResult;
  try {
    result = runInstallFlow({ resolved, location: selectedLocation, orgRepo });
  } catch (err) {
    agentError(
      agentProblem(
        "client.write_failed",
        { path: errorPath(err, selectedLocation), reason: fileErrorReason(err, "unwritable") },
        `Install failed: ${(err as Error).message}`,
      ),
      { skipped_methods: skippedMethodReports(resolved) },
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
    skipped_methods: skippedMethodReports(resolved),
  });
}
