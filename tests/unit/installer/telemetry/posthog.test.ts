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

vi.mock("../../../../src/config/credentials.js", () => ({
  isTelemetryEnabled: vi.fn().mockReturnValue(true),
  setTelemetryEnabled: vi.fn(),
  getTelemetrySource: vi.fn().mockReturnValue("default"),
}));

import { trackPublish, trackInstall, shutdown } from "../../../../src/installer/telemetry/posthog.js";
import type { InstallEvent } from "../../../../src/installer/telemetry/posthog.js";

beforeEach(() => {
  vi.clearAllMocks();
});

const sampleEvent: InstallEvent = {
  address: "mthds-ai/contract-analysis",
  name: "contract-analysis",
  main_pipe: "analyze",
  version: "1.0.0",
  description: "Analyze contracts",
  display_name: "Contract Analysis",
  authors: ["Alice"],
  license: "MIT",
  mthds_version: "0.1.0",
  exports: { pipes: { analyze: {} } },
  manifest_raw: "[package]\nname = 'contract-analysis'",
};

describe("trackPublish", () => {
  it("captures a method_publish event with correct properties", () => {
    trackPublish(sampleEvent);

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
          exports: { pipes: { analyze: {} } },
          manifest_raw: "[package]\nname = 'contract-analysis'",
        }),
      })
    );
  });

  it("includes a timestamp in properties", () => {
    trackPublish(sampleEvent);

    const call = mockCapture.mock.calls[0]![0];
    expect(call.properties.timestamp).toBeDefined();
    expect(new Date(call.properties.timestamp).toISOString()).toBe(call.properties.timestamp);
  });
});

describe("trackInstall", () => {
  it("captures a method_install event (not method_publish)", () => {
    trackInstall(sampleEvent);

    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "method_install",
      })
    );
  });
});

describe("trackPublish vs trackInstall", () => {
  it("emit different event names with the same properties shape", () => {
    trackPublish(sampleEvent);
    trackInstall(sampleEvent);

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

describe("shutdown", () => {
  it("flushes the client without throwing", async () => {
    trackPublish(sampleEvent);
    await shutdown();
    expect(mockShutdown).toHaveBeenCalled();
  });
});
