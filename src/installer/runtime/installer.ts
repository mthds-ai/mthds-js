import { execSync } from "node:child_process";
import ora from "ora";
import { isPipelexInstalled } from "./check.js";

export async function ensureRuntime(): Promise<void> {
  if (!isPipelexInstalled()) {
    await installPipelex();
  }
}

async function installPipelex(): Promise<void> {
  const spinner = ora("Installing pipelex...").start();
  try {
    if (process.platform === "win32") {
      execSync(
        'powershell -Command "irm https://pipelex.com/install.ps1 | iex"',
        { stdio: "ignore" }
      );
    } else {
      execSync("curl -fsSL https://pipelex.com/install.sh | sh", {
        stdio: "ignore",
        shell: "/bin/sh",
      });
    }
    spinner.succeed("pipelex installed");
  } catch (error) {
    spinner.fail("Failed to install pipelex");
    throw new Error(
      "Could not install pipelex. Please install it manually: https://pipelex.com"
    );
  }
}
