import { join, resolve, delimiter } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { isPipelexInstalled } from "../../installer/runtime/check.js";
import { ensureRuntime } from "../../installer/runtime/installer.js";
import { shutdown } from "../../installer/telemetry/posthog.js";
import { printLogo } from "./index.js";
import { parseAddress } from "../../installer/resolver/address.js";
import { resolveFromGitHub } from "../../installer/resolver/github.js";
import { resolveFromLocal } from "../../installer/resolver/local.js";
import { runInstallFlow } from "../../installer/methods/install-flow.js";
import type { InstallFlowResult } from "../../installer/methods/install-flow.js";
import { InstallLocation } from "../../installer/methods/types.js";
import { createRunner } from "../../runners/registry.js";
import { collectAllExportedPipes } from "../../package/manifest/validate.js";
import type { ParsedAddress, ResolvedRepo } from "../../package/manifest/types.js";
import type { Runner, RunnerType } from "../../runners/types.js";

function getShellRcFile(): string {
  const shell = process.env.SHELL ?? "";
  if (shell.endsWith("/zsh")) return "~/.zshrc";
  if (shell.endsWith("/bash")) return "~/.bashrc";
  if (shell.endsWith("/fish")) return "~/.config/fish/config.fish";
  return "your shell profile";
}

export async function installMethod(options: {
  address?: string;
  dir?: string;
  method?: string;
  runner?: RunnerType;
}): Promise<void> {
  printLogo();
  p.intro("mthds install");

  const { address, dir, method: methodFilter } = options;

  // Step 0: Resolve repo (multiple methods)
  const s = p.spinner();
  s.start("Resolving methods...");
  let resolved: ResolvedRepo;

  // Derive org/repo for telemetry
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

    // Derive org/repo from first method's package.address (strip github.com/ prefix)
    if (resolved.methods.length > 0) {
      const addr = resolved.methods[0]!.manifest.package.address;
      orgRepo = addr.replace(/^github\.com\//, "");
    }
  } else if (address) {
    let parsed: ParsedAddress;
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
    p.log.error("Provide an address (org/repo) or use --dir <path>.");
    p.outro("");
    process.exit(1);
  }

  // Filter by --method if provided
  if (methodFilter) {
    const match = resolved.methods.find((method) => method.name === methodFilter);
    if (!match) {
      const available = resolved.methods.map((method) => method.name).join(", ");
      p.log.error(
        `Method "${methodFilter}" not found. Available methods: ${available || "(none)"}`
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
    const pkg = method.manifest.package;
    const fileCount = method.files.length;
    p.log.success(
      [
        `${chalk.bold(method.name)} — ${pkg.display_name ?? pkg.address} v${pkg.version}`,
        `  ${pkg.description}`,
        `  ${fileCount} .mthds file${fileCount !== 1 ? "s" : ""}`,
      ].join("\n")
    );
  }

  // Show skipped methods with errors
  for (const skip of resolved.skipped) {
    const errList = skip.errors.map((errMsg) => `    - ${errMsg}`).join("\n");
    p.log.warning(
      `${chalk.bold(skip.dirName)} — skipped:\n${errList}`
    );
  }

  // If no valid methods, exit
  if (validCount === 0) {
    p.log.error("No valid methods to install.");
    p.outro("");
    process.exit(1);
  }

  // Step 1b: Ensure runner is configured
  let runner: Runner | null = null;
  const healthSpinner = p.spinner();
  try {
    healthSpinner.start("Checking runner health...");
    runner = createRunner(options.runner);
    await runner.health();
    const ver = await runner.version().catch(() => ({}));
    const versionStr = Object.values(ver).join(" ") || "unknown";
    healthSpinner.stop(`Runner ${chalk.bold(runner.type)} is healthy (${versionStr})`);
  } catch {
    healthSpinner.stop("Runner not available.");
    p.log.warning(
      `No runner configured — skipping pipe validation.\n` +
      `  Set up a runner with: ${chalk.cyan("npx mthds runner setup pipelex")}`
    );
    runner = null;
  }

  // Step 1c: Validate each method with the runner
  if (runner) {
    const valSpinner = p.spinner();
    let allValid = true;
    for (const method of resolved.methods) {
      // Construct method URL: GitHub URL or local path
      let methodUrl: string;
      if (dir) {
        methodUrl = resolve(dir, "methods", method.name);
      } else {
        methodUrl = `https://github.com/${orgRepo}/methods/${method.name}/`;
      }

      // Determine which pipes to validate
      const mainPipe = method.manifest.package.main_pipe;
      const pipesToValidate: string[] = mainPipe
        ? [mainPipe]
        : method.manifest.exports
          ? collectAllExportedPipes(method.manifest.exports)
          : [];

      if (pipesToValidate.length === 0) {
        continue; // No pipes to validate
      }

      for (const pipeCode of pipesToValidate) {
        valSpinner.start(`Validating ${method.name}:${pipeCode}...`);
        try {
          const result = await runner.validate({ method_url: methodUrl, pipe_code: pipeCode });
          if (!result.success) {
            valSpinner.stop(`Validation failed: ${method.name}:${pipeCode}`);
            p.log.error(`${method.name}:${pipeCode}: ${result.message}`);
            allValid = false;
          } else {
            valSpinner.stop(`Validated ${method.name}:${pipeCode}`);
          }
        } catch (err) {
          valSpinner.stop(`Validation failed: ${method.name}:${pipeCode}`);
          p.log.error(`${method.name}:${pipeCode}: ${(err as Error).message}`);
          allValid = false;
        }
      }
    }
    if (!allValid) {
      p.log.error("One or more methods failed validation. Aborting install.");
      p.outro("");
      process.exit(1);
    }
  }


  // Step 2: Install location (project-local or global)
  const projectDir = join(process.cwd(), ".mthds", "methods");
  const globalDir = join(homedir(), ".mthds", "methods");

  const selectedLocation = await p.select<InstallLocation>({
    message: "Where do you want to install these methods?",
    options: [
      {
        value: InstallLocation.Local,
        label: "Project",
        hint: projectDir,
      },
      {
        value: InstallLocation.Global,
        label: "Global",
        hint: globalDir,
      },
    ],
  });

  if (p.isCancel(selectedLocation)) {
    p.cancel("Installation cancelled.");
    process.exit(0);
  }

  // Step 3: Write methods (shared flow handles target dir + telemetry + writes + shims)
  const installSpinner = p.spinner();
  installSpinner.start(
    validCount === 1
      ? `Installing "${resolved.methods[0]!.name}"...`
      : `Installing ${validCount} methods...`
  );
  let result: InstallFlowResult;
  try {
    result = runInstallFlow({ resolved, location: selectedLocation, orgRepo });
  } catch (err) {
    installSpinner.stop("Installation failed.");
    p.log.error((err as Error).message);
    p.outro("");
    process.exit(1);
  }
  installSpinner.stop(`Installed to ${result.targetDir}`);

  for (const method of resolved.methods) {
    const fileCount = method.files.length;
    const filesMsg = fileCount === 0
      ? "(manifest only)"
      : `(${fileCount} .mthds file${fileCount > 1 ? "s" : ""})`;
    p.log.success(`${method.name} ${filesMsg}`);
  }

  // PATH advisory for CLI shims
  if (existsSync(result.shimDir) && !process.env.PATH?.split(delimiter).includes(result.shimDir)) {
    const rcFile = getShellRcFile();
    p.log.warning(
      `Add ${result.shimDir} to your PATH to use methods as CLI commands:\n` +
      `  echo 'export PATH="${result.shimDir}:$PATH"' >> ${rcFile} && source ${rcFile}`
    );
  }

  // Step 4: Optional pipelex runner install (only if not already available)
  if (!isPipelexInstalled()) {
    const wantsRunner = await p.confirm({
      message: "Do you want to install the pipelex runner? (https://github.com/Pipelex/pipelex)",
      initialValue: false,
    });

    if (p.isCancel(wantsRunner)) {
      p.cancel("Installation cancelled.");
      process.exit(0);
    }

    if (wantsRunner) {
      await ensureRuntime();
      p.log.success("pipelex installed.");
    }
  }

  p.outro("Done");
  await shutdown();
}
