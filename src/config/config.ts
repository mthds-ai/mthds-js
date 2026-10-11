import { join } from "node:path";
import { homedir } from "node:os";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Runners } from "../runners/types.js";
import type { RunnerType } from "../runners/types.js";
import { parseDotenv, serializeDotenv } from "./dotenv.js";
import { ENV, SWITCH_VALUES } from "../usage-stats/contract.js";
import { isMthdsDisableOn, normalizedValue } from "../usage-stats/environment.js";
import {
  createDisabledFile,
  deleteEverySpool,
  isMachineDisabled,
  legacyOptOutPending,
  markLegacyMigrated,
  removeDisabledFile,
} from "../usage-stats/state.js";
import { isDoNotTrack, toolSwitchSaysOff } from "../usage-stats/switches.js";

export { parseDotenv, serializeDotenv };

// ── Types ──────────────────────────────────────────────────────────

export interface MthdsConfig {
  runner: RunnerType;
  /**
   * API base URL — host only, NO version prefix (e.g. `https://api.pipelex.com`
   * or `http://localhost:8081`). Every endpoint composes as
   * `{baseUrl}/v1/{endpoint}`; `/health` resolves to the origin root.
   */
  baseUrl: string;
  apiKey: string;
  autoUpgrade: boolean;
  updateCheck: boolean;
}

/**
 * A key `mthds config` takes: a setting of `~/.mthds/config`, or `telemetry`, which is no setting
 * of that file but the machine's usage-statistics choice, kept in the shared state every reporting
 * tool reads (`~/.mthds/usage-stats/`).
 */
export type ConfigKey = keyof MthdsConfig | "telemetry";

export type ConfigSource = "env" | "file" | "default";

// ── Paths ──────────────────────────────────────────────────────────

const CONFIG_DIR = join(homedir(), ".mthds");
const CONFIG_PATH = join(CONFIG_DIR, "config");

// ── Config keys ───────────────────────────────────────────────────

/** Map from config key to env var name */
const ENV_NAMES: Record<keyof MthdsConfig, string> = {
  baseUrl: "MTHDS_BASE_URL",
  apiKey: "MTHDS_API_KEY",
  runner: "MTHDS_RUNNER",
  autoUpgrade: "MTHDS_AUTO_UPGRADE",
  updateCheck: "MTHDS_UPDATE_CHECK",
};

/** Map from config key to file key (used in ~/.mthds/config) */
const FILE_KEYS: Record<keyof MthdsConfig, string> = {
  baseUrl: "MTHDS_BASE_URL",
  apiKey: "MTHDS_API_KEY",
  runner: "MTHDS_RUNNER",
  autoUpgrade: "MTHDS_AUTO_UPGRADE",
  updateCheck: "MTHDS_UPDATE_CHECK",
};

/** Hosted default — host only; endpoints compose as `{base}/v1/{endpoint}`. */
export const DEFAULT_BASE_URL = "https://api.pipelex.com";

/** Defaults */
const DEFAULTS: MthdsConfig = {
  runner: Runners.PIPELEX,
  baseUrl: DEFAULT_BASE_URL,
  apiKey: "",
  autoUpgrade: false,
  updateCheck: true,
};

/** Map from CLI flag names (kebab-case) to config keys */
const KEY_ALIASES: Record<string, ConfigKey> = {
  runner: "runner",
  "base-url": "baseUrl",
  "api-key": "apiKey",
  telemetry: "telemetry",
  "auto-upgrade": "autoUpgrade",
  "update-check": "updateCheck",
};

// ── Boolean key sets ──────────────────────────────────────────────

/** Keys that store boolean values (coerced from "0"/"1" in file/env) */
const BOOLEAN_KEYS: Set<keyof MthdsConfig> = new Set(["autoUpgrade", "updateCheck"]);

/** Strings treated as truthy for boolean keys — used in both load and set paths */
const TRUTHY_STRINGS: ReadonlySet<string> = new Set(["true", "1", "yes", "on"]);

export const VALID_KEYS = Object.keys(KEY_ALIASES);

/**
 * A base URL must be HOST ONLY — http/https, no path, query, or fragment.
 * The client composes `{base}/v1/{endpoint}`; a path-prefixed value (e.g. a
 * leftover `.../runner/v1`) would produce malformed `/v1/v1/...` endpoints.
 */
