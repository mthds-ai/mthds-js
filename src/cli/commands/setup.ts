import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import { isPipelexInstalled } from "../../installer/runtime/check.js";
import { ensureRuntime } from "../../installer/runtime/installer.js";
import { shutdown } from "../../installer/telemetry/posthog.js";
import { printLogo } from "./index.js";
import { getConfigValue, setConfigValue } from "../../config/config.js";
import { Runners, RUNNER_NAMES } from "../../runners/types.js";

// ── mthds setup runner <name> ───────────────────────────────────────

async function initApi(): Promise<void> {
  const { value: currentUrl, source: urlSource } = getConfigValue("apiUrl");
  const { value: currentKey } = getConfigValue("apiKey");

  const apiUrl = await p.text({
    message: "API URL",
    placeholder: currentUrl,
    initialValue: urlSource !== "default" ? currentUrl : "",
    validate: (val) => {
      if (!val) return undefined; // will use default
      try {
        new URL(val);
      } catch {
        return "Must be a valid URL";
      }
    },
  });

  if (p.isCancel(apiUrl)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  const maskedKey = currentKey
    ? `${currentKey.slice(0, 5)}${"*".repeat(Math.max(0, currentKey.length - 5))}`
    : undefined;

  const apiKey = await p.password({
    message: `API key${maskedKey ? ` (current: ${maskedKey})` : ""}`,
    mask: "*",
  });

  if (p.isCancel(apiKey)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  if (apiUrl) {
    setConfigValue("apiUrl", apiUrl);
  }
  if (apiKey) {
    setConfigValue("apiKey", apiKey as string);
  }

  p.log.success("API credentials saved to ~/.mthds/credentials");
}

async function initPipelex(): Promise<void> {
  if (!isPipelexInstalled()) {
    p.log.step("pipelex is not installed. Installing...");
    await ensureRuntime();
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
  p.intro("mthds setup runner");

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

// ── mthds set-default runner <name> ─────────────────────────────────

export async function setDefaultRunner(name: string): Promise<void> {
  printLogo();
  p.intro("mthds set-default runner");

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

// ── mthds runner status ─────────────────────────────────────────────

const execFileAsync = promisify(execFile);

function maskApiKey(key: string): string {
  if (!key) return "(not set)";
  return `${key.slice(0, 5)}${"*".repeat(Math.max(0, key.length - 5))}`;
}

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
  const { value: apiUrl } = getConfigValue("apiUrl");
  const { value: apiKey } = getConfigValue("apiKey");
  p.log.message(`\n  API runner`);
  p.log.message(`    URL:     ${apiUrl}`);
  p.log.message(`    API key: ${maskApiKey(apiKey)}`);

  // Pipelex runner
  const pipelexVersion = await getPipelexVersion();
  p.log.message(`\n  Pipelex runner`);
  p.log.message(`    Version: ${pipelexVersion}`);

  p.outro("");
}
