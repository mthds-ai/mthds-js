import { join } from "node:path";
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { Runners } from "../runners/types.js";
import type { RunnerType } from "../runners/types.js";

// ── Types ──────────────────────────────────────────────────────────

export interface MthdsConfig {
  runner: RunnerType;
  /**
   * Base URL of the runner surface, INCLUDING its version prefix
   * (hosted: `.../runner/v1`; self-hosted: `http://<host>/api/v1`).
   * Runner endpoints (`/pipeline/execute`, `/validate`, `/build/*`, `/models`,
   * `/pipelex_version`) are appended to this; `/health` resolves to its origin.
   */
  runnerUrl: string;
  /**
   * Base URL of the platform surface, INCLUDING its version prefix
   * (hosted: `.../platform/v1`). Optional: when empty/undefined the SDK is in
   * self-hosted mode — durable run commands are disabled and `run pipe` falls
   * back to the runner's blocking `/pipeline/execute`.
   */
  platformUrl: string;
  apiKey: string;
  telemetry: boolean;
  autoUpgrade: boolean;
  updateCheck: boolean;
}

export type ConfigSource = "env" | "file" | "default";

// ── Paths ──────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".mthds");
const CONFIG_PATH = join(CONFIG_DIR, "config");

// ── Config keys ───────────────────────────────────────────────────

/** Map from config key to env var name */
const ENV_NAMES: Record<keyof MthdsConfig, string> = {
  runnerUrl: "PIPELEX_RUNNER_URL",
  platformUrl: "PIPELEX_PLATFORM_URL",
  apiKey: "PIPELEX_API_KEY",
  runner: "MTHDS_RUNNER",
  telemetry: "DISABLE_TELEMETRY",
  autoUpgrade: "MTHDS_AUTO_UPGRADE",
  updateCheck: "MTHDS_UPDATE_CHECK",
};

/** Map from config key to file key (used in ~/.mthds/config) */
const FILE_KEYS: Record<keyof MthdsConfig, string> = {
  runnerUrl: "PIPELEX_RUNNER_URL",
  platformUrl: "PIPELEX_PLATFORM_URL",
  apiKey: "PIPELEX_API_KEY",
  runner: "MTHDS_RUNNER",
  telemetry: "DISABLE_TELEMETRY",
  autoUpgrade: "MTHDS_AUTO_UPGRADE",
  updateCheck: "MTHDS_UPDATE_CHECK",
};

/** Hosted defaults. Each base includes its own version prefix. */
const DEFAULT_RUNNER_URL = "https://api.pipelex.com/runner/v1";
const DEFAULT_PLATFORM_URL = "https://api.pipelex.com/platform/v1";

/** Defaults */
const DEFAULTS: MthdsConfig = {
  runner: Runners.PIPELEX,
  runnerUrl: DEFAULT_RUNNER_URL,
  platformUrl: DEFAULT_PLATFORM_URL,
  apiKey: "",
  telemetry: true,
  autoUpgrade: false,
  updateCheck: true,
};

/** Map from CLI flag names (kebab-case) to config keys */
const KEY_ALIASES: Record<string, keyof MthdsConfig> = {
  runner: "runner",
  "runner-url": "runnerUrl",
  "platform-url": "platformUrl",
  "api-key": "apiKey",
  telemetry: "telemetry",
  "auto-upgrade": "autoUpgrade",
  "update-check": "updateCheck",
};

/** Legacy file/env key that this version replaces. Used only for fail-fast hints. */
const LEGACY_API_URL_KEY = "PIPELEX_API_URL";

/** One-line migration message used wherever a legacy `apiUrl` is detected. */
export const LEGACY_API_URL_MIGRATION_MESSAGE =
  "`apiUrl` is replaced by `runnerUrl` (required) + `platformUrl` (optional). " +
  "Hosted: runnerUrl=https://api.pipelex.com/runner/v1 ; " +
  "Self-host: runnerUrl=http://<host>/api/v1";

/**
 * Detect a leftover legacy `apiUrl`/`PIPELEX_API_URL` value (file or env).
 * Used by the api-runner request path to fail fast with a migration hint;
 * deliberately NOT consulted by `loadConfig()` so pure `pipelex`-runner flows
 * and unrelated commands are never blocked.
 */
export function hasLegacyApiUrl(): boolean {
  if (process.env[LEGACY_API_URL_KEY] !== undefined) return true;
  const file = readConfigFile();
  return LEGACY_API_URL_KEY in file;
}

// ── Boolean key sets ──────────────────────────────────────────────

/** Keys that store boolean values (coerced from "0"/"1" in file/env) */
const BOOLEAN_KEYS: Set<keyof MthdsConfig> = new Set([
  "telemetry",
  "autoUpgrade",
  "updateCheck",
]);

/** Boolean keys with inverted file semantics (DISABLE_TELEMETRY=1 → false) */
const INVERTED_BOOLEAN_KEYS: Set<keyof MthdsConfig> = new Set([
  "telemetry",
]);

/** Strings treated as truthy for boolean keys — used in both load and set paths */
const TRUTHY_STRINGS: ReadonlySet<string> = new Set(["true", "1", "yes", "on"]);

export const VALID_KEYS = Object.keys(KEY_ALIASES);

export function resolveKey(
  cliKey: string
): keyof MthdsConfig | undefined {
  return KEY_ALIASES[cliKey];
}

// ── Dotenv parser / serializer ─────────────────────────────────────

