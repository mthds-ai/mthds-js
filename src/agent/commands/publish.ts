/**
 * Non-interactive agent publish command.
 *
 * Given an address, it resolves the methods, asks mthds.sh's registry route to list each one, and
 * reports what the route answered, method by method, in `registrations`; `published_methods` then
 * names only the methods the route accepted. No file is written and no runner is involved.
 *
 * `--local` keeps the envelope this command shipped with, which the shared contract still describes:
 * it resolves the directory and registers nothing, since a local directory is not what mthds.sh
 * lists, yet `published_methods` names every method it selected. So `published_methods` alone never
 * says whether a method was listed: an empty `registrations` and the `message` saying that nothing
 * was registered are how a caller tells, and the message says to publish the GitHub address instead.
 */

import { agentSuccess, agentError, agentProblem } from "../output.js";
import { noUsableMethodProblem, registrationsProblem, unusableMethodProblem } from "../problems.js";
import { parseAddress } from "../../installer/resolver/address.js";
import { resolveFromGitHub } from "../../installer/resolver/github.js";
import { resolveFromLocal } from "../../installer/resolver/local.js";
import { skippedMethodReports } from "../../installer/resolver/skipped.js";
import {
  describeRegistration,
  isAccepted,
  registerMethods,
  registrationReport,
  HUB_URL_ENV,
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
    if (parsed.subpath) {
      agentError(
        agentProblem(
          "client.argument_invalid",
          { argument: "address", reason: "subdirectory" },
          subdirectoryRefusal(parsed),
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
      agentError(unusableMethodProblem(resolved, methodFilter, "actor"), {
        skipped_methods: skippedMethodReports(resolved),
      });
    }
    resolved = { ...resolved, methods: [match] };
  }

  if (resolved.methods.length === 0) {
    agentError(
      noUsableMethodProblem(
        resolved,
        address ?? options.local!,
        "No valid methods to publish.",
        "actor",
      ),
      { skipped_methods: skippedMethodReports(resolved) },
    );
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
    agentError(
      agentProblem(
        "client.argument_invalid",
        { argument: "address", reason: "private_repository" },
        privateRepositoryRefusal(orgRepo!),
      ),
      { skipped_methods: skippedMethodReports(resolved) },
    );
  }

  const hub = resolveHubUrl();
  if (!hub.ok) {
    agentError(agentProblem("client.not_configured", { setting: HUB_URL_ENV }, hub.message), {
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
    const message = [
      "Nothing was published: mthds.sh listed none of the selected methods.",
      ...registrations.map(describeRegistration),
    ].join("\n");
    agentError(
      registrationsProblem(registrations, { hubUrl: hub.url, orgRepo: orgRepo!, message }),
      {
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
