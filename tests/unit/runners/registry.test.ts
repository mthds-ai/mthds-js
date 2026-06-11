import { describe, it, expect, vi, beforeEach } from "vitest";
import { MthdsApiClient } from "../../../src/runners/api/client.js";
import { PipelexRunner } from "../../../src/runners/pipelex/runner.js";

// Mock the config module so createRunner() does not read the real filesystem
vi.mock("../../../src/config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    runner: "api",
    baseUrl: "https://api.pipelex.com",
    apiKey: "",
    telemetry: true,
  })),
  getConfigValue: vi.fn(() => ({ value: "https://api.pipelex.com", source: "default" })),
  findLegacyUrlKey: vi.fn(() => undefined),
  findLegacyApiKeyKey: vi.fn(() => undefined),
}));

// Import after mock setup
import { createRunner } from "../../../src/runners/registry.js";
import { loadConfig } from "../../../src/config/config.js";

const mockedLoadConfig = vi.mocked(loadConfig);

describe("createRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the API client (the API runner) when type is 'api'", () => {
    const runner = createRunner("api");
    expect(runner).toBeInstanceOf(MthdsApiClient);
    expect(runner.type).toBe("api");
  });

  it("returns PipelexRunner when type is 'pipelex'", () => {
    const runner = createRunner("pipelex");
    expect(runner).toBeInstanceOf(PipelexRunner);
    expect(runner.type).toBe("pipelex");
  });

  it("reads default runner type from config when no type is passed", () => {
    mockedLoadConfig.mockReturnValue({
      runner: "pipelex",
      baseUrl: "https://api.pipelex.com",
      apiKey: "",
      telemetry: true,
      autoUpgrade: false,
      updateCheck: true,
    });

    const runner = createRunner();
    expect(runner).toBeInstanceOf(PipelexRunner);
    expect(loadConfig).toHaveBeenCalled();
  });

  it("uses config default 'api' runner", () => {
    mockedLoadConfig.mockReturnValue({
      runner: "api",
      baseUrl: "https://api.pipelex.com",
      apiKey: "test-key",
      telemetry: true,
      autoUpgrade: false,
      updateCheck: true,
    });

    const runner = createRunner();
    expect(runner).toBeInstanceOf(MthdsApiClient);
    expect(loadConfig).toHaveBeenCalled();
  });

  it("throws on unknown runner type", () => {
    expect(() => createRunner("unknown" as never)).toThrow(
      "Unknown runner type: unknown"
    );
  });
});
