import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

const mockCapture = vi.fn();
const mockShutdown = vi.fn().mockResolvedValue(undefined);

vi.mock("posthog-node", () => {
  const MockPostHog = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.capture = mockCapture;
    this.shutdown = mockShutdown;
  });
  return { PostHog: MockPostHog };
});

vi.mock("../../../../src/config/config.js", () => ({
  isTelemetryEnabled: vi.fn().mockReturnValue(true),
  getTelemetryDisablingEnvVar: vi.fn().mockReturnValue(undefined),
}));

import { isTelemetryEnabled, getTelemetryDisablingEnvVar } from "../../../../src/config/config.js";
import {
  trackPublish,
  trackInstall,
  publishBlockedByTelemetry,
  shutdown,
} from "../../../../src/installer/telemetry/posthog.js";
import type { ResolvedMethod } from "../../../../src/package/manifest/types.js";

const mockedIsTelemetryEnabled = vi.mocked(isTelemetryEnabled);
const mockedGetTelemetryDisablingEnvVar = vi.mocked(getTelemetryDisablingEnvVar);

beforeEach(async () => {
  // Drop the client a previous test created, so each test sees getClient()
  // consult isTelemetryEnabled afresh.
  await shutdown();
  vi.clearAllMocks();
  mockedIsTelemetryEnabled.mockReturnValue(true);
  mockedGetTelemetryDisablingEnvVar.mockReturnValue(undefined);
});

const sampleMethod: ResolvedMethod = {
  name: "contract-analysis",
  manifest: {
    package: {
      address: "github.com/mthds-ai/contract-analysis",
      name: "contract-analysis",
      main_pipe: "analyze",
      version: "1.0.0",
      description: "Analyze contracts",
      display_name: "Contract Analysis",
      authors: ["Alice"],
      license: "MIT",
      mthds_version: "0.1.0",
    },
    exports: { pipes: { pipes: ["analyze"] } },
  },
  rawManifest: "[package]\nname = 'contract-analysis'",
  files: [],
};

describe("trackPublish", () => {
  it("captures a method_publish event with the manifest's fields one by one", () => {
    trackPublish(sampleMethod, "mthds-ai/contract-analysis");

    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: "anonymous",
        event: "method_publish",
        properties: expect.objectContaining({
          address: "mthds-ai/contract-analysis",
          name: "contract-analysis",
          main_pipe: "analyze",
          package_version: "1.0.0",
          description: "Analyze contracts",
          display_name: "Contract Analysis",
          authors: ["Alice"],
          license: "MIT",
          mthds_version: "0.1.0",
          exports: { pipes: { pipes: ["analyze"] } },
        }),
      }),
    );
  });

  it("never sends the manifest's raw text", () => {
    trackPublish(sampleMethod, "mthds-ai/contract-analysis");

    const call = mockCapture.mock.calls[0]![0];
    expect(call.properties).not.toHaveProperty("manifest_raw");
    expect(Object.values(call.properties)).not.toContain(sampleMethod.rawManifest);
  });

  it("falls back to the manifest's address, without its github.com/ prefix", () => {
    trackPublish(sampleMethod);

    const call = mockCapture.mock.calls[0]![0];
    expect(call.properties.address).toBe("mthds-ai/contract-analysis");
  });

  it("includes a timestamp in properties", () => {
    trackPublish(sampleMethod, "mthds-ai/contract-analysis");

    const call = mockCapture.mock.calls[0]![0];
    expect(call.properties.timestamp).toBeDefined();
    expect(new Date(call.properties.timestamp).toISOString()).toBe(call.properties.timestamp);
  });

  it("sends nothing when telemetry is disabled", () => {
    mockedIsTelemetryEnabled.mockReturnValue(false);

    trackPublish(sampleMethod, "mthds-ai/contract-analysis");

    expect(mockCapture).not.toHaveBeenCalled();
  });
});

describe("trackInstall", () => {
  it("captures a method_install event (not method_publish)", () => {
    trackInstall(sampleMethod, "mthds-ai/contract-analysis");

    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "method_install",
      }),
    );
  });
});

describe("trackPublish vs trackInstall", () => {
  it("emit different event names with the same properties shape", () => {
    trackPublish(sampleMethod, "mthds-ai/contract-analysis");
    trackInstall(sampleMethod, "mthds-ai/contract-analysis");

    expect(mockCapture).toHaveBeenCalledTimes(2);
    const publishCall = mockCapture.mock.calls[0]![0];
    const installCall = mockCapture.mock.calls[1]![0];

    expect(publishCall.event).toBe("method_publish");
    expect(installCall.event).toBe("method_install");

    const publishKeys = Object.keys(publishCall.properties).sort();
    const installKeys = Object.keys(installCall.properties).sort();
    expect(publishKeys).toEqual(installKeys);
  });
});

describe("publishBlockedByTelemetry", () => {
  it("is undefined while telemetry is on", () => {
    expect(publishBlockedByTelemetry()).toBeUndefined();
  });

  it("names the environment variable holding telemetry off", () => {
    mockedIsTelemetryEnabled.mockReturnValue(false);
    mockedGetTelemetryDisablingEnvVar.mockReturnValue("DO_NOT_TRACK");

    const reason = publishBlockedByTelemetry();

    expect(reason).toMatch(/^Nothing was published/);
    expect(reason).toContain("DO_NOT_TRACK is set in your environment");
  });

  it("points at mthds telemetry enable when the config file holds it off", () => {
    mockedIsTelemetryEnabled.mockReturnValue(false);

    const reason = publishBlockedByTelemetry();

    expect(reason).toContain("~/.mthds/config");
    expect(reason).toContain("mthds telemetry enable");
  });
});

describe("shutdown", () => {
  it("flushes the client without throwing", async () => {
    trackPublish(sampleMethod, "mthds-ai/contract-analysis");
    await shutdown();
    expect(mockShutdown).toHaveBeenCalled();
  });
});
