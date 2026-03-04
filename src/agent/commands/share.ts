/**
 * Non-interactive agent share command.
 * Resolves methods and returns share URLs for social media — no browser opening.
 */

import { agentSuccess, agentError, AGENT_ERROR_DOMAINS } from "../output.js";
import { parseAddress } from "../../installer/resolver/address.js";
import { resolveFromGitHub } from "../../installer/resolver/github.js";
import { resolveFromLocal } from "../../installer/resolver/local.js";
import { buildShareUrls } from "../../cli/commands/share.js";
import type { SharePlatform } from "../../cli/commands/share.js";
import type { ResolvedRepo } from "../../package/manifest/types.js";

const VALID_PLATFORMS: SharePlatform[] = ["x", "reddit", "linkedin"];

interface AgentShareOptions {
  local?: string;
  method?: string;
  platform?: SharePlatform[];
}

export async function agentShare(
  address: string | undefined,
  options: AgentShareOptions
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
        "ShareError",
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
      agentError((err as Error).message, "ShareError", {
        error_domain: AGENT_ERROR_DOMAINS.INSTALL,
      });
    }

    try {
      resolved = await resolveFromGitHub(parsed);
    } catch (err) {
      agentError(
        `Failed to resolve methods: ${(err as Error).message}`,
        "ShareError",
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
        "ShareError",
        { error_domain: AGENT_ERROR_DOMAINS.INSTALL }
      );
    }
    resolved = { ...resolved, methods: [match] };
  }

  if (resolved.methods.length === 0) {
    agentError("No valid methods to share.", "ShareError", {
      error_domain: AGENT_ERROR_DOMAINS.INSTALL,
    });
  }

  // Validate --platform values
  const platforms = options.platform ?? VALID_PLATFORMS;
  for (const p of platforms) {
    if (!VALID_PLATFORMS.includes(p)) {
      agentError(
        `Invalid platform "${p}". Valid platforms: ${VALID_PLATFORMS.join(", ")}`,
        "ArgumentError",
        { error_domain: AGENT_ERROR_DOMAINS.ARGUMENT }
      );
    }
  }

  const allUrls = buildShareUrls({
    methods: resolved.methods.map((m) => ({
      displayName: m.manifest.package.display_name ?? m.name,
      description: m.manifest.package.description,
    })),
    address: orgRepo ?? resolved.methods[0]!.manifest.package.address.replace(/^github\.com\//, ""),
  });

  // Filter to requested platforms only
  const shareUrls: Record<string, string> = {};
  for (const p of platforms) {
    shareUrls[p] = allUrls[p];
  }

  agentSuccess({
    success: true,
    methods: resolved.methods.map((m) => m.name),
    address: orgRepo,
    share_urls: shareUrls,
  });
}
