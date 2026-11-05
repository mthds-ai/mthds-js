/**
 * Agent config commands — manage configuration with JSON output.
 *
 * A value is answered as `shownConfigValue` shows it: the API key masked and a URL's credentials
 * hidden, with `masked: true` beside a value that is not the one set, so an agent session never
 * copies a secret into its transcript. No command answers the API key whole.
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
import { maskUrlCredentials, shownConfigValue } from "../../config/secrets.js";
import type { ShownConfigValue } from "../../config/secrets.js";
import { RUNNER_NAMES } from "../../runners/types.js";
import type { RunnerType } from "../../runners/types.js";

/** A shown value's members: `value`, and `masked: true` only when a secret of it was hidden. */
function shownMembers(shown: ShownConfigValue): { value: string; masked?: true } {
  return shown.masked ? { value: shown.value, masked: true } : { value: shown.value };
}

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
        `Invalid URL: ${maskUrlCredentials(value)}`,
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
  agentSuccess({ success: true, key: cliKey, ...shownMembers(shownConfigValue(configKey, value)) });
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
  agentSuccess({ key: cliKey, ...shownMembers(shownConfigValue(configKey, value)), source });
}

export async function agentConfigList(): Promise<void> {
  const entries = listConfig();
  agentSuccess({
    config: entries.map((e) => ({
      key: e.cliKey,
      ...shownMembers(shownConfigValue(e.key, e.value)),
      source: e.source,
    })),
  });
}
