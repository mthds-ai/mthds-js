/**
 * Agent config commands — manage configuration with JSON output.
 */

import { agentSuccess, agentError, AGENT_ERROR_DOMAINS } from "../output.js";
import {
  VALID_KEYS,
  resolveKey,
  getConfigValue,
  setConfigValue,
  listConfig,
} from "../../config/config.js";
import { RUNNER_NAMES } from "../../runners/types.js";
import type { RunnerType } from "../../runners/types.js";

function isValidUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

export async function agentConfigSet(
  cliKey: string,
  value: string
): Promise<void> {
  const configKey = resolveKey(cliKey);
  if (!configKey) {
    agentError(
      `Unknown config key: ${cliKey}. Valid keys: ${VALID_KEYS.join(", ")}`,
      "ConfigError",
      { error_domain: AGENT_ERROR_DOMAINS.CONFIG }
    );
  }

  if (configKey === "runner" && !RUNNER_NAMES.includes(value as RunnerType)) {
    agentError(
      `Invalid runner: ${value}. Valid runners: ${RUNNER_NAMES.join(", ")}`,
      "ConfigError",
      { error_domain: AGENT_ERROR_DOMAINS.CONFIG }
    );
  }

  if (configKey === "apiUrl" && !isValidUrl(value)) {
    agentError(`Invalid URL: ${value}`, "ConfigError", {
      error_domain: AGENT_ERROR_DOMAINS.CONFIG,
    });
  }

  setConfigValue(configKey, value);
  agentSuccess({ success: true, key: cliKey, value });
}

export async function agentConfigGet(cliKey: string): Promise<void> {
  const configKey = resolveKey(cliKey);
  if (!configKey) {
    agentError(
      `Unknown config key: ${cliKey}. Valid keys: ${VALID_KEYS.join(", ")}`,
      "ConfigError",
      { error_domain: AGENT_ERROR_DOMAINS.CONFIG }
    );
  }

  const { value, source } = getConfigValue(configKey);
  agentSuccess({ key: cliKey, value, source });
}

export async function agentConfigList(): Promise<void> {
  const entries = listConfig();
  agentSuccess({
    config: entries.map((e) => ({
      key: e.cliKey,
      value: e.value,
      source: e.source,
    })),
  });
}
