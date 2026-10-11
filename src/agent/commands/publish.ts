/**
 * Non-interactive agent publish command.
 *
 * Resolves the methods, then asks mthds.sh's registry route to list each one, and reports what the
 * route answered, method by method, in `registrations`. `published_methods` names only the methods
 * the route accepted, so the envelope never says a method was published when nothing listed it.
 * No file is written and no runner is involved.
 *
 * `--local` keeps the envelope this command shipped with: it resolves the directory and reports the
 * methods it selected, but registers nothing, since a local directory is not what mthds.sh lists.
 * Its `registrations` is empty, and its `message` says to publish the GitHub address instead.
 */

import { agentSuccess, agentError, AGENT_ERROR_DOMAINS } from "../output.js";
import { parseAddress } from "../../installer/resolver/address.js";
import { resolveFromGitHub } from "../../installer/resolver/github.js";
import { resolveFromLocal } from "../../installer/resolver/local.js";
import { describeUnusableMethod, skippedMethodReports } from "../../installer/resolver/skipped.js";
import {
  describeRegistration,
  isAccepted,
  registerMethods,
  registrationReport,
  resolveHubUrl,
} from "../../installer/registry/client.js";
import {
  privateRepositoryRefusal,
  subdirectoryRefusal,
} from "../../installer/registry/refusals.js";
import { trackPublish, shutdown } from "../../installer/telemetry/posthog.js";
import type { ResolvedRepo } from "../../package/manifest/types.js";

interface AgentPublishOptions {
  local?: string;
  method?: string;
}

export const LOCAL_PUBLISH_MESSAGE =
  "Nothing was registered on mthds.sh: it lists what a public GitHub repository holds, not a local directory. " +
  "Push the methods, then run `mthds-agent publish <org/repo>`.";

export async function agentPublish(
  address: string | undefined,
  options: AgentPublishOptions,
): Promise<void> {
  if (address && options.local) {
    agentError("Cannot use both an address and --local at the same time.", "ArgumentError", {
      error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
    });
  }

  if (!address && !options.local) {
    agentError("Provide an address (org/repo) or use --local <path>.", "ArgumentError", {
      error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
    });
  }

  const methodFilter = options.method;

  // Resolve repo
  let resolved: ResolvedRepo;
  let orgRepo: string | undefined;

  if (options.local) {
    try {
      resolved = resolveFromLocal(options.local);
    } catch (err) {
      agentError(`Failed to resolve local methods: ${(err as Error).message}`, "PublishError", {
        error_domain: AGENT_ERROR_DOMAINS.INSTALL,
      });
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
    if (parsed.subpath) {
      agentError(subdirectoryRefusal(parsed), "PublishError", {
        error_domain: AGENT_ERROR_DOMAINS.ARGUMENT,
      });
    }

    try {
      resolved = await resolveFromGitHub(parsed);
    } catch (err) {
      agentError(`Failed to resolve methods: ${(err as Error).message}`, "PublishError", {
        error_domain: AGENT_ERROR_DOMAINS.INSTALL,
      });
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
      agentError(describeUnusableMethod(resolved, methodFilter), "PublishError", {
        error_domain: AGENT_ERROR_DOMAINS.INSTALL,
        skipped_methods: skippedMethodReports(resolved),
      });
    }
    resolved = { ...resolved, methods: [match] };
  }

  if (resolved.methods.length === 0) {
    agentError("No valid methods to publish.", "PublishError", {
      error_domain: AGENT_ERROR_DOMAINS.INSTALL,
      skipped_methods: skippedMethodReports(resolved),
    });
  }

  if (resolved.source === "local") {
    agentSuccess({
      success: true,
      published_methods: resolved.methods.map((m) => m.name),
      address: orgRepo,
      skipped_methods: skippedMethodReports(resolved),
      registrations: [],
      message: LOCAL_PUBLISH_MESSAGE,
    });
    return;
  }

  if (!resolved.isPublic) {
    agentError(privateRepositoryRefusal(orgRepo!), "PublishError", {
      error_domain: AGENT_ERROR_DOMAINS.INSTALL,
      skipped_methods: skippedMethodReports(resolved),
    });
  }

  const hub = resolveHubUrl();
  if (!hub.ok) {
    agentError(hub.message, "PublishError", {
      error_domain: AGENT_ERROR_DOMAINS.CONFIG,
      skipped_methods: skippedMethodReports(resolved),
    });
  }

  const registrations = await registerMethods(
    resolved.methods.map((method) => ({ address: orgRepo!, name: method.name })),
    { hubUrl: hub.url },
  );

  const accepted: string[] = [];
  for (const registration of registrations) {
    const answer = registration.answer;
    if (!isAccepted(answer)) continue;
    accepted.push(registration.name);
    const method = resolved.methods.find((candidate) => candidate.name === registration.name);
    if (method) trackPublish(method, answer.method.address);
  }
  await shutdown();

  const reports = registrations.map(registrationReport);
  if (accepted.length === 0) {
    const failures = registrations.map((registration) => registration.answer);
    const retryable = failures.every(
      (answer) => answer.outcome === "error" && answer.error.retryable,
    );
    agentError(
      [
        "Nothing was published: mthds.sh listed none of the selected methods.",
        ...registrations.map(describeRegistration),
      ].join("\n"),
      "PublishError",
      {
        error_domain: AGENT_ERROR_DOMAINS.INSTALL,
        retryable,
        skipped_methods: skippedMethodReports(resolved),
        registrations: reports,
      },
    );
  }

  agentSuccess({
    success: true,
    published_methods: accepted,
    address: orgRepo,
    skipped_methods: skippedMethodReports(resolved),
    registrations: reports,
  });
}
