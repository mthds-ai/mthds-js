/**
 * Who a telemetry event is about.
 *
 * Two cases, and never a shared constant:
 *
 *   - **Identified.** An API key is configured and the platform confirms whose it
 *     is (`GET {baseUrl}/v1/auth/verify` → `user_id`). The event's `distinct_id` is
 *     that platform user id — the same id the hosted API and the webapp use — and,
 *     when the platform also names the organization, the event is attached to the
 *     PostHog group `organization`.
 *   - **Anonymous.** No key, or the platform could not confirm it. The event is
 *     sent with a random id minted once per machine and persisted in
 *     `~/.mthds/telemetry.json`, and flagged `$process_person_profile: false` so
 *     PostHog records it without creating a person profile.
 *
 * A confirmed identity is cached in the same file under a SHA-256 of the base URL
 * and the key (never the key itself), so the lookup costs one request per key,
 * ever. A refusal is cached for a day so a CLI pointed at a server without the
 * route does not pay the round-trip on every install. Nothing here ever throws:
 * telemetry must never break the CLI.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "../../config/config.js";
import { buildUserAgent } from "../../runners/api/user-agent.js";

/** The PostHog group type an organization is captured under — shared with the hosted API. */
export const ORGANIZATION_GROUP_TYPE = "organization";

/** How long a refused lookup is remembered before the CLI asks again. */
export const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Hard bound on the identity lookup, so an unreachable server never stalls an install. */
export const IDENTITY_LOOKUP_TIMEOUT_MS = 1500;

export interface TelemetryIdentity {
  /** The PostHog `distinct_id`: the platform user id, or this machine's install id. */
  distinctId: string;
  /** True when `distinctId` is a platform user id confirmed by the API. */
  identified: boolean;
  /** The platform organization id, when the API named one. */
  orgId?: string;
}

interface CachedIdentity {
  user_id: string | null;
  org_id?: string;
  checked_at: string;
}

interface TelemetryState {
  install_id?: string;
  identities?: Record<string, CachedIdentity>;
}

export interface ResolveIdentityOptions {
  apiKey?: string;
  baseUrl?: string;
  statePath?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export function defaultStatePath(): string {
  return join(homedir(), ".mthds", "telemetry.json");
}

function readState(path: string): TelemetryState {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as TelemetryState;
  } catch {
    // Unreadable or corrupt state is rebuilt, never fatal.
    return {};
  }
}

function writeState(path: string, state: TelemetryState): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
    chmodSync(path, 0o600);
    return true;
  } catch {
    // A read-only home is not a reason to fail an install.
    return false;
  }
}

/** The cache key for one credential: the key never touches disk, only this digest. */
export function identityCacheKey(baseUrl: string, apiKey: string): string {
  return createHash("sha256").update(`${baseUrl}\n${apiKey}`).digest("hex");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

type LookupResult =
  | { kind: "confirmed"; userId: string; orgId?: string }
  | { kind: "refused" }
  | { kind: "unreachable" };

async function lookupIdentity(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<LookupResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IDENTITY_LOOKUP_TIMEOUT_MS);
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  const userAgent = buildUserAgent();
  if (userAgent) headers["user-agent"] = userAgent;
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/v1/auth/verify`;
    const res = await fetchImpl(url, { signal: controller.signal, headers });
    // A 5xx or a rate limit says nothing about the key: try again next time.
    if (res.status >= 500 || res.status === 429) return { kind: "unreachable" };
    if (!res.ok) return { kind: "refused" };
    const body: unknown = await res.json();
    if (body === null || typeof body !== "object") return { kind: "refused" };
    const record = body as Record<string, unknown>;
    const userId = nonEmptyString(record.user_id);
    if (!userId) return { kind: "refused" };
    const orgId = nonEmptyString(record.org_id);
    return orgId ? { kind: "confirmed", userId, orgId } : { kind: "confirmed", userId };
  } catch {
    // Network failure, timeout or malformed JSON: unknown, not refused.
    return { kind: "unreachable" };
  } finally {
    clearTimeout(timeoutId);
  }
}

function fromCache(
  entry: CachedIdentity | undefined,
  now: Date,
): TelemetryIdentity | "refused" | undefined {
  if (!entry) return undefined;
  const userId = nonEmptyString(entry.user_id);
  if (userId) {
    const orgId = nonEmptyString(entry.org_id);
    return orgId
      ? { distinctId: userId, identified: true, orgId }
      : { distinctId: userId, identified: true };
  }
  const checkedAt = Date.parse(entry.checked_at);
  if (Number.isFinite(checkedAt) && now.getTime() - checkedAt < NEGATIVE_CACHE_TTL_MS)
    return "refused";
  return undefined;
}

/**
 * Resolve the identity to send events under. Performs at most one bounded network
 * request, and only when an API key is configured and nothing is cached for it.
 */
export async function resolveTelemetryIdentity(
  options: ResolveIdentityOptions = {},
): Promise<TelemetryIdentity> {
  const config =
    options.apiKey === undefined || options.baseUrl === undefined ? loadConfig() : undefined;
  const apiKey = (options.apiKey ?? config?.apiKey ?? "").trim();
  const baseUrl = options.baseUrl ?? config?.baseUrl ?? "";
  const statePath = options.statePath ?? defaultStatePath();
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  const state = readState(statePath);
  let dirty = false;

  if (apiKey && baseUrl) {
    const cacheKey = identityCacheKey(baseUrl, apiKey);
    const cached = fromCache(state.identities?.[cacheKey], now());
    if (cached && cached !== "refused") return cached;
    if (cached === undefined) {
      const result = await lookupIdentity(baseUrl, apiKey, fetchImpl);
      if (result.kind === "confirmed") {
        const entry: CachedIdentity = { user_id: result.userId, checked_at: now().toISOString() };
        if (result.orgId) entry.org_id = result.orgId;
        state.identities = { ...state.identities, [cacheKey]: entry };
        writeState(statePath, state);
        return result.orgId
          ? { distinctId: result.userId, identified: true, orgId: result.orgId }
          : { distinctId: result.userId, identified: true };
      }
      if (result.kind === "refused") {
        state.identities = {
          ...state.identities,
          [cacheKey]: { user_id: null, checked_at: now().toISOString() },
        };
        dirty = true;
      }
    }
  }

  let installId = nonEmptyString(state.install_id);
  if (!installId) {
    installId = randomUUID();
    state.install_id = installId;
    dirty = true;
  }
  if (dirty) writeState(statePath, state);
  return { distinctId: installId, identified: false };
}
