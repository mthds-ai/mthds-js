import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../src/config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    runner: "api",
    apiUrl: "https://api.pipelex.com",
    apiKey: "test-key",
    telemetry: true,
  })),
}));

import { ApiRunner } from "../../../src/runners/api-runner.js";

describe("ApiRunner error handling", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("extracts RFC 7807 title and detail into the thrown error message", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          type: "https://docs.pipelex.com/latest/errors/validate-bundle-error/",
          title: "Validate bundle error",
          status: 422,
          detail: "Bundle does not declare a main_pipe, which is required for validation.",
          instance: "/api/v1/validate",
          error_type: "ValidateBundleError",
          error_domain: "input",
          retryable: false,
        }),
        {
          status: 422,
          headers: { "content-type": "application/problem+json" },
        }
      )
    ) as typeof fetch;

    const runner = new ApiRunner();

    await expect(
      runner.validate({ mthds_contents: ["bogus"] })
    ).rejects.toThrow(
      /Validate bundle error: Bundle does not declare a main_pipe/
    );
  });

  it("falls back to status + body text when the response is not problem+json", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("upstream timeout", {
        status: 502,
        headers: { "content-type": "text/plain" },
      })
    ) as typeof fetch;

    const runner = new ApiRunner();

    await expect(
      runner.validate({ mthds_contents: ["bogus"] })
    ).rejects.toThrow(/failed \(502\): upstream timeout/);
  });

  it("falls back gracefully when the problem+json body is malformed", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("{not valid json", {
        status: 500,
        headers: { "content-type": "application/problem+json" },
      })
    ) as typeof fetch;

    const runner = new ApiRunner();

    await expect(
      runner.validate({ mthds_contents: ["bogus"] })
    ).rejects.toThrow(/failed \(500\)/);
  });
});
