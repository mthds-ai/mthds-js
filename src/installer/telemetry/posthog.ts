import { PostHog } from "posthog-node";
import {
  isTelemetryEnabled,
  setTelemetryEnabled as setTelemetryFlag,
  getTelemetrySource,
} from "../../config/credentials.js";
import type { CredentialSource } from "../../config/credentials.js";

const POSTHOG_API_KEY = "phc_ylV9FzMiQDyGgtd5nJn0Cc2OkyHAobfj7xDhYloH5IA";
const POSTHOG_HOST = "https://eu.i.posthog.com";

let client: PostHog | null = null;

export type TelemetrySource = CredentialSource;

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
  slug: string;
  version: string;
  description: string;
  display_name?: string;
  authors?: string[];
  license?: string;
  mthds_version?: string;
  exports?: Record<string, unknown>;
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
      manifest_raw: data.manifest_raw,
      timestamp: new Date().toISOString(),
    },
  });
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
