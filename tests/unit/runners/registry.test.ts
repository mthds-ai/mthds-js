import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApiRunner } from "../../../src/runners/api-runner.js";
import { PipelexRunner } from "../../../src/runners/pipelex-runner.js";

// Mock the config module so createRunner() does not read the real filesystem
vi.mock("../../../src/config/config.js", () => ({
  loadConfig: vi.fn(() => ({
    runner: "api",
    apiUrl: "https://api.pipelex.com",
    apiKey: "",
    telemetry: true,
  })),
}));

// Import after mock setup
import { createRunner } from "../../../src/runners/registry.js";
import { loadConfig } from "../../../src/config/config.js";

const mockedLoadConfig = vi.mocked(loadConfig);

describe("createRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ApiRunner when type is 'api'", () => {
    const runner = createRunner("api");
    expect(runner).toBeInstanceOf(ApiRunner);
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
      apiUrl: "https://api.pipelex.com",
      apiKey: "",
      telemetry: true,
    });

    const runner = createRunner();
    expect(runner).toBeInstanceOf(PipelexRunner);
    expect(loadConfig).toHaveBeenCalled();
  });

  it("uses config default 'api' runner", () => {
    mockedLoadConfig.mockReturnValue({
      runner: "api",
      apiUrl: "https://api.pipelex.com",
      apiKey: "test-key",
      telemetry: true,
    });

    const runner = createRunner();
    expect(runner).toBeInstanceOf(ApiRunner);
    expect(loadConfig).toHaveBeenCalled();
  });

  it("throws on unknown runner type", () => {
    expect(() => createRunner("unknown" as never)).toThrow(
      "Unknown runner type: unknown"
    );
  });
});
