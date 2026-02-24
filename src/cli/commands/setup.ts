import * as p from "@clack/prompts";
import { isPipelexInstalled } from "../../installer/runtime/check.js";
import { ensureRuntime } from "../../installer/runtime/installer.js";
import { shutdown } from "../../installer/telemetry/posthog.js";
import { printLogo } from "./index.js";
import { getConfigValue, setConfigValue } from "../../config/config.js";

export async function installRunner(name: string): Promise<void> {
  printLogo();
  p.intro("mthds setup runner");

  if (name !== "pipelex") {
    p.log.error(`Unknown runner: ${name}`);
    p.log.info("Available runners: api (built-in), pipelex");
    p.outro("");
    process.exit(1);
  }

  if (isPipelexInstalled()) {
    p.log.success("pipelex is already installed.");
  } else {
    await ensureRuntime();
    p.log.success("pipelex installed successfully.");
  }

  // Ask to set as default
  const { value: currentDefault } = getConfigValue("runner");

  if (currentDefault === name) {
    p.log.info(`${name} is already the default runner.`);
  } else {
    const makeDefault = await p.confirm({
      message: `Set ${name} as the default runner? (current default: ${currentDefault})`,
      initialValue: false,
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

  p.outro("Done");
  await shutdown();
}