export function isValidBaseUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.pathname !== "/" && parsed.pathname !== "") return false;
  // Host only also means no embedded credentials — auth travels in the
  // Authorization header (MTHDS_API_KEY), never in the URL.
  if (parsed.username || parsed.password) return false;
  return !parsed.search && !parsed.hash;
}

export function resolveKey(cliKey: string): ConfigKey | undefined {
  return KEY_ALIASES[cliKey];
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
  // The file stores MTHDS_API_KEY — it MUST be owner-only (0600), per the config
  // file spec. `mode` only applies when the file is created (and is masked by the
  // umask), so chmod explicitly to also tighten a pre-existing file.
  writeFileSync(CONFIG_PATH, serializeDotenv(entries), { encoding: "utf-8", mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}

// ── Public API ─────────────────────────────────────────────────────

function coerceValue(key: keyof MthdsConfig, raw: string): string | boolean {
  if (!BOOLEAN_KEYS.has(key)) return raw;
  return TRUTHY_STRINGS.has(raw.toLowerCase());
}

function toFileValue(key: keyof MthdsConfig, value: string | boolean): string {
  if (!BOOLEAN_KEYS.has(key)) return String(value);
  const boolVal =
    typeof value === "boolean" ? value : TRUTHY_STRINGS.has(String(value).toLowerCase());
  return boolVal ? "1" : "0";
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

export function getConfigValue(key: ConfigKey): { value: string; source: ConfigSource } {
  if (key === "telemetry") return getTelemetryValue();

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
    return { value: (defaultVal as boolean) ? "1" : "0", source: "default" };
  }
  return { value: String(defaultVal), source: "default" };
}

export function setConfigValue(key: ConfigKey, value: string): void {
  if (key === "telemetry") {
    setTelemetryValue(value);
    return;
  }
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

// ── The `telemetry` key ────────────────────────────────────────────
// `telemetry` keeps the inverted encoding of the `DISABLE_TELEMETRY` it used to stand for: "1"
// means usage statistics are off, "0" that they are on. It reports and sets the machine's choice in
// the shared state, the `disabled` file every reporting tool reads, and never writes
// `DISABLE_TELEMETRY` to `~/.mthds/config` any more; a `DISABLE_TELEMETRY` already in that file is
// carried into the shared state by the legacy migration. `mthds telemetry status` is the full
// answer, with every switch that keeps statistics off.

/** The environment variable holding usage statistics off, if one does. */
export function getTelemetryDisablingEnvVar(): string | undefined {
  if (isDoNotTrack()) return ENV.doNotTrack;
  if (isMthdsDisableOn(process.env[ENV.mthdsToolSwitch])) return ENV.mthdsToolSwitch;
  if (toolSwitchSaysOff()) return ENV.toolSwitch;
  return undefined;
}

function getTelemetryValue(): { value: string; source: ConfigSource } {
  if (getTelemetryDisablingEnvVar() !== undefined) return { value: "1", source: "env" };
  if (isMachineDisabled() || legacyOptOutPending()) return { value: "1", source: "file" };
  return { value: "0", source: "default" };
}

function telemetryValueSaysOn(value: string): boolean | undefined {
  const normalized = normalizedValue(value) ?? "";
  if (TRUTHY_STRINGS.has(normalized)) return true;
  if ((SWITCH_VALUES.toolSwitchOff as readonly string[]).includes(normalized)) return false;
  return undefined;
}

/** Whether `config set telemetry` accepts `value`: `true`/`false`, `1`/`0`, `yes`/`no` or `on`/`off`. */
export function isValidTelemetryValue(value: string): boolean {
  return telemetryValueSaysOn(value) !== undefined;
}

export const TELEMETRY_VALUE_HINT = "Use true or false (also 1/0, yes/no, on/off).";

/**
 * `config set telemetry <value>`: a value saying on does what `mthds telemetry enable` does, one
 * saying off what `mthds telemetry disable` does. Any other value is refused.
 */
function setTelemetryValue(value: string): void {
  const on = telemetryValueSaysOn(value);
  if (on === undefined) {
    throw new Error(`Invalid value for telemetry: ${value}. ${TELEMETRY_VALUE_HINT}`);
  }
  if (on) {
    removeDisabledFile();
    markLegacyMigrated();
  } else {
    createDisabledFile();
    deleteEverySpool();
  }
}
