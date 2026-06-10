import { describe, it, expect, vi, beforeEach } from "vitest";

// This suite exercises the legacy `PIPELEX_*` migration fail-fast, which is
// SCOPED to the api-runner construction path — it must fire when the api
// runner needs a value while a leftover legacy key is present and the new key
// (`MTHDS_API_URL` / `MTHDS_API_KEY`) was never explicitly set, and must NOT
// block pure `pipelex`-runner flows or `loadConfig()` itself.

vi.mock("../../../src/config/config.js", () => ({
  loadConfig: vi.fn(),
  getConfigValue: vi.fn(),
  findLegacyUrlKey: vi.fn(),
  findLegacyApiKeyKey: vi.fn(),
}));

import { ApiRunner } from "../../../src/runners/api-runner.js";
import { createRunner } from "../../../src/runners/registry.js";
import { PipelexRunner } from "../../../src/runners/pipelex-runner.js";
import * as configModule from "../../../src/config/config.js";

const loadConfig = vi.mocked(configModule.loadConfig);
const getConfigValue = vi.mocked(configModule.getConfigValue);
const findLegacyUrlKey = vi.mocked(configModule.findLegacyUrlKey);
const findLegacyApiKeyKey = vi.mocked(configModule.findLegacyApiKeyKey);

const HOSTED = {
  baseUrl: "https://api.pipelex.com",
  apiKey: "",
  telemetry: true,
  autoUpgrade: false,
  updateCheck: true,
} as const;

const URL_MIGRATION = {
  key: "PIPELEX_RUNNER_URL",
  message:
    "`PIPELEX_RUNNER_URL` is replaced by `MTHDS_API_URL` (host only, no version prefix). Migrate with: mthds config set base-url <host>",
};

const KEY_MIGRATION = {
  key: "PIPELEX_API_KEY",
  message: "`PIPELEX_API_KEY` is replaced by `MTHDS_API_KEY`. Migrate with: mthds config set api-key <key>",
};

beforeEach(() => {
  vi.clearAllMocks();
  findLegacyUrlKey.mockReturnValue(undefined);
  findLegacyApiKeyKey.mockReturnValue(undefined);
});

describe("ApiRunner legacy key migration fail-fast", () => {
  it("throws the URL migration hint when baseUrl is at default AND a legacy URL key is present", () => {
    loadConfig.mockReturnValue({ runner: "api", ...HOSTED });
    getConfigValue.mockReturnValue({ value: HOSTED.baseUrl, source: "default" });
    findLegacyUrlKey.mockReturnValue(URL_MIGRATION);

    expect(() => new ApiRunner()).toThrow(/`PIPELEX_RUNNER_URL` is replaced by `MTHDS_API_URL`/);
  });

  it("throws the api-key migration hint when apiKey is at default AND PIPELEX_API_KEY is present", () => {
    loadConfig.mockReturnValue({ runner: "api", ...HOSTED });
    getConfigValue.mockReturnValue({ value: "", source: "default" });
    findLegacyApiKeyKey.mockReturnValue(KEY_MIGRATION);

    expect(() => new ApiRunner()).toThrow(/`PIPELEX_API_KEY` is replaced by `MTHDS_API_KEY`/);
  });

  it("does NOT throw when baseUrl was explicitly configured, even with a legacy URL key present", () => {
    loadConfig.mockReturnValue({
      runner: "api",
      ...HOSTED,
      baseUrl: "http://localhost:8081",
    });
    getConfigValue.mockImplementation((key) =>
      key === "baseUrl"
        ? { value: "http://localhost:8081", source: "file" }
        : { value: "explicit-key", source: "file" }
    );
    findLegacyUrlKey.mockReturnValue(URL_MIGRATION);

    expect(() => new ApiRunner()).not.toThrow();
  });

  it("does NOT throw when no legacy key is present (clean install)", () => {
    loadConfig.mockReturnValue({ runner: "api", ...HOSTED });
    getConfigValue.mockReturnValue({ value: HOSTED.baseUrl, source: "default" });

    expect(() => new ApiRunner()).not.toThrow();
  });

  it("leaves the pure pipelex-runner flow unaffected by leftover legacy keys", () => {
    // createRunner('pipelex') must never construct an ApiRunner, so the
    // migration checks never run — even with legacy keys present.
    loadConfig.mockReturnValue({ runner: "pipelex", ...HOSTED });
    getConfigValue.mockReturnValue({ value: HOSTED.baseUrl, source: "default" });
    findLegacyUrlKey.mockReturnValue(URL_MIGRATION);
    findLegacyApiKeyKey.mockReturnValue(KEY_MIGRATION);

    const runner = createRunner("pipelex");
    expect(runner).toBeInstanceOf(PipelexRunner);
    expect(findLegacyUrlKey).not.toHaveBeenCalled();
    expect(findLegacyApiKeyKey).not.toHaveBeenCalled();
  });
});

describe("ApiRunner legacy env fail-fast (real config module behavior)", () => {
  // The mocked module above pins the gating logic; the detection of each of
  // the four PIPELEX_* env vars themselves is covered with the REAL config
  // module in tests/unit/config/config.test.ts ("legacy key detection").
  it("covers the gating contract: legacy hit + default new key → throw", () => {
    loadConfig.mockReturnValue({ runner: "api", ...HOSTED });
    getConfigValue.mockReturnValue({ value: HOSTED.baseUrl, source: "default" });
    for (const key of ["PIPELEX_RUNNER_URL", "PIPELEX_PLATFORM_URL", "PIPELEX_API_URL"]) {
      findLegacyUrlKey.mockReturnValue({ key, message: `\`${key}\` is replaced by \`MTHDS_API_URL\`` });
      expect(() => new ApiRunner()).toThrow(new RegExp(key));
    }
  });
});
