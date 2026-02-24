import { join } from "node:path";
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import type { RunnerType } from "../runners/types.js";

// ── Types ──────────────────────────────────────────────────────────

export interface MthdsCredentials {
  runner: RunnerType;
  apiUrl: string;
  apiKey: string;
  telemetry: boolean;
}

export type CredentialSource = "env" | "file" | "default";

// ── Paths ──────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".mthds");
const CREDENTIALS_PATH = join(CONFIG_DIR, "credentials");

// Legacy paths (for auto-migration)
const LEGACY_CONFIG_PATH = join(CONFIG_DIR, "config.json");
const LEGACY_ENV_LOCAL_PATH = join(CONFIG_DIR, ".env.local");

// ── Credential keys ────────────────────────────────────────────────

/** Map from credential key to env var name */
const ENV_NAMES: Record<keyof MthdsCredentials, string> = {
  apiUrl: "PIPELEX_API_URL",
  apiKey: "PIPELEX_API_KEY",
  runner: "MTHDS_RUNNER",
  telemetry: "DISABLE_TELEMETRY",
};

/** Map from credential key to file key (used in ~/.mthds/credentials) */
const FILE_KEYS: Record<keyof MthdsCredentials, string> = {
  apiUrl: "PIPELEX_API_URL",
  apiKey: "PIPELEX_API_KEY",
  runner: "MTHDS_RUNNER",
  telemetry: "DISABLE_TELEMETRY",
};

/** Defaults */
const DEFAULTS: MthdsCredentials = {
  runner: "api",
  apiUrl: "https://api.pipelex.com",
  apiKey: "",
  telemetry: true,
};

/** Map from CLI flag names (kebab-case) to credential keys */
const KEY_ALIASES: Record<string, keyof MthdsCredentials> = {
  runner: "runner",
  "api-url": "apiUrl",
  "api-key": "apiKey",
  telemetry: "telemetry",
};

export const VALID_KEYS = Object.keys(KEY_ALIASES);

export function resolveKey(
  cliKey: string
): keyof MthdsCredentials | undefined {
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

function readCredentialsFile(): Record<string, string> {
  migrateIfNeeded();
  if (!existsSync(CREDENTIALS_PATH)) return {};
  try {
    return parseDotenv(readFileSync(CREDENTIALS_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeCredentialsFile(entries: Record<string, string>): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CREDENTIALS_PATH, serializeDotenv(entries), "utf-8");
}

// ── Migration ──────────────────────────────────────────────────────

let migrationDone = false;

function migrateIfNeeded(): void {
  if (migrationDone) return;
  migrationDone = true;

  if (existsSync(CREDENTIALS_PATH)) return;

  const migrated: Record<string, string> = {};
  let didMigrate = false;

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

      didMigrate = true;
    } catch {
      // ignore parse errors
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
      didMigrate = true;
    } catch {
      // ignore parse errors
    }
  }

  if (didMigrate) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CREDENTIALS_PATH, serializeDotenv(migrated), "utf-8");

    // Remove legacy files
    try {
      if (existsSync(LEGACY_CONFIG_PATH)) unlinkSync(LEGACY_CONFIG_PATH);
    } catch {
      // ignore
    }
    try {
      if (existsSync(LEGACY_ENV_LOCAL_PATH)) unlinkSync(LEGACY_ENV_LOCAL_PATH);
    } catch {
      // ignore
    }
  }
}

// ── Public API ─────────────────────────────────────────────────────

function coerceValue(
  key: keyof MthdsCredentials,
  raw: string
): string | boolean {
  if (key === "telemetry") {
    // DISABLE_TELEMETRY=1 means telemetry is OFF
    return raw !== "1";
  }
  return raw;
}

function toFileValue(key: keyof MthdsCredentials, value: string | boolean): string {
  if (key === "telemetry") {
    return value ? "0" : "1";
  }
  return String(value);
}

export function loadCredentials(): MthdsCredentials {
  const file = readCredentialsFile();
  const merged = { ...DEFAULTS } as Record<string, unknown>;

  // Apply file values
  for (const [key, fileKey] of Object.entries(FILE_KEYS)) {
    if (fileKey in file) {
      merged[key] = coerceValue(key as keyof MthdsCredentials, file[fileKey]!);
    }
  }

  // Env vars take precedence
  for (const [key, envName] of Object.entries(ENV_NAMES)) {
    const envVal = process.env[envName];
    if (envVal !== undefined) {
      merged[key] = coerceValue(key as keyof MthdsCredentials, envVal);
    }
  }

  return merged as unknown as MthdsCredentials;
}

export function getCredentialValue(
  key: keyof MthdsCredentials
): { value: string; source: CredentialSource } {
  const envName = ENV_NAMES[key];
  const envVal = process.env[envName];
  if (envVal !== undefined) {
    return { value: envVal, source: "env" };
  }

  const file = readCredentialsFile();
  const fileKey = FILE_KEYS[key];
  if (fileKey in file) {
    return { value: file[fileKey]!, source: "file" };
  }

  const defaultVal = DEFAULTS[key];
  if (key === "telemetry") {
    return { value: defaultVal ? "0" : "1", source: "default" };
  }
  return { value: String(defaultVal), source: "default" };
}

export function setCredentialValue(
  key: keyof MthdsCredentials,
  value: string
): void {
  const file = readCredentialsFile();
  const fileKey = FILE_KEYS[key];
  file[fileKey] = value;
  writeCredentialsFile(file);
}

export function listCredentials(): Array<{
  key: string;
  cliKey: string;
  value: string;
  source: CredentialSource;
}> {
  const result: Array<{
    key: string;
    cliKey: string;
    value: string;
    source: CredentialSource;
  }> = [];

  for (const [cliKey, credKey] of Object.entries(KEY_ALIASES)) {
    const { value, source } = getCredentialValue(credKey);
    result.push({ key: credKey, cliKey, value, source });
  }

  return result;
}

// ── Telemetry helpers (for PostHog module) ─────────────────────────

export function isTelemetryEnabled(): boolean {
  return loadCredentials().telemetry;
}

export function setTelemetryEnabled(enabled: boolean): void {
  setCredentialValue("telemetry", toFileValue("telemetry", enabled));
}

export function getTelemetrySource(): CredentialSource {
  return getCredentialValue("telemetry").source;
}
