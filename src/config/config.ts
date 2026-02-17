import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { RunnerType } from "../runners/types.js";

export interface MthdsConfig {
  runner: RunnerType;
  apiUrl: string;
  apiKey: string;
}

const CONFIG_DIR = join(homedir(), ".mthds");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULTS: MthdsConfig = {
  runner: "api",
  apiUrl: "https://api.pipelex.com",
  apiKey: "",
};

/** Map from config key to env var name */
const ENV_OVERRIDES: Record<keyof MthdsConfig, string> = {
  runner: "MTHDS_RUNNER",
  apiUrl: "MTHDS_API_URL",
  apiKey: "MTHDS_API_KEY",
};

/** Map from CLI flag names (kebab-case) to config keys */
const KEY_ALIASES: Record<string, keyof MthdsConfig> = {
  runner: "runner",
  "api-url": "apiUrl",
  "api-key": "apiKey",
};

export const VALID_KEYS = Object.keys(KEY_ALIASES);

export function resolveKey(cliKey: string): keyof MthdsConfig | undefined {
  return KEY_ALIASES[cliKey];
}

function readConfigFile(): Partial<MthdsConfig> {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    return JSON.parse(raw) as Partial<MthdsConfig>;
  } catch {
    return {};
  }
}

function writeConfigFile(config: Partial<MthdsConfig>): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function loadConfig(): MthdsConfig {
  const file = readConfigFile();
  const merged: MthdsConfig = { ...DEFAULTS, ...file };

  // Env vars take precedence
  for (const [key, envName] of Object.entries(ENV_OVERRIDES)) {
    const envVal = process.env[envName];
    if (envVal !== undefined) {
      merged[key as keyof MthdsConfig] = envVal as never;
    }
  }

  return merged;
}

export function getConfigValue(key: keyof MthdsConfig): { value: string; source: "env" | "file" | "default" } {
  const envName = ENV_OVERRIDES[key];
  const envVal = process.env[envName];
  if (envVal !== undefined) {
    return { value: envVal, source: "env" };
  }

  const file = readConfigFile();
  if (key in file) {
    return { value: String(file[key]), source: "file" };
  }

  return { value: String(DEFAULTS[key]), source: "default" };
}

export function setConfigValue(key: keyof MthdsConfig, value: string): void {
  const file = readConfigFile();
  (file as Record<string, unknown>)[key] = value;
  writeConfigFile(file);
}

export function listConfig(): Array<{ key: string; cliKey: string; value: string; source: "env" | "file" | "default" }> {
  const result: Array<{ key: string; cliKey: string; value: string; source: "env" | "file" | "default" }> = [];

  for (const [cliKey, configKey] of Object.entries(KEY_ALIASES)) {
    const { value, source } = getConfigValue(configKey);
    result.push({ key: configKey, cliKey, value, source });
  }

  return result;
}
