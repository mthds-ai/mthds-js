import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startLoopbackServer } from "../../../support/loopback-server.js";
import type { LoopbackServer } from "../../../support/loopback-server.js";
import {
  DEFAULT_HUB_URL,
  describeRegistration,
  readAnswer,
  registerMethod,
  registerMethods,
  resolveHubUrl,
} from "../../../../src/installer/registry/client.js";

// The client of mthds.sh's registry route, against a loopback server standing in for the hub. It
// reads every answer by its `outcome`, whatever the HTTP status says.

const LISTED = {
  address: "Mthds-AI/tools",
  name: "scoring",
  version: "1.2.0",
  commit_sha: "8d39d1dca38a4de613c20e85fbaa05dd75024835",
  url: "https://mthds.sh/methods/Mthds-AI/tools/scoring",
};

let hub: LoopbackServer;
const noSleep = vi.fn(async () => undefined);

beforeAll(async () => {
  hub = await startLoopbackServer();
});

afterAll(async () => {
  await hub.close();
});

beforeEach(() => {
  hub.requests.length = 0;
  noSleep.mockClear();
  hub.respond(() => ({
    status: 201,
    body: { outcome: "registered", method: LISTED, validation: "queued" },
  }));
});

describe("resolveHubUrl", () => {
  it("is mthds.sh when MTHDS_HUB_URL is unset or empty", () => {
    expect(resolveHubUrl({})).toEqual({ ok: true, url: DEFAULT_HUB_URL });
    expect(resolveHubUrl({ MTHDS_HUB_URL: "  " })).toEqual({ ok: true, url: DEFAULT_HUB_URL });
  });

  it.each([
    ["http://127.0.0.1:8787", "http://127.0.0.1:8787"],
    ["http://localhost:3000/", "http://localhost:3000"],
    ["http://[::1]:9", "http://[::1]:9"],
    ["http://127.0.0.1", "http://127.0.0.1"],
  ])("accepts the loopback origin %s", (value, url) => {
    expect(resolveHubUrl({ MTHDS_HUB_URL: value })).toEqual({ ok: true, url });
  });

  it.each([
    "https://mthds.sh",
    "http://mthds.sh",
    "http://127.0.0.1:8787/api",
    "http://127.0.0.1:0",
  ])("refuses %s, so a test can never point a publish at a real host", (value) => {
    const resolution = resolveHubUrl({ MTHDS_HUB_URL: value });
    expect(resolution.ok).toBe(false);
  });
});

