/**
 * `mthds publish`: list methods on mthds.sh through its registry route.
 *
 * The CLI resolves the methods, the person picks which to publish, and each one is sent to the
 * route by its repository's address and its name; what the route answers for each is reported, and
 * the command fails unless every selected method was listed. A GitHub address is published as
 * given; a `--local` directory is published by the address each method's `METHODS.toml` declares,
 * since the hub lists what the public repository holds, and a version the hub read that differs
 * from the local one is pointed out. Publishing does not depend on telemetry.
 */

import * as p from "@clack/prompts";
import chalk from "chalk";
import { trackLocalPublish, trackPublish, shutdown } from "../../installer/telemetry/posthog.js";
import { printLogo } from "./index.js";
import { parseAddress } from "../../installer/resolver/address.js";
import { resolveFromGitHub } from "../../installer/resolver/github.js";
import { resolveFromLocal } from "../../installer/resolver/local.js";
import { describeUnusableMethod } from "../../installer/resolver/skipped.js";
import {
  describeRegistration,
  isAccepted,
  registerMethods,
  resolveHubUrl,
} from "../../installer/registry/client.js";
import type { MethodRegistration } from "../../installer/registry/client.js";
import {
  privateRepositoryRefusal,
  subdirectoryRefusal,
} from "../../installer/registry/refusals.js";
import type { ResolvedMethod, ResolvedRepo } from "../../package/manifest/types.js";

/** Report what the route answered for one method, and answer whether it was listed. */
function reportRegistration(
  registration: MethodRegistration,
  method: ResolvedMethod | undefined,
  local: boolean,
): boolean {
  const answer = registration.answer;
  if (!isAccepted(answer)) {
    p.log.error(describeRegistration(registration));
    return false;
  }
  const lines = [describeRegistration(registration)];
  const localVersion = method?.manifest.package.version;
  if (local && localVersion !== undefined && localVersion !== answer.method.version) {
    lines.push(
      `  Your local copy is version ${localVersion}; mthds.sh lists what GitHub holds, so push it to publish ${localVersion}.`,
    );
  }
  if (answer.validation === "unavailable") {
    lines.push(
      "  Its validation badge will not refresh yet: mthds.sh could not ask for a validation.",
    );
  }
  p.log.success(lines.join("\n"));
  return true;
}

