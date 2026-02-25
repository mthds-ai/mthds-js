import { join, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
import * as p from "@clack/prompts";
import chalk from "chalk";
import { isPipelexInstalled } from "../../installer/runtime/check.js";
import { ensureRuntime } from "../../installer/runtime/installer.js";
import { trackInstall, shutdown } from "../../installer/telemetry/posthog.js";
import { printLogo } from "./index.js";
import { parseAddress } from "../../installer/resolver/address.js";
import { resolveFromGitHub } from "../../installer/resolver/github.js";
import { resolveFromLocal } from "../../installer/resolver/local.js";
import { generateShim } from "../../installer/agents/registry.js";
import type { ResolvedRepo } from "../../package/manifest/types.js";

type InstallLocation = "project" | "global";

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

  // Step 1: Display summary
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

  // Step 2: Install location (project-local or global)
  const projectDir = join(process.cwd(), ".mthds", "methods");
  const globalDir = join(homedir(), ".mthds", "methods");

  const selectedLocation = await p.select<InstallLocation>({
    message: "Where do you want to install these methods?",
    options: [
      {
        value: "project" as const,
        label: "Project",
        hint: projectDir,
      },
      {
        value: "global" as const,
        label: "Global",
        hint: globalDir,
      },
    ],
  });

  if (p.isCancel(selectedLocation)) {
    p.cancel("Installation cancelled.");
    process.exit(0);
  }

  // Step 3: Write methods
  const targetDir = selectedLocation === "global" ? globalDir : projectDir;
  mkdirSync(targetDir, { recursive: true });

  const installSpinner = p.spinner();
  for (const method of resolved.methods) {
    const installDir = resolve(join(targetDir, method.slug));
    installSpinner.start(`Installing "${method.slug}" to ${installDir}...`);

    mkdirSync(installDir, { recursive: true });

    // Write METHODS.toml (verbatim raw string)
    writeFileSync(join(installDir, "METHODS.toml"), method.rawManifest, "utf-8");

    // Write all .mthds files, preserving directory structure
    for (const file of method.files) {
      const filePath = resolve(join(installDir, file.relativePath));
      if (!filePath.startsWith(installDir + "/")) {
        throw new Error(`Path traversal detected: "${file.relativePath}" escapes install directory.`);
      }
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, file.content, "utf-8");
    }

    const fileCount = method.files.length;
    const filesMsg = fileCount === 0
      ? "(manifest only)"
      : `(${fileCount} .mthds file${fileCount > 1 ? "s" : ""})`;

    installSpinner.stop(`Installed "${method.slug}" to ${installDir} ${filesMsg}`);

    // Generate CLI shim
    generateShim(method.slug, installDir);
  }

  // PATH advisory for CLI shims
  const shimBinDir = join(homedir(), ".mthds", "bin");
  if (existsSync(shimBinDir) && !process.env.PATH?.split(":").includes(shimBinDir)) {
    p.log.warning(
      `Add ${shimBinDir} to your PATH to use methods as CLI commands:\n` +
      `  echo 'export PATH="${shimBinDir}:$PATH"' >> ~/.zshrc && source ~/.zshrc`
    );
  }

  // Step 4: Track telemetry only for public GitHub repositories
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
        manifest_raw: method.rawManifest,
      });
    }
  }

  // Step 5: Optional pipelex runner install
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

  // Step 6: Optional MTHDS skills
  const SKILLS_REPO = "https://github.com/mthds-ai/skills";

  const wantsSkills = await p.confirm({
    message: "Do you want to install the MTHDS skills?",
    initialValue: true,
  });

  if (p.isCancel(wantsSkills)) {
    p.cancel("Installation cancelled.");
    process.exit(0);
  }

  if (wantsSkills) {
    const skillsLocation = await p.select<string>({
      message: "Where should the skills be installed?",
      options: [
        { value: "global", label: "Global", hint: "Available everywhere" },
        { value: "project", label: "Project", hint: "Current project only" },
      ],
    });

    if (p.isCancel(skillsLocation)) {
      p.cancel("Installation cancelled.");
      process.exit(0);
    }

    const selectedAgent = await p.select<string>({
      message: "Which agent should the skills be installed for?",
      options: [
        { value: "claude-code", label: "Claude Code" },
        { value: "cursor", label: "Cursor" },
        { value: "codex", label: "Codex" },
      ],
    });

    if (p.isCancel(selectedAgent)) {
      p.cancel("Installation cancelled.");
      process.exit(0);
    }

    const globalFlag = skillsLocation === "global" ? " -g" : "";
    const locationLabel = skillsLocation === "global" ? "globally" : "locally";
    const sk = p.spinner();
    sk.start(`Installing MTHDS skills ${locationLabel} for ${selectedAgent}...`);
    try {
      await execAsync(`npx skills add ${SKILLS_REPO} --skill '*' --agent ${selectedAgent}${globalFlag} -y`, {
        cwd: process.cwd(),
      });
      sk.stop(`MTHDS skills installed ${locationLabel} for ${selectedAgent}.`);
    } catch {
      sk.stop("Failed to install MTHDS skills.");
      p.log.warning(`Could not install MTHDS skills. You can retry manually:\n  npx skills add ${SKILLS_REPO} --skill '*' --agent ${selectedAgent}${globalFlag}`);
    }
  }

  p.outro("Done");
  await shutdown();
}