describe("registerMethod", () => {
  it("posts {address, name} to the registry route and reads the method it lists", async () => {
    const answer = await registerMethod(
      { address: "mthds-ai/tools", name: "scoring" },
      { hubUrl: hub.origin },
    );
    expect(hub.requests).toEqual([
      {
        method: "POST",
        path: "/api/v1/registry/methods",
        body: { address: "mthds-ai/tools", name: "scoring" },
      },
    ]);
    expect(answer).toEqual({ outcome: "registered", method: LISTED, validation: "queued" });
  });

  it("reads a refusal by its outcome, though it comes as a 200", async () => {
    hub.respond(() => ({
      status: 200,
      body: {
        outcome: "refused",
        reason: "method_not_found",
        message: "No such method.",
        errors: [],
      },
    }));
    const answer = await registerMethod({ address: "a/b", name: "c" }, { hubUrl: hub.origin });
    expect(answer).toEqual({
      outcome: "refused",
      reason: "method_not_found",
      message: "No such method.",
      errors: [],
    });
  });

  it("waits out a rate limit for the time it gives, then retries", async () => {
    let calls = 0;
    hub.respond(() => {
      calls += 1;
      return calls === 1
        ? {
            status: 429,
            body: {
              outcome: "error",
              error: {
                code: "rate_limited",
                message: "Slow down.",
                retryable: true,
                retry_after_seconds: 7,
              },
            },
          }
        : { status: 200, body: { outcome: "unchanged", method: LISTED, validation: "up_to_date" } };
    });
    const waits: number[] = [];
    const answer = await registerMethod(
      { address: "a/b", name: "c" },
      { hubUrl: hub.origin, sleep: noSleep, onRateLimited: (seconds) => waits.push(seconds) },
    );
    expect(answer.outcome).toBe("unchanged");
    expect(waits).toEqual([7]);
    expect(noSleep).toHaveBeenCalledWith(7000);
    expect(hub.requests).toHaveLength(2);
  });

  it("gives up after its last attempt, and on a wait longer than it will spend", async () => {
    hub.respond(() => ({
      status: 429,
      body: {
        outcome: "error",
        error: {
          code: "rate_limited",
          message: "Slow down.",
          retryable: true,
          retry_after_seconds: 1,
        },
      },
    }));
    const answer = await registerMethod(
      { address: "a/b", name: "c" },
      { hubUrl: hub.origin, sleep: noSleep },
    );
    expect(answer).toMatchObject({ outcome: "error", error: { code: "rate_limited" } });
    expect(hub.requests).toHaveLength(3);

    hub.requests.length = 0;
    hub.respond(() => ({
      status: 429,
      body: {
        outcome: "error",
        error: {
          code: "rate_limited",
          message: "Later.",
          retryable: true,
          retry_after_seconds: 3600,
        },
      },
    }));
    await registerMethod({ address: "a/b", name: "c" }, { hubUrl: hub.origin, sleep: noSleep });
    expect(hub.requests).toHaveLength(1);
  });

  it("returns every other error as it came, without retrying", async () => {
    hub.respond(() => ({
      status: 502,
      body: {
        outcome: "error",
        error: { code: "upstream_unavailable", message: "GitHub is down.", retryable: true },
      },
    }));
    const answer = await registerMethod(
      { address: "a/b", name: "c" },
      { hubUrl: hub.origin, sleep: noSleep },
    );
    expect(answer).toEqual({
      outcome: "error",
      error: { code: "upstream_unavailable", message: "GitHub is down.", retryable: true },
    });
    expect(hub.requests).toHaveLength(1);
  });

  it("says the hub was unreachable when nothing answers", async () => {
    const answer = await registerMethod(
      { address: "a/b", name: "c" },
      { hubUrl: "http://127.0.0.1:9" },
    );
    expect(answer).toMatchObject({
      outcome: "error",
      error: { code: "unreachable", retryable: true },
    });
  });

  it("says the answer was not one it understands when the body is not JSON", async () => {
    hub.respond(() => ({ status: 502 }));
    const answer = await registerMethod({ address: "a/b", name: "c" }, { hubUrl: hub.origin });
    expect(answer).toMatchObject({
      outcome: "error",
      error: { code: "unexpected_response", retryable: true },
    });
  });
});

describe("readAnswer", () => {
  it.each([
    ["not an object", "nope"],
    ["no outcome", {}],
    ["an unknown outcome", { outcome: "maybe" }],
    ["an accepted outcome without its method", { outcome: "updated" }],
    ["an error without its code", { outcome: "error", error: {} }],
  ])("reads %s as an unexpected response", (_label, body) => {
    expect(readAnswer(body)).toMatchObject({
      outcome: "error",
      error: { code: "unexpected_response" },
    });
  });

  it("keeps the validation issues of a bad request", () => {
    const answer = readAnswer({
      outcome: "error",
      error: {
        code: "bad_request",
        message: "The request is invalid.",
        retryable: false,
        issues: [{ path: "address", message: "names a subdirectory" }],
      },
    });
    expect(describeRegistration({ name: "c", answer })).toBe(
      "c: not published (bad_request): The request is invalid. address: names a subdirectory",
    );
  });
});

describe("registerMethods", () => {
  it("sends one request per method, in order, and answers by name", async () => {
    const named: string[] = [];
    const registrations = await registerMethods(
      [
        { address: "a/b", name: "first" },
        { address: "a/b", name: "second" },
      ],
      { hubUrl: hub.origin, onMethod: (name) => named.push(name) },
    );
    expect(named).toEqual(["first", "second"]);
    expect(hub.requests.map((request) => (request.body as { name: string }).name)).toEqual([
      "first",
      "second",
    ]);
    expect(registrations.map((registration) => registration.name)).toEqual(["first", "second"]);
  });
});
