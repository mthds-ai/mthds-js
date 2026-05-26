/**
 * Remote upstream version probes for mthds-agent and the mthds plugin.
 *
 * Closes the "silent when both stale" blind spot in the env-check: the
 * existing local floor checks (plugin's `min_mthds_version` and the agent's
 * `MIN_PLUGIN_VERSION`) compare two artifacts that are already on disk and
 * agree with each other when both are equally behind. These probes ask the
 * authoritative upstream sources directly — npm for `mthds`, GitHub raw for
 * the published `marketplace.json` — so a "user lags on both" scenario still
 * produces an UPGRADE_AVAILABLE signal.
 *
 * Both functions are infallible from the caller's perspective: any network
 * error, timeout, non-2xx, parse error, or missing field returns null. The
 * caller treats null as "no upstream information available, leave the local
 * payload alone".
 */

const FETCH_TIMEOUT_MS = 2_000;

const NPM_LATEST_URL = "https://registry.npmjs.org/mthds/latest";
const MARKETPLACE_URL =
  "https://raw.githubusercontent.com/mthds-ai/mthds-plugins/main/.claude-plugin/marketplace.json";

/**
 * Fetch JSON from `url` with a hard 2s timeout. Returns the parsed body on
 * 2xx, or null on any failure (timeout, network, non-2xx, malformed JSON).
 * Never throws.
 */
async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Probe npm for the latest published `mthds` version. Returns the version
 * string (e.g. `"0.8.1"`) or null on any failure.
 */
export async function fetchLatestMthdsAgentNpm(): Promise<string | null> {
  const body = await fetchJson(NPM_LATEST_URL);
  if (!body || typeof body !== "object") return null;
  const version = (body as Record<string, unknown>).version;
  return typeof version === "string" && version.length > 0 ? version : null;
}

/**
 * Probe the published `marketplace.json` on the mthds-plugins repo for the
 * latest plugin version. Returns the version string (e.g. `"0.11.3"`) or
 * null on any failure.
 *
 * The marketplace.json carries one global `metadata.version` for the whole
 * marketplace; all plugins inside it (mthds, mthds-dev) move together, so a
 * single version is enough to drive the upstream check.
 */
export async function fetchLatestPluginMarketplace(): Promise<string | null> {
  const body = await fetchJson(MARKETPLACE_URL);
  if (!body || typeof body !== "object") return null;
  const metadata = (body as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const version = (metadata as Record<string, unknown>).version;
  return typeof version === "string" && version.length > 0 ? version : null;
}
