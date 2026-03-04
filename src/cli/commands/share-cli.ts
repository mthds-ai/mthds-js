import { exec } from "node:child_process";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { printLogo } from "./index.js";
import { parseAddress } from "../../installer/resolver/address.js";
import { resolveFromGitHub } from "../../installer/resolver/github.js";
import { resolveFromLocal } from "../../installer/resolver/local.js";
import { buildShareUrls } from "./share.js";
import type { SharePlatform } from "./share.js";
import type { ResolvedRepo } from "../../package/manifest/types.js";

const execAsync = promisify(exec);

export async function shareMethod(options: {
  address?: string;
  dir?: string;
  method?: string;
}): Promise<void> {
  printLogo();
  p.intro("mthds share");

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

  if (resolved.methods.length === 0) {
    p.log.error("No valid methods to share.");
    p.outro("");
    process.exit(1);
  }

  // Display methods
  for (const method of resolved.methods) {
    const m = method.manifest.package;
    p.log.info(`${chalk.bold(method.name)} — ${m.display_name ?? m.address} v${m.version}`);
  }

  // Let the user select which methods to share
  let selectedMethods = resolved.methods;

  if (resolved.methods.length > 1) {
    let selected: string[] = [];
    let methodAttempts = 0;
    while (selected.length === 0) {
      const result = await p.multiselect({
        message: "Which methods do you want to share? (space to select, enter to confirm)",
        options: resolved.methods.map((m) => ({
          value: m.name,
          label: m.manifest.package.display_name ?? m.name,
          hint: `v${m.manifest.package.version}`,
        })),
        required: false,
      });

      if (p.isCancel(result)) {
        p.cancel("Sharing cancelled.");
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

  // Build share URLs
  const shareUrls = buildShareUrls({
    methods: selectedMethods.map((m) => ({
      displayName: m.manifest.package.display_name ?? m.name,
      description: m.manifest.package.description,
    })),
    address: orgRepo ?? selectedMethods[0]!.manifest.package.address.replace(/^github\.com\//, ""),
  });

  // Select platforms
  let sharePlatforms: SharePlatform[] = [];
  let shareAttempts = 0;
  while (sharePlatforms.length === 0) {
    const result = await p.multiselect<SharePlatform>({
      message: "Share on social media? (space to select, enter to confirm)",
      options: [
        { value: "x" as const, label: "X (Twitter)" },
        { value: "reddit" as const, label: "Reddit" },
        { value: "linkedin" as const, label: "LinkedIn" },
      ],
      required: false,
    });

    if (p.isCancel(result)) {
      p.outro("Done");
      return;
    }

    if (result.length === 0) {
      shareAttempts++;
      if (shareAttempts >= 2) {
        p.outro("Done");
        return;
      }
      p.log.warning(chalk.yellow("No platforms selected. Use space to toggle selection, then press enter to confirm."));
      continue;
    }
    sharePlatforms = result;
  }

  const openCmd = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "start"
      : "xdg-open";

  for (const platform of sharePlatforms) {
    const shareUrl = shareUrls[platform];
    try {
      await execAsync(`${openCmd} "${shareUrl}"`);
    } catch {
      p.log.warning(`Could not open browser for ${platform}. URL:\n  ${shareUrl}`);
    }
  }

  p.log.success(`Opened ${sharePlatforms.length} browser tab${sharePlatforms.length !== 1 ? "s" : ""}.`);
  p.outro("Done");
}
