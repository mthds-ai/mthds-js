/**
 * Non-interactive agent share command.
 * Resolves methods and returns share URLs for social media — no browser opening.
 */

import { agentSuccess, agentError, agentProblem } from "../output.js";
import { noUsableMethodProblem, unusableMethodProblem } from "../problems.js";
import { parseAddress } from "../../installer/resolver/address.js";
import { resolveFromGitHub } from "../../installer/resolver/github.js";
import { resolveFromLocal } from "../../installer/resolver/local.js";
import { skippedMethodReports } from "../../installer/resolver/skipped.js";
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
  options: AgentShareOptions,
): Promise<void> {
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

  // Checked here rather than after the resolve: an argument the caller spelled
  // wrong is knowable without reading anything, and an error raised before the
  // read is the one kind that carries no skip list to report.
  const platforms = options.platform ?? VALID_PLATFORMS;
  for (const platform of platforms) {
    if (!VALID_PLATFORMS.includes(platform)) {
      agentError(
        agentProblem(
          "client.argument_invalid",
          { argument: "--platform", reason: "unknown_value" },
          `Invalid platform "${platform}". Valid platforms: ${VALID_PLATFORMS.join(", ")}`,
        ),
      );
    }
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
        agentProblem(
          "method.not_found",
          { method_ref: options.local! },
          `Failed to resolve local methods: ${(err as Error).message}`,
        ),
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
        agentProblem(
          "method.not_found",
          { method_ref: address! },
          `Failed to resolve methods: ${(err as Error).message}`,
        ),
      );
    }
    orgRepo = `${parsed.org}/${parsed.repo}`;
  } else {
    agentError(
      agentProblem(
        "client.argument_invalid",
        { argument: "address", reason: "missing" },
        "No address or local path provided.",
      ),
    );
  }

  // Filter by --method
  if (methodFilter) {
    const match = resolved.methods.find((m) => m.name === methodFilter);
    if (!match) {
      agentError(unusableMethodProblem(resolved, methodFilter), {
        skipped_methods: skippedMethodReports(resolved),
      });
    }
    resolved = { ...resolved, methods: [match] };
  }

  if (resolved.methods.length === 0) {
    agentError(
      noUsableMethodProblem(resolved, address ?? options.local!, "No valid methods to share."),
      { skipped_methods: skippedMethodReports(resolved) },
    );
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
    skipped_methods: skippedMethodReports(resolved),
  });
}
