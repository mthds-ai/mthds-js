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
  apiUrl: string;
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
  apiUrl: "PIPELEX_API_URL",
  apiKey: "PIPELEX_API_KEY",
  runner: "MTHDS_RUNNER",
  telemetry: "DISABLE_TELEMETRY",
  autoUpgrade: "MTHDS_AUTO_UPGRADE",
  updateCheck: "MTHDS_UPDATE_CHECK",
};

/** Map from config key to file key (used in ~/.mthds/config) */
const FILE_KEYS: Record<keyof MthdsConfig, string> = {
  apiUrl: "PIPELEX_API_URL",
  apiKey: "PIPELEX_API_KEY",
  runner: "MTHDS_RUNNER",
  telemetry: "DISABLE_TELEMETRY",
  autoUpgrade: "MTHDS_AUTO_UPGRADE",
  updateCheck: "MTHDS_UPDATE_CHECK",
};

/** Defaults */
const DEFAULTS: MthdsConfig = {
  runner: Runners.PIPELEX,
  apiUrl: "https://api.pipelex.com",
  apiKey: "",
  telemetry: true,
  autoUpgrade: false,
  updateCheck: true,
};

/** Map from CLI flag names (kebab-case) to config keys */
const KEY_ALIASES: Record<string, keyof MthdsConfig> = {
  runner: "runner",
  "api-url": "apiUrl",
  "api-key": "apiKey",
  telemetry: "telemetry",
  "auto-upgrade": "autoUpgrade",
  "update-check": "updateCheck",
};

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
