import { execFileSync, execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import ora from "ora";
import { isPipelexInstalled } from "./check.js";
import { BINARY_RECOVERY } from "../../agent/binaries.js";

// All binary installation goes through uv, which provides version-constraint-aware
// installs and consistent cross-platform behavior.

// ── uv presence / auto-install ─────────────────────────────────────

/**
 * Check whether `uv` is on PATH without throwing.
 */
export function isUvInstalled(): boolean {
  try {
    execFileSync("uv", ["--version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Install uv via the official install script and add its bin dir to PATH
 * for the current process. Throws on failure.
 */
export function installUv(): void {
  const isWindows = process.platform === "win32";
  const uvBinDir = isWindows
    ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "uv", "bin")
    : join(homedir(), ".local", "bin");

  const cmd = isWindows
    ? 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
    : "curl -LsSf https://astral.sh/uv/install.sh | sh";

  try {
    execSync(cmd, { stdio: "pipe", timeout: 30_000 });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
    const detail = stderr || (err instanceof Error ? err.message : String(err));
    throw new Error(`Failed to install uv: ${detail}`);
  }

  // Make uv available in the current process
  const sep = isWindows ? ";" : ":";
  if (!process.env.PATH?.includes(uvBinDir)) {
    process.env.PATH = `${uvBinDir}${sep}${process.env.PATH}`;
  }
}

// ── Async install (interactive, with spinner) ────────────────────────

/**
 * Ensure pipelex is installed, using uv tool install with spinner feedback.
 * Used by interactive CLI commands (mthds install, mthds setup, etc.).
 */
export async function ensureRuntime(): Promise<void> {
  if (!isPipelexInstalled()) {
    await installPipelexViaUv();
  }
}

async function installPipelexViaUv(): Promise<void> {
  const spinner = ora("Installing pipelex via uv...").start();
  const recovery = BINARY_RECOVERY["pipelex"];
  if (!recovery) {
    spinner.fail("pipelex recovery info is missing — this is a bug.");
    throw new Error("BINARY_RECOVERY is missing the 'pipelex' entry.");
  }
  try {
    uvToolInstallSync(recovery.uv_package, recovery.version_constraint);
  } catch (error) {
    spinner.fail("Failed to install pipelex");
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Could not install pipelex: ${msg}\n` +
        `Install manually: uv tool install --upgrade "${recovery.uv_package}${recovery.version_constraint}"`
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

// ── uv helpers ──────────────────────────────────────────────────────

/**
 * Locate the `uv` binary. Throws with install instructions if not found.
 */
export function requireUv(): string {
  try {
    execFileSync("uv", ["--version"], { stdio: "ignore", timeout: 5000 });
    return "uv";
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") {
      throw new Error(
        "uv is required but not found in PATH. Install it: https://docs.astral.sh/uv/getting-started/installation/"
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`uv was found but failed to run: ${msg}`);
  }
}

/**
 * Install or upgrade a Python tool via `uv tool install`.
 * Uses execFileSync (no shell) for cross-platform safety.
 *
 * @param pkg - PyPI package name (e.g. "pipelex")
 * @param versionConstraint - Optional semver range appended to the package spec (e.g. ">=0.22.0").
 */
export function uvToolInstallSync(
  pkg: string,
  versionConstraint?: string
): void {
  const uv = requireUv();
  const spec = versionConstraint ? `${pkg}${versionConstraint}` : pkg;
  try {
    execFileSync(uv, ["tool", "install", "--upgrade", spec], { stdio: "pipe", timeout: 60000 });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
    const detail = stderr || (err instanceof Error ? err.message : String(err));
    throw new Error(`uv tool install failed for "${spec}": ${detail}`);
  }
}
