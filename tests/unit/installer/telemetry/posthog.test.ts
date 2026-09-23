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
  setTelemetryEnabled: vi.fn(),
  getTelemetrySource: vi.fn().mockReturnValue("default"),
}));

const mockResolveIdentity = vi.fn();

vi.mock("../../../../src/installer/telemetry/identity.js", () => ({
  ORGANIZATION_GROUP_TYPE: "organization",
  resolveTelemetryIdentity: (...args: unknown[]) => mockResolveIdentity(...args),
}));

import { isTelemetryEnabled } from "../../../../src/config/config.js";
import {
  trackPublish,
  trackInstall,
  shutdown,
} from "../../../../src/installer/telemetry/posthog.js";
import type { InstallEvent } from "../../../../src/installer/telemetry/posthog.js";

const INSTALL_ID = "0b9c2f7e-8d3a-4c1e-9f7a-2b6d4e8a1c3f";

beforeEach(async () => {
  // Drain the previous test's captures and reset the per-process identity memo.
  await shutdown();
  vi.clearAllMocks();
  vi.mocked(isTelemetryEnabled).mockReturnValue(true);
  mockResolveIdentity.mockResolvedValue({ distinctId: INSTALL_ID, identified: false });
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
  it("captures a method_publish event with correct properties", async () => {
    trackPublish(sampleEvent);
    await shutdown();

    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: INSTALL_ID,
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
      }),
    );
  });

  it("includes a timestamp in properties", async () => {
    trackPublish(sampleEvent);
    await shutdown();

    const call = mockCapture.mock.calls[0]![0];
    expect(call.properties.timestamp).toBeDefined();
    expect(new Date(call.properties.timestamp).toISOString()).toBe(call.properties.timestamp);
  });
});

describe("trackInstall", () => {
  it("captures a method_install event (not method_publish)", async () => {
    trackInstall(sampleEvent);
    await shutdown();

    expect(mockCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "method_install",
      }),
    );
  });
});

describe("trackPublish vs trackInstall", () => {
  it("emit different event names with the same properties shape", async () => {
    trackPublish(sampleEvent);
    trackInstall(sampleEvent);
    await shutdown();

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

describe("identity", () => {
  it("never sends the shared constant 'anonymous'", async () => {
    trackInstall(sampleEvent);
    await shutdown();
    expect(mockCapture.mock.calls[0]![0].distinctId).not.toBe("anonymous");
  });

  it("sends an anonymous install id without creating a person profile or a group", async () => {
    trackInstall(sampleEvent);
    await shutdown();
    const call = mockCapture.mock.calls[0]![0];
    expect(call.distinctId).toBe(INSTALL_ID);
    expect(call.properties.$process_person_profile).toBe(false);
    expect(call.groups).toBeUndefined();
  });

  it("sends the platform user id as a person, with no organization group when none is known", async () => {
    mockResolveIdentity.mockResolvedValue({ distinctId: "user_123", identified: true });
    trackPublish(sampleEvent);
    await shutdown();
    const call = mockCapture.mock.calls[0]![0];
    expect(call.distinctId).toBe("user_123");
    expect(call.properties).not.toHaveProperty("$process_person_profile");
    expect(call.groups).toBeUndefined();
  });

  it("attaches the organization group when the identity carries one", async () => {
    mockResolveIdentity.mockResolvedValue({
      distinctId: "user_123",
      identified: true,
      orgId: "org_456",
    });
    trackInstall(sampleEvent);
    await shutdown();
    const call = mockCapture.mock.calls[0]![0];
    expect(call.distinctId).toBe("user_123");
    expect(call.groups).toEqual({ organization: "org_456" });
  });

  it("resolves the identity once per process, however many events are sent", async () => {
    trackInstall(sampleEvent);
    trackInstall(sampleEvent);
    trackPublish(sampleEvent);
    await shutdown();
    expect(mockResolveIdentity).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledTimes(3);
  });

  it("resolves afresh after shutdown", async () => {
    trackInstall(sampleEvent);
    await shutdown();
    trackInstall(sampleEvent);
    await shutdown();
    expect(mockResolveIdentity).toHaveBeenCalledTimes(2);
  });

  it("swallows an identity failure instead of crashing the CLI", async () => {
    mockResolveIdentity.mockRejectedValue(new Error("boom"));
    trackInstall(sampleEvent);
    await expect(shutdown()).resolves.toBeUndefined();
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

describe("opt-out", () => {
  it("neither resolves an identity nor captures when telemetry is disabled", async () => {
    vi.mocked(isTelemetryEnabled).mockReturnValue(false);
    trackInstall(sampleEvent);
    trackPublish(sampleEvent);
    await shutdown();
    expect(mockResolveIdentity).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });
});
