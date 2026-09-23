import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveTelemetryIdentity,
  identityCacheKey,
  NEGATIVE_CACHE_TTL_MS,
  ORGANIZATION_GROUP_TYPE,
} from "../../../../src/installer/telemetry/identity.js";

const BASE_URL = "https://api.pipelex.com";
const API_KEY = "sk_test_key";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let statePath: string;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function readState(): Record<string, any> {
  return JSON.parse(readFileSync(statePath, "utf-8"));
}

beforeEach(() => {
  statePath = join(mkdtempSync(join(tmpdir(), "mthds-telemetry-")), ".mthds", "telemetry.json");
});

describe("resolveTelemetryIdentity — anonymous", () => {
  it("mints a random install id, persists it owner-only, and never calls the network without a key", async () => {
    const fetchImpl = vi.fn();
    const who = await resolveTelemetryIdentity({
      apiKey: "",
      baseUrl: BASE_URL,
      statePath,
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(who.identified).toBe(false);
    expect(who.orgId).toBeUndefined();
    expect(who.distinctId).toMatch(UUID_RE);
    expect(who.distinctId).not.toBe("anonymous");
    expect(readState().install_id).toBe(who.distinctId);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it("reuses the persisted install id across calls", async () => {
    const first = await resolveTelemetryIdentity({ apiKey: "", baseUrl: BASE_URL, statePath });
    const second = await resolveTelemetryIdentity({ apiKey: "", baseUrl: BASE_URL, statePath });
    expect(second.distinctId).toBe(first.distinctId);
  });

  it("gives two machines (state files) two different ids", async () => {
    const otherPath = join(mkdtempSync(join(tmpdir(), "mthds-telemetry-")), "telemetry.json");
    const a = await resolveTelemetryIdentity({ apiKey: "", baseUrl: BASE_URL, statePath });
    const b = await resolveTelemetryIdentity({
      apiKey: "",
      baseUrl: BASE_URL,
      statePath: otherPath,
    });
    expect(a.distinctId).not.toBe(b.distinctId);
  });

  it("rebuilds a corrupt state file", async () => {
    mkdirSync(join(statePath, ".."), { recursive: true });
    writeFileSync(statePath, "{not json", "utf-8");
    const who = await resolveTelemetryIdentity({ apiKey: "", baseUrl: BASE_URL, statePath });
    expect(who.distinctId).toMatch(UUID_RE);
    expect(readState().install_id).toBe(who.distinctId);
  });

  it("rebuilds a state file holding a non-object", async () => {
    mkdirSync(join(statePath, ".."), { recursive: true });
    writeFileSync(statePath, "[1,2]", "utf-8");
    const who = await resolveTelemetryIdentity({ apiKey: "", baseUrl: BASE_URL, statePath });
    expect(who.distinctId).toMatch(UUID_RE);
  });

  it("still returns a random id when the state cannot be written", async () => {
    // A path under a regular file cannot be created.
    const blocker = join(mkdtempSync(join(tmpdir(), "mthds-telemetry-")), "file");
    writeFileSync(blocker, "x", "utf-8");
    const who = await resolveTelemetryIdentity({
      apiKey: "",
      baseUrl: BASE_URL,
      statePath: join(blocker, "telemetry.json"),
    });
    expect(who.identified).toBe(false);
    expect(who.distinctId).toMatch(UUID_RE);
  });

  it("reads the key and base URL from config when not given", async () => {
    vi.stubEnv("MTHDS_API_KEY", "");
    const fetchImpl = vi.fn();
    const who = await resolveTelemetryIdentity({ statePath, fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(who.identified).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("resolveTelemetryIdentity — identified", () => {
  it("uses the platform user id confirmed by /v1/auth/verify", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { user_id: "user_123" }));
    const who = await resolveTelemetryIdentity({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      statePath,
      fetchImpl,
    });

    expect(who).toEqual({ distinctId: "user_123", identified: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.pipelex.com/v1/auth/verify");
    expect(init.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(init.headers["user-agent"]).toMatch(/^mthds-js\//);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("carries the organization when the platform names one", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { user_id: "user_123", org_id: "org_456" }));
    const who = await resolveTelemetryIdentity({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      statePath,
      fetchImpl,
    });
    expect(who).toEqual({ distinctId: "user_123", identified: true, orgId: "org_456" });
    expect(ORGANIZATION_GROUP_TYPE).toBe("organization");
  });

  it("strips a trailing slash from the base URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { user_id: "user_123" }));
    await resolveTelemetryIdentity({
      apiKey: API_KEY,
      baseUrl: "http://localhost:8081/",
      statePath,
      fetchImpl,
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://localhost:8081/v1/auth/verify");
  });

  it("caches a confirmed identity under a digest, never the key, and does not ask again", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { user_id: "user_123", org_id: "org_456" }));
    await resolveTelemetryIdentity({ apiKey: API_KEY, baseUrl: BASE_URL, statePath, fetchImpl });
    const again = await resolveTelemetryIdentity({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      statePath,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(again).toEqual({ distinctId: "user_123", identified: true, orgId: "org_456" });
    const raw = readFileSync(statePath, "utf-8");
    expect(raw).not.toContain(API_KEY);
    expect(readState().identities[identityCacheKey(BASE_URL, API_KEY)].user_id).toBe("user_123");
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it("looks up again for a different key", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { user_id: "user_a" }))
      .mockResolvedValueOnce(jsonResponse(200, { user_id: "user_b" }));
    const a = await resolveTelemetryIdentity({
      apiKey: "key_a",
      baseUrl: BASE_URL,
      statePath,
      fetchImpl,
    });
    const b = await resolveTelemetryIdentity({
      apiKey: "key_b",
      baseUrl: BASE_URL,
      statePath,
      fetchImpl,
    });
    expect(a.distinctId).toBe("user_a");
    expect(b.distinctId).toBe("user_b");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("resolveTelemetryIdentity — lookup failures fall back to the install id", () => {
  it.each([
    ["a 401", () => jsonResponse(401, { detail: "nope" })],
    ["a 404 (a server without the route)", () => jsonResponse(404, {})],
    ["a 200 without user_id", () => jsonResponse(200, { ok: true })],
    ["a 200 with an empty user_id", () => jsonResponse(200, { user_id: "  " })],
    ["a 200 with a non-object body", () => jsonResponse(200, "user_123")],
  ])("%s is refused and remembered for a day", async (_label, respond) => {
    const fetchImpl = vi.fn().mockImplementation(async () => respond());
    let clock = new Date("2026-09-24T00:00:00Z");
    const now = () => clock;

    const first = await resolveTelemetryIdentity({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      statePath,
      fetchImpl,
      now,
    });
    expect(first.identified).toBe(false);
    expect(first.distinctId).toMatch(UUID_RE);
    expect(readState().identities[identityCacheKey(BASE_URL, API_KEY)].user_id).toBeNull();

    const second = await resolveTelemetryIdentity({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      statePath,
      fetchImpl,
      now,
    });
    expect(second.distinctId).toBe(first.distinctId);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    clock = new Date(clock.getTime() + NEGATIVE_CACHE_TTL_MS + 1);
    await resolveTelemetryIdentity({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      statePath,
      fetchImpl,
      now,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a 500", () => Promise.resolve(jsonResponse(500, {}))],
    ["a 429", () => Promise.resolve(jsonResponse(429, {}))],
    ["a network error", () => Promise.reject(new TypeError("fetch failed"))],
    ["malformed JSON", () => Promise.resolve(new Response("<html>", { status: 200 }))],
  ])("%s is not cached, so the next call asks again", async (_label, respond) => {
    const fetchImpl = vi.fn().mockImplementation(respond);
    const first = await resolveTelemetryIdentity({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      statePath,
      fetchImpl,
    });
    expect(first.identified).toBe(false);
    await resolveTelemetryIdentity({ apiKey: API_KEY, baseUrl: BASE_URL, statePath, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(readState().identities).toBeUndefined();
  });

  it("aborts a lookup that outlives the timeout", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      );
      const pending = resolveTelemetryIdentity({
        apiKey: API_KEY,
        baseUrl: BASE_URL,
        statePath,
        fetchImpl,
      });
      await vi.advanceTimersByTimeAsync(2000);
      const who = await pending;
      expect(who.identified).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a cached refusal with an unparseable timestamp", async () => {
    mkdirSync(join(statePath, ".."), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({
        install_id: "11111111-1111-4111-8111-111111111111",
        identities: {
          [identityCacheKey(BASE_URL, API_KEY)]: { user_id: null, checked_at: "garbage" },
        },
      }),
      "utf-8",
    );
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { user_id: "user_123" }));
    const who = await resolveTelemetryIdentity({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      statePath,
      fetchImpl,
    });
    expect(who.distinctId).toBe("user_123");
    expect(existsSync(statePath)).toBe(true);
  });
});