export async function publishMethod(options: {
  address?: string;
  dir?: string;
  method?: string;
}): Promise<void> {
  printLogo();
  p.intro("mthds publish");

  const { address, dir, method: methodFilter } = options;

  // Step 0: Resolve repo
  const s = p.spinner();
  s.start("Resolving methods...");
  let resolved: ResolvedRepo;
  let orgRepo: string | undefined;

  if (dir) {
    s.message(`Resolving methods from ${dir}...`);
    try {
      resolved = resolveFromLocal(dir);
    } catch (err) {
      s.stop("Failed to resolve local methods.");
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }
    s.stop(`Scanned methods/ folder in ${dir}`);

    if (resolved.methods.length > 0) {
      const addr = resolved.methods[0]!.manifest.package.address;
      orgRepo = addr.replace(/^github\.com\//, "");
    }
  } else if (address) {
    let parsed;
    try {
      parsed = parseAddress(address);
    } catch (err) {
      s.stop("");
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }

    if (parsed.subpath) {
      s.stop("");
      p.log.error(subdirectoryRefusal(parsed));
      p.outro("");
      process.exit(1);
    }

    s.message(`Resolving methods from ${parsed.org}/${parsed.repo}...`);
    try {
      resolved = await resolveFromGitHub(parsed);
    } catch (err) {
      s.stop("Failed to resolve methods.");
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }
    s.stop(`Scanned methods/ folder in ${parsed.org}/${parsed.repo}`);
    orgRepo = `${parsed.org}/${parsed.repo}`;
  } else {
    s.stop("");
    p.log.error("Provide an address (org/repo) or use --local <path>.");
    p.outro("");
    process.exit(1);
  }

  // Filter by --method if provided
  if (methodFilter) {
    const match = resolved.methods.find((m) => m.name === methodFilter);
    if (!match) {
      p.log.error(describeUnusableMethod(resolved, methodFilter));
      p.outro("");
      process.exit(1);
    }
    resolved = { ...resolved, methods: [match] };
  }

  // Display summary
  const validCount = resolved.methods.length;
  const skippedCount = resolved.skipped.length;
  const totalCount = validCount + skippedCount;

  p.log.info(
    `${chalk.bold("Methods found:")} ${totalCount} total, ${chalk.green(`${validCount} valid`)}, ${skippedCount > 0 ? chalk.yellow(`${skippedCount} skipped`) : `${skippedCount} skipped`}`,
  );

  for (const method of resolved.methods) {
    const m = method.manifest.package;
    const fileCount = method.files.length;
    p.log.success(
      [
        `${chalk.bold(method.name)} — ${m.display_name ?? m.address} v${m.version}`,
        `  ${m.description}`,
        `  ${fileCount} .mthds file${fileCount !== 1 ? "s" : ""}`,
      ].join("\n"),
    );
  }

  for (const skip of resolved.skipped) {
    const errList = skip.errors.map((e) => `    - ${e}`).join("\n");
    p.log.warning(`${chalk.bold(skip.dirName)} — skipped:\n${errList}`);
  }

  if (validCount === 0) {
    p.log.error("No valid methods to publish.");
    p.outro("");
    process.exit(1);
  }

  // mthds.sh lists only public repositories; a private one is refused before the selection, and
  // its name is never sent.
  if (resolved.source === "github" && !resolved.isPublic) {
    p.log.error(privateRepositoryRefusal(orgRepo!));
    p.outro("");
    process.exit(1);
  }

  const hub = resolveHubUrl();
  if (!hub.ok) {
    p.log.error(hub.message);
    p.outro("");
    process.exit(1);
  }

  // Let the user select which methods to publish
  let selectedMethods = resolved.methods;

  if (validCount > 1) {
    let selected: string[] = [];
    let methodAttempts = 0;
    while (selected.length === 0) {
      const result = await p.multiselect({
        message: "Which methods do you want to publish? (space to select, enter to confirm)",
        options: resolved.methods.map((m) => ({
          value: m.name,
          label: m.manifest.package.display_name ?? m.name,
          hint: `v${m.manifest.package.version}`,
        })),
        required: false,
      });

      if (p.isCancel(result)) {
        p.cancel("Publishing cancelled.");
        process.exit(0);
      }

      if (result.length === 0) {
        methodAttempts++;
        if (methodAttempts >= 2) {
          p.outro("Done");
          return;
        }
        p.log.warning(
          chalk.yellow(
            "No methods selected. Use space to toggle selection, then press enter to confirm.",
          ),
        );
        continue;
      }
      selected = result;
    }

    const selectedNames = new Set(selected);
    selectedMethods = resolved.methods.filter((m) => selectedNames.has(m.name));
  }

  const selectedCount = selectedMethods.length;
  const local = resolved.source === "local";

  // One request per method: a GitHub address as given, a local method by its manifest's address.
  const publishing = p.spinner();
  publishing.start("Publishing to mthds.sh...");
  const registrations = await registerMethods(
    selectedMethods.map((method) => ({
      address: local ? method.manifest.package.address : orgRepo!,
      name: method.name,
    })),
    {
      hubUrl: hub.url,
      onMethod: (name) => publishing.message(`Publishing ${name} to mthds.sh...`),
      onRateLimited: (seconds) =>
        publishing.message(`mthds.sh asks to wait ${seconds} s before the next request...`),
    },
  );
  publishing.stop("mthds.sh answered.");

  let publishedCount = 0;
  for (const registration of registrations) {
    const method = selectedMethods.find((candidate) => candidate.name === registration.name);
    if (!reportRegistration(registration, method, local)) continue;
    publishedCount++;
    const answer = registration.answer;
    if (!isAccepted(answer)) continue;
    // A local manifest may hold edits never pushed: a local publish is counted with what the hub
    // read from the public repository alone.
    if (local) trackLocalPublish(answer.method);
    else if (method) trackPublish(method, answer.method.address);
  }

  await shutdown();

  const plural = (count: number): string => `${count} method${count !== 1 ? "s" : ""}`;
  if (publishedCount === selectedCount) {
    p.log.success(`Published ${plural(publishedCount)} to mthds.sh`);
    p.outro("Done");
    return;
  }
  if (publishedCount === 0) {
    p.log.error("Nothing was published to mthds.sh.");
  } else {
    p.log.warn(`Published ${publishedCount} of ${plural(selectedCount)} to mthds.sh.`);
  }
  p.outro("");
  process.exit(1);
}
