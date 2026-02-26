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
        'powershell -Command "irm https://pipelex-website.vercel.app/install.ps1 | iex"',
        { stdio: "pipe" }
      );
    } else {
      execSync(
        "curl -fsSL https://pipelex-website.vercel.app/install.sh | sh",
        { stdio: "pipe", shell: "/bin/sh" }
      );
    }
  } catch (error) {
    spinner.fail("Failed to install pipelex");
    const msg =
      error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not install pipelex: ${msg}\n` +
        "Install manually: https://pipelex-website.vercel.app"
    );
  }

  if (!isPipelexInstalled()) {
    spinner.fail("pipelex was installed but is not reachable");
    throw new Error(
      "pipelex was installed but is not found in PATH.\n" +
        "You may need to restart your shell or add the install directory to your PATH."
    );
  }

  spinner.succeed("pipelex installed");
}
