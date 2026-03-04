/**
 * Non-interactive agent publish command.
 * Resolves methods and sends publish telemetry — no file writes, no runner, no skills.
 */

import { agentSuccess, agentError, AGENT_ERROR_DOMAINS } from "../output.js";
import { parseAddress } from "../../installer/resolver/address.js";
import { resolveFromGitHub } from "../../installer/resolver/github.js";
import { resolveFromLocal } from "../../installer/resolver/local.js";
import { trackPublish, shutdown } from "../../installer/telemetry/posthog.js";
import { buildShareUrl } from "../../cli/commands/share.js";
import type { ResolvedRepo } from "../../package/manifest/types.js";

interface AgentPublishOptions {
  local?: string;
  method?: string;
  share?: boolean;
}

export async function agentPublish(
  address: string | undefined,
  options: AgentPublishOptions
): Promise<void> {
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
        "PublishError",
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
      agentError((err as Error).message, "PublishError", {
        error_domain: AGENT_ERROR_DOMAINS.INSTALL,
      });
    }

    try {
      resolved = await resolveFromGitHub(parsed);
    } catch (err) {
      agentError(
        `Failed to resolve methods: ${(err as Error).message}`,
        "PublishError",
        { error_domain: AGENT_ERROR_DOMAINS.INSTALL }
      );
    }
    orgRepo = `${parsed.org}/${parsed.repo}`;
  } else {
    agentError("No address or local path provided.", "ArgumentError", {
      error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
    });
  }

  // Filter by --method
  if (methodFilter) {
    const match = resolved.methods.find((m) => m.name === methodFilter);
    if (!match) {
      const available = resolved.methods.map((m) => m.name).join(", ");
      agentError(
        `Method "${methodFilter}" not found. Available methods: ${available || "(none)"}`,
        "PublishError",
        { error_domain: AGENT_ERROR_DOMAINS.INSTALL }
      );
    }
    resolved = { ...resolved, methods: [match] };
  }

  if (resolved.methods.length === 0) {
    agentError("No valid methods to publish.", "PublishError", {
      error_domain: AGENT_ERROR_DOMAINS.INSTALL,
    });
  }

  // Track publish telemetry (public GitHub repos only)
  if (resolved.source === "github" && resolved.isPublic) {
    for (const method of resolved.methods) {
      const pkg = method.manifest.package;
      trackPublish({
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

  await shutdown();

  // Build result
  const result: Record<string, unknown> = {
    success: true,
    published_methods: resolved.methods.map((m) => m.name),
    address: orgRepo,
  };

  // Include share URL if requested
  if (options.share && resolved.methods.length > 0) {
    const firstMethod = resolved.methods[0]!;
    const pkg = firstMethod.manifest.package;
    result.share_url = buildShareUrl({
      displayName: pkg.display_name ?? firstMethod.name,
      description: pkg.description,
      address: orgRepo ?? pkg.address.replace(/^github\.com\//, ""),
    });
  }

  agentSuccess(result);
}
