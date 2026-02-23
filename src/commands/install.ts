import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
import * as p from "@clack/prompts";
import chalk from "chalk";
import { isPipelexInstalled } from "../runtime/check.js";
import { ensureRuntime } from "../runtime/installer.js";
import { trackMethodInstall, shutdown } from "../telemetry/posthog.js";
import { printLogo } from "./index.js";
import type { Agent, InstallLocation } from "../agents/types.js";
import { InstallLocation as Loc } from "../agents/types.js";
import { getAllAgents, getAgentHandler } from "../agents/registry.js";
import { parseAddress } from "../resolver/address.js";
import { resolveFromGitHub } from "../resolver/github.js";
import { resolveFromLocal } from "../resolver/local.js";
import type { ResolvedRepo } from "../resolver/types.js";

export async function installMethod(options: {
  address?: string;
  dir?: string;
}): Promise<void> {
  printLogo();
  p.intro("mthds install");

  const { address, dir } = options;

  // Step 0: Resolve repo (multiple methods)
  const s = p.spinner();
  let resolved: ResolvedRepo;

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
  } else {
    p.log.error("Provide an address (org/repo) or use --dir <path>.");
    p.outro("");
    process.exit(1);
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
  const wantsRunner = await p.confirm({
    message: "Do you want to install the runner now? (optional)",
    initialValue: false,
  });

  if (p.isCancel(wantsRunner)) {
    p.cancel("Installation cancelled.");
    process.exit(0);
  }

  if (wantsRunner) {
    if (!isPipelexInstalled()) {
      await ensureRuntime();
      p.log.success("pipelex installed.");
    } else {
      p.log.success("pipelex is already installed.");
    }
  }

  // Step 4: Install all valid methods via the agent handler
  const targetDir =
    selectedLocation === Loc.Global ? globalDir : localDir;

  mkdirSync(targetDir, { recursive: true });

  const handler = getAgentHandler(selectedAgent);

  // Track telemetry for each method
  for (const method of resolved.methods) {
    trackMethodInstall(method.manifest.package.address, method.manifest.package.version);
  }

  await handler.installMethod({
    repo: resolved,
    agent: selectedAgent,
    location: selectedLocation,
    targetDir,
  });

  // Step 5: Optional Pipelex skills
  const SKILLS_REPO = "https://github.com/pipelex/skills";
  const skillChoices = [
    { value: "check", label: "check", hint: "Validate and review Pipelex workflow bundles without making changes" },
    { value: "edit", label: "edit", hint: "Modify existing Pipelex workflow bundles" },
    { value: "build", label: "build", hint: "Create new Pipelex workflow bundles from scratch" },
    { value: "fix", label: "fix", hint: "Automatically fix issues in Pipelex workflow bundles" },
  ];

  let selectedSkills: string[] = [];
  let emptyAttempts = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const hint = emptyAttempts > 0
      ? chalk.yellow("  press space to select, enter to confirm")
      : chalk.dim("  press space to select, enter to confirm");

    const result = await p.multiselect({
      message: `Which Pipelex skills do you want to install?\n${hint}`,
      options: skillChoices,
      required: false,
    });

    if (p.isCancel(result)) {
      p.cancel("Installation cancelled.");
      process.exit(0);
    }

    if (result.length === 0) {
      emptyAttempts++;
      if (emptyAttempts >= 2) {
        break;
      }
      continue;
    }

    selectedSkills = result;
    break;
  }

  if (selectedSkills.length > 0) {
    const globalFlag = selectedLocation === Loc.Global ? " -g" : "";
    const locationLabel = selectedLocation === Loc.Global ? "globally" : "locally";
    const sk = p.spinner();
    for (const skill of selectedSkills) {
      sk.start(`Installing skill "${skill}" ${locationLabel}...`);
      try {
        await execAsync(`npx skills add ${SKILLS_REPO} --skill ${skill} --agent ${selectedAgent}${globalFlag} -y`, {
          cwd: process.cwd(),
        });
        sk.stop(`Skill "${skill}" installed ${locationLabel}.`);
      } catch {
        sk.stop(`Failed to install skill "${skill}".`);
        p.log.warning(`Could not install skill "${skill}". You can retry manually:\n  npx skills add ${SKILLS_REPO} --skill ${skill} --agent ${selectedAgent}${globalFlag}`);
      }
    }
  }

  p.outro("Done");
  await shutdown();
}
