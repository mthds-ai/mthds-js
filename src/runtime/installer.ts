import { execSync, execFileSync } from "node:child_process";
import ora from "ora";
import { isUvInstalled, isPipelexInstalled } from "./check.js";

export async function ensureRuntime(): Promise<void> {
  if (!isUvInstalled()) {
    await installUv();
  }

  if (!isPipelexInstalled()) {
    await installPipelex();
  }
}

async function installUv(): Promise<void> {
  const spinner = ora("Installing uv runtime...").start();
  try {
    execSync("curl -LsSf https://astral.sh/uv/install.sh | sh", {
      stdio: "ignore",
      shell: "/bin/sh",
    });
    spinner.succeed("uv installed");
  } catch (error) {
    spinner.fail("Failed to install uv");
    throw new Error(
      "Could not install uv. Please install it manually: https://docs.astral.sh/uv/getting-started/installation/"
    );
  }
}

async function installPipelex(): Promise<void> {
  const spinner = ora("Setting up pipelex runtime...").start();
  try {
    execFileSync("uv", ["tool", "install", "pipelex"], {
      stdio: "ignore",
    });
    spinner.succeed("pipelex installed");
  } catch (error) {
    spinner.fail("Failed to install pipelex");
    throw new Error(
      "Could not install pipelex via uv. Try manually: uv tool install pipelex"
    );
  }
}
