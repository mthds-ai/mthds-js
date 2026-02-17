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
import { fetchMethodBySlug } from "../supabase/methods.js";

export async function installMethod(slug: string): Promise<void> {
  printLogo();
  p.intro("mthds install");

  // Step 0: Check if the method exists
  const s = p.spinner();
  s.start(`Looking up method "${slug}"...`);

  const method = await fetchMethodBySlug(slug);

  if (!method) {
    s.stop(`Method "${slug}" not found.`);
    p.log.error(`No method with slug "${slug}" exists.`);
    p.log.info("Check the slug and try again.");
    p.outro("");
    process.exit(1);
  }

  if (!method.content) {
    s.stop(`Method "${slug}" has no content.`);
    p.log.error("This method is missing its content and cannot be installed.");
    p.outro("");
    process.exit(1);
  }

  s.stop(`Found "${method.name}"${method.description ? ` — ${method.description}` : ""}`);

  // Step 1: Which AI agent?
  const agents = getAllAgents();
  const agentOptions = agents.map((a) => ({
    value: a.id,
    label: a.label,
    hint: a.supported ? undefined : (a.hint ?? "not supported"),
    disabled: !a.supported,
  }));

  const selectedAgent = await p.select<Agent>({
    message: "Which AI agent do you want to install this method for?",
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
    message: "Where do you want to install this method?",
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

  // Step 4: Install via the agent handler
  const targetDir =
    selectedLocation === Loc.Global ? globalDir : localDir;

  mkdirSync(targetDir, { recursive: true });

  const handler = getAgentHandler(selectedAgent);

  trackMethodInstall(slug);

  await handler.installMethod({
    method: slug,
    content: method.content,
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
