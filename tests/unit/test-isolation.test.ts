import { describe, expect, it } from "vitest";
import { homedir, userInfo } from "node:os";

// The isolation every test runs under, set up by vitest.config.ts and tests/support/: a scratch
// home, statistics off, a loopback endpoint, and no connection to any other host.

const REFUSED_KEY = Symbol.for("mthds.tests.refusedHosts");

function takeRefusedHosts(): string[] {
  const shared = globalThis as unknown as Record<symbol, string[] | undefined>;
  return (shared[REFUSED_KEY] ?? []).splice(0);
}

describe("test isolation", () => {
  it("runs every test under a scratch home, never the account's", () => {
    expect(homedir()).not.toBe(userInfo().homedir);
    expect(process.env["HOME"]).toBe(homedir());
  });

  it("keeps usage statistics and method events off, and their endpoint on loopback", () => {
    expect(process.env["DO_NOT_TRACK"]).toBe("1");
    expect(process.env["PIPELEX_USAGE_STATS_ENDPOINT"]).toBe("http://127.0.0.1:9");
  });

  it("refuses a connection to PostHog, or to any host but a loopback one", async () => {
    await expect(fetch("https://eu.i.posthog.com/batch/", { method: "POST" })).rejects.toThrow();
    await expect(fetch("https://mthds.sh/api/v1/registry/methods")).rejects.toThrow();
    expect(takeRefusedHosts()).toEqual(["eu.i.posthog.com", "mthds.sh"]);
  });

  it("lets a loopback connection through", async () => {
    await expect(fetch("http://127.0.0.1:9/")).rejects.toThrow();
    expect(takeRefusedHosts()).toEqual([]);
  });
});
