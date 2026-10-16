/**
 * Agent config commands — manage configuration with JSON output.
 */

import { agentSuccess, agentError, agentProblem } from "../output.js";
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
import { RUNNER_NAMES } from "../../runners/types.js";
import type { RunnerType } from "../../runners/types.js";

export async function agentConfigSet(cliKey: string, value: string): Promise<void> {
  const configKey = resolveKey(cliKey);
  if (!configKey) {
    agentError(
      agentProblem(
        "client.argument_invalid",
        { argument: "key", reason: "unknown_key" },
        `Unknown config key: ${cliKey}. Valid keys: ${VALID_KEYS.join(", ")}`,
      ),
    );
  }

  if (configKey === "runner" && !RUNNER_NAMES.includes(value as RunnerType)) {
    agentError(
      agentProblem(
        "client.argument_invalid",
        { argument: "value", reason: "unknown_runner" },
        `Invalid runner: ${value}. Valid runners: ${RUNNER_NAMES.join(", ")}`,
      ),
    );
  }

  if (configKey === "baseUrl" && !isValidBaseUrl(value)) {
    agentError(
      agentProblem(
        "client.argument_invalid",
        { argument: "value", reason: "invalid_base_url" },
        `Invalid URL: ${value}`,
      ),
    );
  }

  if (configKey === "telemetry" && !isValidTelemetryValue(value)) {
    agentError(
      agentProblem(
        "client.argument_invalid",
        { argument: "value", reason: "unknown_value" },
        `Invalid value for telemetry: ${value}. ${TELEMETRY_VALUE_HINT}`,
      ),
    );
  }

  setConfigValue(configKey, value);
  agentSuccess({ success: true, key: cliKey, value });
}

export async function agentConfigGet(cliKey: string): Promise<void> {
  const configKey = resolveKey(cliKey);
  if (!configKey) {
    agentError(
      agentProblem(
        "client.argument_invalid",
        { argument: "key", reason: "unknown_key" },
        `Unknown config key: ${cliKey}. Valid keys: ${VALID_KEYS.join(", ")}`,
      ),
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
