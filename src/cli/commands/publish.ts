import * as p from "@clack/prompts";
import chalk from "chalk";
import { trackPublish, shutdown } from "../../installer/telemetry/posthog.js";
import { printLogo } from "./index.js";
import { parseAddress } from "../../installer/resolver/address.js";
import { resolveFromGitHub } from "../../installer/resolver/github.js";
import { resolveFromLocal } from "../../installer/resolver/local.js";
import type { ResolvedRepo } from "../../package/manifest/types.js";

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

    s.message(`Resolving methods from ${parsed.org}/${parsed.repo}${parsed.subpath ? `/${parsed.subpath}` : ""}...`);
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
      const available = resolved.methods.map((m) => m.name).join(", ");
      p.log.error(
        `Method "${methodFilter}" not found. Available methods: ${available || "(none)"}`
      );
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
    `${chalk.bold("Methods found:")} ${totalCount} total, ${chalk.green(`${validCount} valid`)}, ${skippedCount > 0 ? chalk.yellow(`${skippedCount} skipped`) : `${skippedCount} skipped`}`
  );

  for (const method of resolved.methods) {
    const m = method.manifest.package;
    const fileCount = method.files.length;
    p.log.success(
      [
        `${chalk.bold(method.name)} — ${m.display_name ?? m.address} v${m.version}`,
        `  ${m.description}`,
        `  ${fileCount} .mthds file${fileCount !== 1 ? "s" : ""}`,
      ].join("\n")
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
        p.log.warning(chalk.yellow("No methods selected. Use space to toggle selection, then press enter to confirm."));
        continue;
      }
      selected = result;
    }

    const selectedNames = new Set(selected);
    selectedMethods = resolved.methods.filter((m) => selectedNames.has(m.name));
  }

  const selectedCount = selectedMethods.length;

  // Track publish telemetry (public GitHub repos only)
  if (resolved.source === "github" && resolved.isPublic) {
    for (const method of selectedMethods) {
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

  p.log.success(`Published ${selectedCount} method${selectedCount !== 1 ? "s" : ""} to mthds.sh`);
  p.outro("Done");
}
