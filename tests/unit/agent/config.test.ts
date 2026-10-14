import { describe, it, expect, vi, beforeEach } from "vitest";

// Keep the real config module (VALID_KEYS, resolveKey, isValidBaseUrl, …) and
// only stub the two readers the masking paths use.
vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/config/config.js")>();
  return {
    ...actual,
    listConfig: vi.fn(),
    getConfigValue: vi.fn(),
  };
});

// Capture what agentSuccess receives.
let captured: Record<string, unknown> | undefined;
vi.mock("../../../src/agent/output.js", () => ({
  agentSuccess: vi.fn((result: Record<string, unknown>) => {
    captured = result;
  }),
  agentError: vi.fn(),
  AGENT_ERROR_DOMAINS: { CONFIG: "config" },
}));

import { agentConfigList, agentConfigGet } from "../../../src/agent/commands/config.js";
import { listConfig, getConfigValue } from "../../../src/config/config.js";

const SECRET = "plx_sk_supersecret_value_1234567890";

beforeEach(() => {
  captured = undefined;
  vi.clearAllMocks();
});

describe("agent config — secret masking", () => {
  it("config list masks the api-key but passes other values through", async () => {
    vi.mocked(listConfig).mockReturnValue([
      { key: "apiKey", cliKey: "api-key", value: SECRET, source: "env" },
      { key: "runner", cliKey: "runner", value: "api", source: "file" },
      { key: "baseUrl", cliKey: "base-url", value: "https://api-dev.pipelex.com", source: "file" },
    ]);

    await agentConfigList();

    const entries = (captured as { config: Array<{ cliKey?: string; key: string; value: string }> }).config;
    const apiKey = entries.find((e) => e.key === "api-key");
    const runner = entries.find((e) => e.key === "runner");

    expect(apiKey!.value).not.toBe(SECRET);
    expect(apiKey!.value).not.toContain("supersecret");
    expect(apiKey!.value).toContain("*");
    // Non-secret values are untouched.
    expect(runner!.value).toBe("api");
  });

  it("config get api-key returns a masked value", async () => {
    vi.mocked(getConfigValue).mockReturnValue({ value: SECRET, source: "env" });

    await agentConfigGet("api-key");

    expect((captured as { value: string }).value).not.toBe(SECRET);
    expect((captured as { value: string }).value).toContain("*");
  });

  it("config get of a non-secret key is not masked", async () => {
    vi.mocked(getConfigValue).mockReturnValue({ value: "api", source: "file" });

    await agentConfigGet("runner");

    expect((captured as { value: string }).value).toBe("api");
  });
});
