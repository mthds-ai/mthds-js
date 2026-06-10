import { describe, it, expect, vi, beforeEach } from "vitest";

// This suite exercises the legacy-`apiUrl` migration fail-fast, which is
// SCOPED to the api-runner construction path — it must fire when the api
// runner needs a URL while a leftover legacy `apiUrl` is present and
// `runnerUrl` was never explicitly set, and must NOT block pure
// `pipelex`-runner flows or `loadConfig()` itself.

vi.mock("../../../src/config/config.js", () => ({
  loadConfig: vi.fn(),
  getConfigValue: vi.fn(),
  hasLegacyApiUrl: vi.fn(),
  LEGACY_API_URL_MIGRATION_MESSAGE:
    "`apiUrl` is replaced by `runnerUrl` (required) + `platformUrl` (optional). " +
    "Hosted: runnerUrl=https://api.pipelex.com/runner/v1 ; " +
    "Self-host: runnerUrl=http://<host>/api/v1",
}));

import { ApiRunner } from "../../../src/runners/api-runner.js";
import { createRunner } from "../../../src/runners/registry.js";
import { PipelexRunner } from "../../../src/runners/pipelex-runner.js";
import * as configModule from "../../../src/config/config.js";

const loadConfig = vi.mocked(configModule.loadConfig);
const getConfigValue = vi.mocked(configModule.getConfigValue);
const hasLegacyApiUrl = vi.mocked(configModule.hasLegacyApiUrl);

const HOSTED = {
  runnerUrl: "https://api.pipelex.com/runner/v1",
  platformUrl: "https://api.pipelex.com/platform/v1",
  apiKey: "",
  telemetry: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ApiRunner legacy apiUrl migration fail-fast", () => {
  it("throws a migration hint when runnerUrl is at default AND a legacy apiUrl is present", () => {
    loadConfig.mockReturnValue({ runner: "api", ...HOSTED });
    getConfigValue.mockReturnValue({ value: HOSTED.runnerUrl, source: "default" });
    hasLegacyApiUrl.mockReturnValue(true);

    expect(() => new ApiRunner()).toThrow(/`apiUrl` is replaced by `runnerUrl`/);
  });

  it("does NOT throw when runnerUrl was explicitly configured, even with a legacy apiUrl present", () => {
    loadConfig.mockReturnValue({
      runner: "api",
      ...HOSTED,
      runnerUrl: "http://localhost:8081/api/v1",
    });
    getConfigValue.mockReturnValue({ value: "http://localhost:8081/api/v1", source: "file" });
    hasLegacyApiUrl.mockReturnValue(true);

    expect(() => new ApiRunner()).not.toThrow();
  });

  it("does NOT throw when no legacy apiUrl is present (clean install)", () => {
    loadConfig.mockReturnValue({ runner: "api", ...HOSTED });
    getConfigValue.mockReturnValue({ value: HOSTED.runnerUrl, source: "default" });
    hasLegacyApiUrl.mockReturnValue(false);

    expect(() => new ApiRunner()).not.toThrow();
  });

  it("leaves the pure pipelex-runner flow unaffected by a leftover legacy apiUrl", () => {
    // createRunner('pipelex') must never construct an ApiRunner, so the
    // migration check never runs — even with a legacy apiUrl present.
    loadConfig.mockReturnValue({ runner: "pipelex", ...HOSTED });
    getConfigValue.mockReturnValue({ value: HOSTED.runnerUrl, source: "default" });
    hasLegacyApiUrl.mockReturnValue(true);

    const runner = createRunner("pipelex");
    expect(runner).toBeInstanceOf(PipelexRunner);
    expect(hasLegacyApiUrl).not.toHaveBeenCalled();
  });
});
