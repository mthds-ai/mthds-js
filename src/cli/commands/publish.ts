import { resolve } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { trackPublish, shutdown } from "../../installer/telemetry/posthog.js";
import { printLogo } from "./index.js";
import { parseAddress } from "../../installer/resolver/address.js";
import { resolveFromGitHub } from "../../installer/resolver/github.js";
import { resolveFromLocal } from "../../installer/resolver/local.js";
import { buildShareUrl } from "./share.js";
import type { ResolvedRepo } from "../../package/manifest/types.js";

const execAsync = promisify(exec);

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

  p.log.success(`Published ${validCount} method${validCount !== 1 ? "s" : ""} to mthds.sh`);

  // Offer to share on X/Twitter
  const firstMethod = resolved.methods[0]!;
  const pkg = firstMethod.manifest.package;
  const shareUrl = buildShareUrl({
    displayName: pkg.display_name ?? firstMethod.name,
    description: pkg.description,
    address: orgRepo ?? pkg.address.replace(/^github\.com\//, ""),
  });

  const wantsShare = await p.confirm({
    message: "Open X to share?",
    initialValue: false,
  });

  if (p.isCancel(wantsShare)) {
    p.outro("Done");
    return;
  }

  if (wantsShare) {
    const openCmd = process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
    try {
      await execAsync(`${openCmd} "${shareUrl}"`);
      p.log.success("Opened browser.");
    } catch {
      p.log.warning(`Could not open browser. Share URL:\n  ${shareUrl}`);
    }
  }

  p.outro("Done");
}
