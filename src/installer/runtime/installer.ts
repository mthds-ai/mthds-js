import { execSync } from "node:child_process";
import ora from "ora";
import { isPipelexInstalled } from "./check.js";

// ── Shared helpers ───────────────────────────────────────────────────

function runPipelexInstallSync(): void {
  if (process.platform === "win32") {
    execSync(
      'powershell -Command "irm https://pipelex.com/install.ps1 | iex"',
      { stdio: "pipe" }
    );
  } else {
    execSync(
      "curl -fsSL https://pipelex.com/install.sh | sh",
      { stdio: "pipe", shell: "/bin/sh" }
    );
  }
}

// ── Async install (interactive, with spinner) ────────────────────────

export async function ensureRuntime(): Promise<void> {
  if (!isPipelexInstalled()) {
    await installPipelex();
  }
}

async function installPipelex(): Promise<void> {
  const spinner = ora("Installing pipelex...").start();
  try {
    runPipelexInstallSync();
  } catch (error) {
    spinner.fail("Failed to install pipelex");
    const msg =
      error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not install pipelex: ${msg}\n` +
        "Install manually: https://pipelex.com"
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

// ── Sync silent install functions (for mthds-agent --auto-install) ──

/**
 * Install pipelex synchronously without interactive output (no spinner).
 * Throws on failure.
 */
export function installPipelexSync(): void {
  runPipelexInstallSync();
}

/**
 * Install pipelex-tools (plxt) synchronously without interactive output.
 * Throws on failure.
 */
export function installPlxtSync(): void {
  const pythonCmd = process.platform === "win32" ? "python" : "python3";
  execSync(`${pythonCmd} -m pip install --quiet pipelex-tools`, { stdio: "pipe" });
}
