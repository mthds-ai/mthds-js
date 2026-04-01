import { join } from "node:path";
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
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

// Legacy paths (for auto-migration)
const LEGACY_CONFIG_PATH = join(CONFIG_DIR, "config.json");
const LEGACY_ENV_LOCAL_PATH = join(CONFIG_DIR, ".env.local");
const LEGACY_CREDENTIALS_PATH = join(CONFIG_DIR, "credentials");

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
  migrateIfNeeded();
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

// ── Migration ──────────────────────────────────────────────────────

let migrationDone = false;

function migrateIfNeeded(): void {
  if (migrationDone) return;
  migrationDone = true;

  if (existsSync(CONFIG_PATH)) return;

  const migrated: Record<string, string> = {};
  let configJsonMigrated = false;
  let envLocalMigrated = false;
  let credentialsMigrated = false;

  // Migrate from ~/.mthds/credentials (previous config file name)
  if (existsSync(LEGACY_CREDENTIALS_PATH)) {
    try {
      const entries = parseDotenv(
        readFileSync(LEGACY_CREDENTIALS_PATH, "utf-8")
      );
      Object.assign(migrated, entries);
      credentialsMigrated = true;
    } catch {
      // Read failed — preserve the legacy file
    }
  }

  // Migrate from config.json
  if (existsSync(LEGACY_CONFIG_PATH)) {
    try {
      const raw = readFileSync(LEGACY_CONFIG_PATH, "utf-8");
      const config = JSON.parse(raw) as Record<string, unknown>;

      if (typeof config.runner === "string") {
        migrated["MTHDS_RUNNER"] = config.runner;
      }
      if (typeof config.apiUrl === "string") {
        migrated["PIPELEX_API_URL"] = config.apiUrl;
      }
      if (typeof config.apiKey === "string") {
        migrated["PIPELEX_API_KEY"] = config.apiKey;
      }
      if (typeof config.telemetry === "boolean") {
        migrated["DISABLE_TELEMETRY"] = config.telemetry ? "0" : "1";
      }

      configJsonMigrated = true;
    } catch {
      // Parse failed — preserve the legacy file so the user can fix it
    }
  }

  // Migrate from .env.local (telemetry flag)
  if (existsSync(LEGACY_ENV_LOCAL_PATH)) {
    try {
      const envEntries = parseDotenv(
        readFileSync(LEGACY_ENV_LOCAL_PATH, "utf-8")
      );
      if (envEntries["DISABLE_TELEMETRY"]) {
        migrated["DISABLE_TELEMETRY"] = envEntries["DISABLE_TELEMETRY"];
      }
      envLocalMigrated = Boolean(envEntries["DISABLE_TELEMETRY"]);
    } catch {
      // Read failed — preserve the legacy file
    }
  }

  if (credentialsMigrated || configJsonMigrated || envLocalMigrated) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, serializeDotenv(migrated), "utf-8");

    // Only delete legacy files that were successfully migrated
    if (credentialsMigrated) {
      try { unlinkSync(LEGACY_CREDENTIALS_PATH); } catch { /* ignore */ }
    }
    if (configJsonMigrated) {
      try { unlinkSync(LEGACY_CONFIG_PATH); } catch { /* ignore */ }
    }
    if (envLocalMigrated) {
      try { unlinkSync(LEGACY_ENV_LOCAL_PATH); } catch { /* ignore */ }
    }
  }
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

  for (const [cliKey, credKey] of Object.entries(KEY_ALIASES)) {
    const { value, source } = getConfigValue(credKey);
    result.push({ key: credKey, cliKey, value, source });
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