function parseDotenv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    result[key] = value;
  }
  return result;
}

function serializeDotenv(entries: Record<string, string>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    lines.push(`${key}=${value}`);
  }
  return lines.join("\n") + "\n";
}

// ── File I/O ───────────────────────────────────────────────────────

function readConfigFile(): Record<string, string> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return parseDotenv(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfigFile(entries: Record<string, string>): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, serializeDotenv(entries), "utf-8");
}

// ── Public API ─────────────────────────────────────────────────────

function coerceValue(
  key: keyof MthdsConfig,
  raw: string
): string | boolean {
  if (!BOOLEAN_KEYS.has(key)) return raw;
  const truthy = TRUTHY_STRINGS.has(raw.toLowerCase());
  return INVERTED_BOOLEAN_KEYS.has(key) ? !truthy : truthy;
}

function toFileValue(key: keyof MthdsConfig, value: string | boolean): string {
  if (!BOOLEAN_KEYS.has(key)) return String(value);
  const boolVal =
    typeof value === "boolean"
      ? value
      : TRUTHY_STRINGS.has(String(value).toLowerCase());
  return INVERTED_BOOLEAN_KEYS.has(key)
    ? (boolVal ? "0" : "1")
    : (boolVal ? "1" : "0");
}

export function loadConfig(): MthdsConfig {
  const file = readConfigFile();
  const merged = { ...DEFAULTS } as Record<string, unknown>;

  // Apply file values
  for (const [key, fileKey] of Object.entries(FILE_KEYS)) {
    if (fileKey in file) {
      merged[key] = coerceValue(key as keyof MthdsConfig, file[fileKey]!);
    }
  }

  // Env vars take precedence
  for (const [key, envName] of Object.entries(ENV_NAMES)) {
    const envVal = process.env[envName];
    if (envVal !== undefined) {
      merged[key] = coerceValue(key as keyof MthdsConfig, envVal);
    }
  }

  // The platform follows the runner. The durable run lifecycle (start/poll/
  // result by id) is a hosted Pipelex Platform feature; the open-source runner
  // has no run store. So unless the platform URL is explicitly chosen, it is
  // present ONLY when the runner is the hosted Pipelex runner. Pointing the
  // runner at a self-hosted URL therefore disables the platform automatically —
  // `config set runner-url <self-hosted>` is sufficient; you don't also have to
  // clear the platform URL (and you can't accidentally poll the hosted platform
  // for a run that executed on your local runner).
  const platformUrlExplicit =
    process.env[ENV_NAMES.platformUrl] !== undefined ||
    FILE_KEYS.platformUrl in file;
  if (!platformUrlExplicit) {
    // Compare against the hosted default with the trailing slash normalized away,
    // so a valid `…/runner/v1/` still counts as the hosted runner (and keeps the
    // durable platform) instead of being treated as self-hosted.
    const normalizedRunnerUrl = String(merged.runnerUrl).replace(/\/+$/, "");
    merged.platformUrl =
      normalizedRunnerUrl === DEFAULT_RUNNER_URL ? DEFAULT_PLATFORM_URL : "";
  }

  return merged as unknown as MthdsConfig;
}

export function getConfigValue(
  key: keyof MthdsConfig
): { value: string; source: ConfigSource } {
  const envName = ENV_NAMES[key];
  const envVal = process.env[envName];
  if (envVal !== undefined) {
    return { value: envVal, source: "env" };
  }

  const file = readConfigFile();
  const fileKey = FILE_KEYS[key];
  if (fileKey in file) {
    return { value: file[fileKey]!, source: "file" };
  }

  const defaultVal = DEFAULTS[key];
  if (BOOLEAN_KEYS.has(key)) {
    const boolDefault = defaultVal as boolean;
    if (INVERTED_BOOLEAN_KEYS.has(key)) {
      return { value: boolDefault ? "0" : "1", source: "default" };
    }
    return { value: boolDefault ? "1" : "0", source: "default" };
  }
  return { value: String(defaultVal), source: "default" };
}

export function setConfigValue(
  key: keyof MthdsConfig,
  value: string
): void {
  const file = readConfigFile();
  const fileKey = FILE_KEYS[key];
  if (BOOLEAN_KEYS.has(key)) {
    file[fileKey] = toFileValue(key, coerceBooleanInput(value));
  } else {
    file[fileKey] = value;
  }
  writeConfigFile(file);
}

/**
 * Normalize user-facing boolean input.
 * Accepts "true"/"false", "1"/"0", "yes"/"no", "on"/"off".
 */
function coerceBooleanInput(value: string): boolean {
  return TRUTHY_STRINGS.has(value.toLowerCase());
}

export function listConfig(): Array<{
  key: string;
  cliKey: string;
  value: string;
  source: ConfigSource;
}> {
  const result: Array<{
    key: string;
    cliKey: string;
    value: string;
    source: ConfigSource;
  }> = [];

  for (const [cliKey, configKey] of Object.entries(KEY_ALIASES)) {
    const { value, source } = getConfigValue(configKey);
    result.push({ key: configKey, cliKey, value, source });
  }

  return result;
}

// ── Telemetry helpers (for PostHog module) ─────────────────────────

export function isTelemetryEnabled(): boolean {
  return loadConfig().telemetry;
}

export function setTelemetryEnabled(enabled: boolean): void {
  setConfigValue("telemetry", enabled ? "true" : "false");
}

export function getTelemetrySource(): ConfigSource {
  return getConfigValue("telemetry").source;
}
