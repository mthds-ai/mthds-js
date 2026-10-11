import { PostHog } from "posthog-node";
import { isTelemetryEnabled, getTelemetryDisablingEnvVar } from "../../config/config.js";
import type { ResolvedMethod } from "../../package/manifest/types.js";

const POSTHOG_API_KEY = "phc_LRwe2lybfPTNCzAT1ScpnsWznrxAvmc1pmCaXEr1hwJ";
const POSTHOG_HOST = "https://eu.i.posthog.com";

let client: PostHog | null = null;

function getClient(): PostHog | null {
  if (!isTelemetryEnabled()) return null;
  if (!client) {
    client = new PostHog(POSTHOG_API_KEY, { host: POSTHOG_HOST, disableGeoip: true });
  }
  return client;
}

/**
 * Send one method event. This is the one place that decides what an event
 * carries: the manifest's fields one by one, never its raw text.
 *
 * `orgRepo` is the `org/repo` the method was resolved from; without it, the
 * manifest's own address stands in, minus its `github.com/` prefix.
 */
function trackEvent(eventName: string, method: ResolvedMethod, orgRepo?: string): void {
  const posthog = getClient();
  if (!posthog) return;

  const pkg = method.manifest.package;
  posthog.capture({
    distinctId: "anonymous",
    event: eventName,
    properties: {
      address: orgRepo ?? pkg.address.replace(/^github\.com\//, ""),
      name: pkg.name,
      main_pipe: pkg.main_pipe,
      package_version: pkg.version,
      description: pkg.description,
      display_name: pkg.display_name,
      authors: pkg.authors,
      license: pkg.license,
      mthds_version: pkg.mthds_version,
      exports: method.manifest.exports,
      timestamp: new Date().toISOString(),
    },
  });
}

/**
 * Why a publish cannot reach mthds.sh, or undefined when it can. mthds.sh
 * registers a method from its `method_publish` event alone, so with telemetry
 * off a publish would register nothing while reporting success.
 */
export function publishBlockedByTelemetry(): string | undefined {
  if (isTelemetryEnabled()) return undefined;
  const envVar = getTelemetryDisablingEnvVar();
  const cause = envVar
    ? `${envVar} is set in your environment; run the command without it to publish`
    : "it is disabled in ~/.mthds/config; `mthds telemetry enable` turns it back on";
  return `Nothing was published: mthds.sh registers a method from the CLI's telemetry event, and telemetry is off (${cause}).`;
}

export function trackPublish(method: ResolvedMethod, orgRepo?: string): void {
  trackEvent("method_publish", method, orgRepo);
}

export function trackInstall(method: ResolvedMethod, orgRepo?: string): void {
  trackEvent("method_install", method, orgRepo);
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
