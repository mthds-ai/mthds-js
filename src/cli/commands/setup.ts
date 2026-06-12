import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import { isPipelexInstalled } from "../../installer/runtime/check.js";
import { ensureRuntime } from "../../installer/runtime/installer.js";
import { shutdown } from "../../installer/telemetry/posthog.js";
import { printLogo } from "./index.js";
import { DEFAULT_BASE_URL, getConfigValue, isValidBaseUrl, setConfigValue } from "../../config/config.js";
import { Runners, RUNNER_NAMES } from "../../runners/types.js";
import { maskApiKey } from "./utils.js";

const execFileAsync = promisify(execFile);

// ── mthds runner setup <name> ───────────────────────────────────────

async function initApi(): Promise<void> {
  const { value: currentBaseUrl, source: baseUrlSource } =
    getConfigValue("baseUrl");
  const { value: currentKey } = getConfigValue("apiKey");

  const validateUrl = (val: string | undefined): string | undefined => {
    if (!val) return undefined; // empty resets to the default
    if (!isValidBaseUrl(val)) {
      return "Must be a host-only http(s) URL — no path (e.g. https://api.pipelex.com)";
    }
    return undefined;
  };

  const baseUrl = await p.text({
    message:
      "API base URL (host only, e.g. https://api.pipelex.com or http://localhost:8081)",
    placeholder: currentBaseUrl,
    initialValue: baseUrlSource !== "default" ? currentBaseUrl : "",
    validate: validateUrl,
  });

  if (p.isCancel(baseUrl)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  const maskedKey = currentKey ? maskApiKey(currentKey) : undefined;

  const apiKey = await p.password({
    message: `API key${maskedKey ? ` (current: ${maskedKey})` : ""}`,
    mask: "*",
  });

  if (p.isCancel(apiKey)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  // Always persist: a non-empty value is saved; an emptied field resets a
  // previously-saved custom URL back to the default.
  setConfigValue("baseUrl", (baseUrl as string) || DEFAULT_BASE_URL);
  if (apiKey) {
    setConfigValue("apiKey", apiKey as string);
  }

  p.log.success("API configuration saved to ~/.mthds/config");
}

async function initPipelex(): Promise<void> {
  if (!isPipelexInstalled()) {
    p.log.step("pipelex is not installed. Installing...");
    await ensureRuntime();

    if (!isPipelexInstalled()) {
      p.log.error(
        "pipelex was installed but is not reachable. Make sure the uv tools bin directory is in your PATH."
      );
      process.exit(1);
    }

    p.log.success("pipelex installed successfully.");
  }

  p.log.step("Running pipelex init...");

  await new Promise<void>((resolve, reject) => {
    const child = spawn("pipelex", ["init"], {
      stdio: "inherit",
    });
    child.on("error", (err) =>
      reject(new Error(`pipelex not found: ${err.message}`))
    );
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`pipelex init exited with code ${code}`));
      }
    });
  });
}

async function askSetDefault(name: string): Promise<void> {
  const { value: currentDefault } = getConfigValue("runner");

  if (currentDefault === name) {
    p.log.info(`${name} is already the default runner.`);
    return;
  }

  const makeDefault = await p.confirm({
    message: `Set ${name} as the default runner? (current default: ${currentDefault})`,
    initialValue: true,
  });

  if (p.isCancel(makeDefault)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  if (makeDefault) {
    setConfigValue("runner", name);
    p.log.success(`Default runner set to ${name}.`);
  }
}

export async function setupRunner(name: string): Promise<void> {
  printLogo();
  p.intro("mthds runner setup");

  if (!RUNNER_NAMES.includes(name as typeof RUNNER_NAMES[number])) {
    p.log.error(`Unknown runner: ${name}`);
    p.log.info(`Available runners: ${RUNNER_NAMES.join(", ")}`);
    p.outro("");
    process.exit(1);
  }

  switch (name) {
    case Runners.API:
      await initApi();
      break;
    case Runners.PIPELEX:
      await initPipelex();
      break;
  }

  await askSetDefault(name);

  p.outro("Done");
  await shutdown();
}

// ── mthds runner set-default <name> ─────────────────────────────────

export async function setDefaultRunner(name: string): Promise<void> {
  printLogo();
  p.intro("mthds runner set-default");

  if (!RUNNER_NAMES.includes(name as typeof RUNNER_NAMES[number])) {
    p.log.error(`Unknown runner: ${name}`);
    p.log.info(`Available runners: ${RUNNER_NAMES.join(", ")}`);
    p.outro("");
    process.exit(1);
  }

  const { value: currentDefault } = getConfigValue("runner");

  if (currentDefault === name) {
    p.log.info(`${name} is already the default runner.`);
  } else {
    setConfigValue("runner", name);
    p.log.success(`Default runner set to ${name}.`);
  }

  p.outro("Done");
}

// ── mthds runner status ────────────────────────────────────────────

async function getPipelexVersion(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("pipelex", ["--version"], {
      encoding: "utf-8",
    });
    return stdout.trim();
  } catch {
    return "not installed";
  }
}

export async function runnerStatus(): Promise<void> {
  printLogo();
  p.intro("mthds runner status");

  const { value: defaultRunner, source: runnerSource } = getConfigValue("runner");
  const sourceLabel = runnerSource === "env" ? " (from env)" : runnerSource === "default" ? " (default)" : "";
  p.log.info(`Default runner: ${defaultRunner}${sourceLabel}`);

  // API runner
  const { value: baseUrl } = getConfigValue("baseUrl");
  const { value: apiKey } = getConfigValue("apiKey");
  p.log.message(`\n  API runner`);
  p.log.message(`    Base URL: ${baseUrl}`);
  p.log.message(`    API key:  ${maskApiKey(apiKey)}`);

  // Pipelex runner
  const pipelexVersion = await getPipelexVersion();
  p.log.message(`\n  Pipelex runner`);
  p.log.message(`    Version: ${pipelexVersion}`);

  p.outro("");
}
