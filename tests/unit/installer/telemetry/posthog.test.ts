import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("../../../../src/usage-stats/switches.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/usage-stats/switches.js")>()),
  methodEventsEnabled: vi.fn().mockReturnValue(true),
}));

import { PostHog } from "posthog-node";
import { methodEventsEnabled } from "../../../../src/usage-stats/switches.js";
import {
  trackLocalPublish,
  trackPublish,
  trackInstall,
  shutdown,
} from "../../../../src/installer/telemetry/posthog.js";
import type { ResolvedMethod } from "../../../../src/package/manifest/types.js";

const mockedMethodEventsEnabled = vi.mocked(methodEventsEnabled);
const MockedPostHog = vi.mocked(PostHog);

beforeEach(async () => {
  // Drop the client a previous test created, so each test sees getClient()
  // consult the switches afresh.
  await shutdown();
  vi.clearAllMocks();
  mockedMethodEventsEnabled.mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
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

describe("trackLocalPublish", () => {
  it("carries only what the hub answered, never a field of the local manifest", () => {
    trackLocalPublish({
      address: "MTHDS-AI/contract-analysis",
      name: "contract-analysis",
      version: "1.0.0",
      commit_sha: "8d39d1dca38a4de613c20e85fbaa05dd75024835",
      url: "https://mthds.sh/methods/MTHDS-AI/contract-analysis/contract-analysis",
    });

    expect(mockCapture).toHaveBeenCalledTimes(1);
    const captured = mockCapture.mock.calls[0]![0] as {
      event: string;
      properties: Record<string, unknown>;
    };
    expect(captured.event).toBe("method_publish");
    expect(Object.keys(captured.properties).sort()).toEqual([
      "address",
      "name",
      "package_version",
      "timestamp",
    ]);
    expect(captured.properties).toMatchObject({
      address: "MTHDS-AI/contract-analysis",
      name: "contract-analysis",
      package_version: "1.0.0",
    });
  });

  it("sends nothing when a switch turns the method events off", () => {
    mockedMethodEventsEnabled.mockReturnValue(false);
    trackLocalPublish({
      address: "a/b",
      name: "c",
      version: "1.0.0",
      commit_sha: "",
      url: "https://mthds.sh/methods/a/b/c",
    });
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

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

  it("sends the address mthds.sh listed the method under", () => {
    trackPublish(sampleMethod, "MTHDS-AI/Contract-Analysis");

    const call = mockCapture.mock.calls[0]![0];
    expect(call.properties.address).toBe("MTHDS-AI/Contract-Analysis");
  });

  it("falls back to the manifest's address, without its github.com/ prefix", () => {
    trackInstall(sampleMethod);

    const call = mockCapture.mock.calls[0]![0];
    expect(call.properties.address).toBe("mthds-ai/contract-analysis");
  });

  it("includes a timestamp in properties", () => {
    trackPublish(sampleMethod, "mthds-ai/contract-analysis");

    const call = mockCapture.mock.calls[0]![0];
    expect(call.properties.timestamp).toBeDefined();
    expect(new Date(call.properties.timestamp).toISOString()).toBe(call.properties.timestamp);
  });

  it("sends nothing when a switch turns the method events off", () => {
    mockedMethodEventsEnabled.mockReturnValue(false);

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

describe("where the events go", () => {
  it("posts to PostHog's EU host when no endpoint override is set", () => {
    vi.stubEnv("PIPELEX_USAGE_STATS_ENDPOINT", undefined);
    trackInstall(sampleMethod, "mthds-ai/contract-analysis");

    expect(MockedPostHog).toHaveBeenCalledWith(expect.any(String), {
      host: "https://eu.i.posthog.com",
      disableGeoip: true,
    });
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it("posts to a loopback endpoint override instead of PostHog", () => {
    vi.stubEnv("PIPELEX_USAGE_STATS_ENDPOINT", "http://127.0.0.1:8123");
    trackInstall(sampleMethod, "mthds-ai/contract-analysis");

    expect(MockedPostHog).toHaveBeenCalledWith(expect.any(String), {
      host: "http://127.0.0.1:8123",
      disableGeoip: true,
    });
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  it("sends nothing at an endpoint override that is not a loopback origin", () => {
    vi.stubEnv("PIPELEX_USAGE_STATS_ENDPOINT", "https://eu.i.posthog.com");
    trackInstall(sampleMethod, "mthds-ai/contract-analysis");

    expect(MockedPostHog).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

describe("shutdown", () => {
  it("flushes the client without throwing", async () => {
    trackPublish(sampleMethod, "mthds-ai/contract-analysis");
    await shutdown();
    expect(mockShutdown).toHaveBeenCalled();
  });
});
