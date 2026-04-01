import { PostHog } from "posthog-node";
import {
  isTelemetryEnabled,
  setTelemetryEnabled as setTelemetryFlag,
  getTelemetrySource,
} from "../../config/config.js";
import type { ConfigSource } from "../../config/config.js";

const POSTHOG_API_KEY = "phc_LRwe2lybfPTNCzAT1ScpnsWznrxAvmc1pmCaXEr1hwJ";
const POSTHOG_HOST = "https://eu.i.posthog.com";

let client: PostHog | null = null;

export type TelemetrySource = ConfigSource;

export function getTelemetryStatus(): { enabled: boolean; source: TelemetrySource } {
  const enabled = isTelemetryEnabled();
  const source = getTelemetrySource();
  return { enabled, source };
}

export function setTelemetryEnabled(enabled: boolean): void {
  setTelemetryFlag(enabled);
}

function getClient(): PostHog | null {
  if (!isTelemetryEnabled()) return null;
  if (!client) {
    client = new PostHog(POSTHOG_API_KEY, { host: POSTHOG_HOST, disableGeoip: true });
  }
  return client;
}

export interface InstallEvent {
  address: string;
  name: string;
  main_pipe?: string;
  version: string;
  description: string;
  display_name?: string;
  authors?: string[];
  license?: string;
  mthds_version?: string;
  exports?: Record<string, unknown>;
  manifest_raw: string;
}

function trackEvent(eventName: string, data: InstallEvent): void {
  const posthog = getClient();
  if (!posthog) return;

  posthog.capture({
    distinctId: "anonymous",
    event: eventName,
    properties: {
      address: data.address,
      name: data.name,
      main_pipe: data.main_pipe,
      package_version: data.version,
      description: data.description,
      display_name: data.display_name,
      authors: data.authors,
      license: data.license,
      mthds_version: data.mthds_version,
      exports: data.exports,
      manifest_raw: data.manifest_raw,
      timestamp: new Date().toISOString(),
    },
  });
}

export function trackPublish(data: InstallEvent): void {
  trackEvent("method_publish", data);
}

export function trackInstall(data: InstallEvent): void {
  trackEvent("method_install", data);
}

export async function shutdown(): Promise<void> {
  if (client) {
    try {
      await client.shutdown();
    } catch {
      // Telemetry flush failures should never crash the CLI
    }
    client = null;
  }
}
