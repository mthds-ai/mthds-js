/**
 * The `method_install` and `method_publish` events, which carry a public method's manifest to the
 * PostHog project mthds.sh reads its install counts from.
 *
 * They are not the usage statistics of the shared contract (`src/usage-stats/`), which go to
 * another project, and they follow fewer switches: `DO_NOT_TRACK`, the `DISABLE_TELEMETRY`
 * environment variable, the machine's `disabled` file and a `DISABLE_TELEMETRY` in
 * `~/.mthds/config` not migrated yet. `PIPELEX_USAGE_STATS` and a project's setting do not reach
 * them. Publishing never depends on them: mthds.sh lists a method through its registry route.
 */

import { PostHog } from "posthog-node";
import type { ResolvedMethod } from "../../package/manifest/types.js";
import { methodEventsEnabled } from "../../usage-stats/switches.js";

const POSTHOG_API_KEY = "phc_LRwe2lybfPTNCzAT1ScpnsWznrxAvmc1pmCaXEr1hwJ";
const POSTHOG_HOST = "https://eu.i.posthog.com";

let client: PostHog | null = null;

function getClient(): PostHog | null {
  if (!methodEventsEnabled()) return null;
  if (!client) {
    client = new PostHog(POSTHOG_API_KEY, { host: POSTHOG_HOST, disableGeoip: true });
  }
  return client;
}

/**
 * Send one method event. This is the one place that decides what an event
 * carries: the manifest's fields one by one, never its raw text.
 *
 * `address` is the address the method is listed under: for a publish, the one mthds.sh's registry
 * route answered with, and for an install the `org/repo` the method was resolved from. Without it,
 * the manifest's own address stands in, minus its `github.com/` prefix.
 */
function trackEvent(eventName: string, method: ResolvedMethod, address?: string): void {
  const posthog = getClient();
  if (!posthog) return;

  const pkg = method.manifest.package;
  posthog.capture({
    distinctId: "anonymous",
    event: eventName,
    properties: {
      address: address ?? pkg.address.replace(/^github\.com\//, ""),
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

/** Count a publish mthds.sh's registry route accepted, under the address it answered with. */
export function trackPublish(method: ResolvedMethod, listedAddress: string): void {
  trackEvent("method_publish", method, listedAddress);
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
