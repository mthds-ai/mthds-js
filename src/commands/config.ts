import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import {
  VALID_KEYS,
  resolveKey,
  getConfigValue,
  setConfigValue,
  listConfig,
} from "../config/config.js";
import type { RunnerType } from "../runners/types.js";

const VALID_RUNNERS: RunnerType[] = ["api", "pipelex"];

function isValidUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

export async function configSet(cliKey: string, value: string): Promise<void> {
  printLogo();
  p.intro("mthds config set");

  const configKey = resolveKey(cliKey);
  if (!configKey) {
    p.log.error(`Unknown config key: ${cliKey}`);
    p.log.info(`Valid keys: ${VALID_KEYS.join(", ")}`);
    p.outro("");
    process.exit(1);
  }

  // Validate value
  if (configKey === "runner" && !VALID_RUNNERS.includes(value as RunnerType)) {
    p.log.error(`Invalid runner: ${value}`);
    p.log.info(`Valid runners: ${VALID_RUNNERS.join(", ")}`);
    p.outro("");
    process.exit(1);
  }

  if (configKey === "apiUrl" && !isValidUrl(value)) {
    p.log.error(`Invalid URL: ${value}`);
    p.outro("");
    process.exit(1);
  }

  setConfigValue(configKey, value);
  p.log.success(`${cliKey} = ${value}`);
  p.outro("");
}

export async function configGet(cliKey: string): Promise<void> {
  printLogo();
  p.intro("mthds config get");

  const configKey = resolveKey(cliKey);
  if (!configKey) {
    p.log.error(`Unknown config key: ${cliKey}`);
    p.log.info(`Valid keys: ${VALID_KEYS.join(", ")}`);
    p.outro("");
    process.exit(1);
  }

  const { value, source } = getConfigValue(configKey);
  const sourceLabel = source === "env" ? " (from env)" : source === "default" ? " (default)" : "";
  p.log.info(`${cliKey} = ${value}${sourceLabel}`);
  p.outro("");
}

export async function configList(): Promise<void> {
  printLogo();
  p.intro("mthds config list");

  const entries = listConfig();
  for (const entry of entries) {
    const sourceLabel =
      entry.source === "env"
        ? " (from env)"
        : entry.source === "default"
          ? " (default)"
          : "";
    p.log.info(`${entry.cliKey} = ${entry.value}${sourceLabel}`);
  }
  p.outro("");
}
