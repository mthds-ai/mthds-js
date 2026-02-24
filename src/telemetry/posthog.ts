import { PostHog } from "posthog-node";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";

const POSTHOG_API_KEY = "phc_ylV9FzMiQDyGgtd5nJn0Cc2OkyHAobfj7xDhYloH5IA";
const POSTHOG_HOST = "https://eu.i.posthog.com";

const CONFIG_DIR = join(homedir(), ".mthds");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const ENV_LOCAL_PATH = join(CONFIG_DIR, ".env.local");

let client: PostHog | null = null;

function readEnvLocal(): boolean {
  if (!existsSync(ENV_LOCAL_PATH)) return false;
  try {
    const content = readFileSync(ENV_LOCAL_PATH, "utf-8");
    return content.split("\n").some((line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("#")) return false;
      const [key, ...rest] = trimmed.split("=");
      if (key?.trim() !== "DISABLE_TELEMETRY") return false;
      const val = rest.join("=").trim().replace(/^["']|["']$/g, "").trim();
      return val === "1";
    });
  } catch {
    return false;
  }
}

function readConfigTelemetry(): boolean | undefined {
  if (!existsSync(CONFIG_PATH)) return undefined;
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    if ("telemetry" in config && typeof config.telemetry === "boolean") {
      return config.telemetry;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export type TelemetrySource = "env" | "env.local" | "config" | "default";

export function getTelemetryStatus(): { enabled: boolean; source: TelemetrySource } {
  // 1. Env var (highest priority)
  if (process.env["DISABLE_TELEMETRY"] === "1") {
    return { enabled: false, source: "env" };
  }

  // 2. ~/.mthds/.env.local
  if (readEnvLocal()) {
    return { enabled: false, source: "env.local" };
  }

  // 3. ~/.mthds/config.json
  const configVal = readConfigTelemetry();
  if (configVal !== undefined) {
    return { enabled: configVal, source: "config" };
  }

  // Default: enabled
  return { enabled: true, source: "default" };
}

export function setTelemetryEnabled(enabled: boolean): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  let config: Record<string, unknown> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
    } catch {
      // ignore parse errors, overwrite
    }
  }
  config.telemetry = enabled;
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function isDisabled(): boolean {
  return !getTelemetryStatus().enabled;
}

function getClient(): PostHog | null {
  if (isDisabled()) return null;
  if (!client) {
    client = new PostHog(POSTHOG_API_KEY, { host: POSTHOG_HOST, disableGeoip: true });
  }
  return client;
}

export interface InstallEvent {
  address: string;
  slug: string;
  version: string;
  description: string;
  display_name?: string;
  authors?: string[];
  license?: string;
  mthds_version?: string;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, { address: string; version: string }>;
  manifest_raw: string;
}

export function trackInstall(data: InstallEvent): void {
  const posthog = getClient();
  if (!posthog) return;

  posthog.capture({
    distinctId: "anonymous",
    event: "install",
    properties: {
      address: data.address,
      slug: data.slug,
      version: data.version,
      description: data.description,
      display_name: data.display_name,
      authors: data.authors ? JSON.stringify(data.authors) : undefined,
      license: data.license,
      mthds_version: data.mthds_version,
      exports: data.exports ? JSON.stringify(data.exports) : undefined,
      dependencies: data.dependencies ? JSON.stringify(data.dependencies) : undefined,
      manifest_raw: data.manifest_raw,
      timestamp: new Date().toISOString(),
    },
  });
}

export async function shutdown(): Promise<void> {
  if (client) {
    await client.shutdown();
    client = null;
  }
}
