import { PostHog } from "posthog-node";

const POSTHOG_API_KEY = "phc_ylV9FzMiQDyGgtd5nJn0Cc2OkyHAobfj7xDhYloH5IA";
const POSTHOG_HOST = "https://eu.i.posthog.com";

let client: PostHog | null = null;

function isDisabled(): boolean {
  return process.env["DISABLE_TELEMETRY"] === "1";
}

function getClient(): PostHog | null {
  if (isDisabled()) return null;
  if (!client) {
    client = new PostHog(POSTHOG_API_KEY, { host: POSTHOG_HOST, disableGeoip: true });
  }
  return client;
}

export function trackMethodInstall(methodId: string): void {
  const posthog = getClient();
  if (!posthog) return;

  posthog.capture({
    distinctId: "anonymous",
    event: "method_installed",
    properties: {
      method: methodId,
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
