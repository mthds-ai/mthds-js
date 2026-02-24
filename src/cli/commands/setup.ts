import * as p from "@clack/prompts";
import { isPipelexInstalled } from "../../installer/runtime/check.js";
import { ensureRuntime } from "../../installer/runtime/installer.js";
import { shutdown } from "../../installer/telemetry/posthog.js";
import { printLogo } from "./index.js";
import { getConfigValue, setConfigValue } from "../../config/config.js";
import { Runners, RUNNER_NAMES } from "../../runners/types.js";

async function setupApi(): Promise<void> {
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

async function setupPipelex(): Promise<void> {
  if (isPipelexInstalled()) {
    p.log.success("pipelex is already installed.");
  } else {
    await ensureRuntime();
    p.log.success("pipelex installed successfully.");
  }
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

export async function installRunner(name: string): Promise<void> {
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
      await setupApi();
      break;
    case Runners.PIPELEX:
      await setupPipelex();
      break;
  }

  await askSetDefault(name);

  p.outro("Done");
  await shutdown();
}
