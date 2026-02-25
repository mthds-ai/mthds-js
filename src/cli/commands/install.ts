import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
import * as p from "@clack/prompts";
import chalk from "chalk";
import { isPipelexInstalled } from "../../installer/runtime/check.js";
import { ensureRuntime } from "../../installer/runtime/installer.js";
import { trackInstall, shutdown } from "../../installer/telemetry/posthog.js";
import { printLogo } from "./index.js";
import type { Agent, InstallLocation } from "../../installer/agents/types.js";
import { InstallLocation as Loc } from "../../installer/agents/types.js";
import { getAllAgents, getAgentHandler } from "../../installer/agents/registry.js";
import { parseAddress } from "../../installer/resolver/address.js";
import { resolveFromGitHub } from "../../installer/resolver/github.js";
import { resolveFromLocal } from "../../installer/resolver/local.js";
import type { ResolvedRepo } from "../../package/manifest/types.js";

export async function installMethod(options: {
  address?: string;
  dir?: string;
  method?: string;
}): Promise<void> {
  printLogo();
  p.intro("mthds install");

  const { address, dir, method: methodFilter } = options;

  // Step 0: Resolve repo (multiple methods)
  const s = p.spinner();
  let resolved: ResolvedRepo;

  // Derive org/repo for telemetry
  let orgRepo: string | undefined;

  if (dir) {
    s.start(`Resolving methods from ${dir}...`);
    try {
      resolved = resolveFromLocal(dir);
    } catch (err) {
      s.stop("Failed to resolve local methods.");
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }
    s.stop(`Scanned methods/ folder in ${dir}`);

    // Derive org/repo from first method's package.address (strip github.com/ prefix)
    if (resolved.methods.length > 0) {
      const addr = resolved.methods[0]!.manifest.package.address;
      orgRepo = addr.replace(/^github\.com\//, "");
    }
  } else if (address) {
    let parsed;
    try {
      parsed = parseAddress(address);
    } catch (err) {
      p.log.error((err as Error).message);
      p.outro("");
      process.exit(1);
    }

    s.start(`Resolving methods from ${parsed.org}/${parsed.repo}${parsed.subpath ? `/${parsed.subpath}` : ""}...`);
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
    p.log.error("Provide an address (org/repo) or use --dir <path>.");
    p.outro("");
    process.exit(1);
  }

  // Filter by --method if provided
  if (methodFilter) {
    const match = resolved.methods.find((m) => m.slug === methodFilter);
    if (!match) {
      const available = resolved.methods.map((m) => m.slug).join(", ");
      p.log.error(
        `Method "${methodFilter}" not found. Available slugs: ${available || "(none)"}`
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
    [
      `${chalk.bold("Methods found:")} ${totalCount} total, ${chalk.green(`${validCount} valid`)}, ${skippedCount > 0 ? chalk.yellow(`${skippedCount} skipped`) : `${skippedCount} skipped`}`,
    ].join("\n")
  );

  // Show valid methods
  for (const method of resolved.methods) {
    const m = method.manifest.package;
    const fileCount = method.files.length;
    p.log.success(
      [
        `${chalk.bold(method.slug)} — ${m.display_name ?? m.address} v${m.version}`,
        `  ${m.description}`,
        `  ${fileCount} .mthds file${fileCount !== 1 ? "s" : ""}`,
      ].join("\n")
    );
  }

  // Show skipped methods with errors
  for (const skip of resolved.skipped) {
    const errList = skip.errors.map((e) => `    - ${e}`).join("\n");
    p.log.warning(
      `${chalk.bold(skip.slug)} — skipped:\n${errList}`
    );
  }

  // If no valid methods, exit
  if (validCount === 0) {
    p.log.error("No valid methods to install.");
    p.outro("");
    process.exit(1);
  }

  // Step 1: Which AI agent?
  const agents = getAllAgents();
  const agentOptions = agents.map((a) => ({
    value: a.id,
    label: a.label,
    hint: a.supported ? undefined : (a.hint ?? "not supported"),
    disabled: !a.supported,
  }));

  const selectedAgent = await p.select<Agent>({
    message: "Which AI agent do you want to install these methods for?",
    options: agentOptions,
  });

  if (p.isCancel(selectedAgent)) {
    p.cancel("Installation cancelled.");
    process.exit(0);
  }

  // Step 2: Local or global?
  const localDir = join(process.cwd(), ".claude", "methods");
  const globalDir = join(homedir(), ".claude", "methods");

  const selectedLocation = await p.select<InstallLocation>({
    message: "Where do you want to install these methods?",
    options: [
      {
        value: Loc.Local,
        label: "Local",
        hint: localDir,
      },
      {
        value: Loc.Global,
        label: "Global",
        hint: globalDir,
      },
    ],
  });

  if (p.isCancel(selectedLocation)) {
    p.cancel("Installation cancelled.");
    process.exit(0);
  }

  // Step 3: Optional runner install
  let hasPipelex = isPipelexInstalled();

  const wantsRunner = await p.confirm({
    message: "Do you want to install the pipelex runner? (https://github.com/Pipelex/pipelex)",
    initialValue: false,
  });

  if (p.isCancel(wantsRunner)) {
    p.cancel("Installation cancelled.");
    process.exit(0);
  }

  if (wantsRunner) {
    if (!hasPipelex) {
      await ensureRuntime();
      p.log.success("pipelex installed.");
      hasPipelex = true;
    } else {
      p.log.success("pipelex is already installed.");
    }
  }

  // Step 4: Install all valid methods via the agent handler
  const targetDir =
    selectedLocation === Loc.Global ? globalDir : localDir;

  mkdirSync(targetDir, { recursive: true });

  const handler = getAgentHandler(selectedAgent);

  // Track telemetry only for public GitHub repositories
  if (resolved.source === "github" && resolved.isPublic) {
    for (const method of resolved.methods) {
      const pkg = method.manifest.package;
      trackInstall({
        address: orgRepo ?? pkg.address.replace(/^github\.com\//, ""),
        slug: method.slug,
        version: pkg.version,
        description: pkg.description,
        display_name: pkg.display_name,
        authors: pkg.authors,
        license: pkg.license,
        mthds_version: pkg.mthds_version,
        exports: method.manifest.exports,
        dependencies: method.manifest.dependencies,
        manifest_raw: method.rawManifest,
      });
    }
  }

  await handler.installMethod({
    repo: resolved,
    agent: selectedAgent,
    location: selectedLocation,
    targetDir,
  });

  // Step 5: Optional Pipelex skills (only if user chose to install the runner)
  if (!wantsRunner) {
    p.outro("Done");
    await shutdown();
    return;
  }

  const SKILLS_REPO = "https://github.com/mthds-ai/skills";

  const wantsSkills = await p.confirm({
    message: "Do you want to install the MTHDS skills plugin?",
    initialValue: true,
  });

  if (p.isCancel(wantsSkills)) {
    p.cancel("Installation cancelled.");
    process.exit(0);
  }

  if (wantsSkills) {
    const globalFlag = selectedLocation === Loc.Global ? " -g" : "";
    const locationLabel = selectedLocation === Loc.Global ? "globally" : "locally";
    const sk = p.spinner();
    sk.start(`Installing MTHDS skills ${locationLabel}...`);
    try {
      await execAsync(`npx skills add ${SKILLS_REPO} --skill '*' --agent ${selectedAgent}${globalFlag} -y`, {
        cwd: process.cwd(),
      });
      sk.stop(`MTHDS skills installed ${locationLabel}.`);
    } catch {
      sk.stop("Failed to install MTHDS skills.");
      p.log.warning(`Could not install MTHDS skills. You can retry manually:\n  npx skills add ${SKILLS_REPO} --skill '*' --agent ${selectedAgent}${globalFlag}`);
    }
  }

  p.outro("Done");
  await shutdown();
}
