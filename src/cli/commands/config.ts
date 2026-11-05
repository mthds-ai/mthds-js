import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import {
  VALID_KEYS,
  resolveKey,
  getConfigValue,
  setConfigValue,
  listConfig,
  isValidBaseUrl,
  isValidTelemetryValue,
  TELEMETRY_VALUE_HINT,
} from "../../config/config.js";
import type { ConfigKey } from "../../config/config.js";
import { RUNNER_NAMES } from "../../runners/types.js";
import type { RunnerType } from "../../runners/types.js";
import { maskUrlCredentials, shownConfigValue } from "../../config/secrets.js";

/** A setting's value as these commands print it: `shownConfigValue`'s, and `(not set)` for an empty one. */
function displayed(key: ConfigKey, value: string): string {
  return shownConfigValue(key, value).value || "(not set)";
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
  if (configKey === "runner" && !RUNNER_NAMES.includes(value as RunnerType)) {
    p.log.error(`Invalid runner: ${value}`);
    p.log.info(`Valid runners: ${RUNNER_NAMES.join(", ")}`);
    p.outro("");
    process.exit(1);
  }

  if (configKey === "baseUrl" && !isValidBaseUrl(value)) {
    p.log.error(`Invalid URL: ${maskUrlCredentials(value)}`);
    p.outro("");
    process.exit(1);
  }

  if (configKey === "telemetry" && !isValidTelemetryValue(value)) {
    p.log.error(`Invalid value for telemetry: ${value}`);
    p.log.info(TELEMETRY_VALUE_HINT);
    p.outro("");
    process.exit(1);
  }

  setConfigValue(configKey, value);
  p.log.success(`${cliKey} = ${displayed(configKey, value)}`);
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
  p.log.info(`${cliKey} = ${displayed(configKey, value)}${sourceLabel}`);
  p.outro("");
}

export async function configList(): Promise<void> {
  printLogo();
  p.intro("mthds config list");

  const entries = listConfig();
  for (const entry of entries) {
    const sourceLabel =
      entry.source === "env" ? " (from env)" : entry.source === "default" ? " (default)" : "";
    p.log.info(`${entry.cliKey} = ${displayed(entry.key, entry.value)}${sourceLabel}`);
  }
  p.outro("");
}
