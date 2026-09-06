import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("../../../src/installer/resolver/address.js", () => ({
  parseAddress: vi.fn(),
}));

vi.mock("../../../src/installer/resolver/github.js", () => ({
  resolveFromGitHub: vi.fn(),
}));

vi.mock("../../../src/installer/resolver/local.js", () => ({
  resolveFromLocal: vi.fn(),
}));

vi.mock("../../../src/installer/telemetry/posthog.js", () => ({
  trackPublish: vi.fn(),
  shutdown: vi.fn().mockResolvedValue(undefined),
}));

class AgentErrorThrow extends Error {
  constructor(
    public errorType: string,
    public extras?: Record<string, unknown>,
  ) {
    super(errorType);
  }
}

vi.mock("../../../src/agent/output.js", () => ({
  agentSuccess: vi.fn(),
  agentError: vi.fn((message: string, errorType: string, extras?: Record<string, unknown>) => {
    throw new AgentErrorThrow(errorType, { message, ...extras });
  }),
  AGENT_ERROR_DOMAINS: {
    ARGUMENT: "argument",
    CONFIG: "config",
    RUNNER: "runner",
    PIPELINE: "pipeline",
    VALIDATION: "validation",
    INSTALL: "install",
    IO: "io",
    BINARY: "binary",
  },
}));

import { parseAddress } from "../../../src/installer/resolver/address.js";
import { resolveFromGitHub } from "../../../src/installer/resolver/github.js";
import { resolveFromLocal } from "../../../src/installer/resolver/local.js";
import { trackPublish, shutdown } from "../../../src/installer/telemetry/posthog.js";
import { agentSuccess, agentError } from "../../../src/agent/output.js";
import { agentPublish } from "../../../src/agent/commands/publish.js";
import type { ResolvedRepo } from "../../../src/package/manifest/types.js";

const mockedParseAddress = vi.mocked(parseAddress);
const mockedResolveFromGitHub = vi.mocked(resolveFromGitHub);
const mockedResolveFromLocal = vi.mocked(resolveFromLocal);
const mockedTrackPublish = vi.mocked(trackPublish);
const mockedShutdown = vi.mocked(shutdown);
const mockedAgentSuccess = vi.mocked(agentSuccess);
const mockedAgentError = vi.mocked(agentError);

const fakeMethod = {
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
    exports: { pipes: { analyze: {} } },
  },
  rawManifest: "[package]\nname = 'contract-analysis'",
  files: [],
};

const fakeResolved: ResolvedRepo = {
  methods: [fakeMethod],
  skipped: [],
  source: "github",
  repoName: "mthds-ai/contract-analysis",
  isPublic: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agentPublish", () => {
  it("errors when both address and --local are provided", async () => {
    await expect(agentPublish("org/repo", { local: "/some/path" })).rejects.toThrow(
      AgentErrorThrow,
    );

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.stringContaining("Cannot use both"),
      "ArgumentError",
      expect.any(Object),
    );
  });

  it("errors when neither address nor --local is provided", async () => {
    await expect(agentPublish(undefined, {})).rejects.toThrow(AgentErrorThrow);

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.stringContaining("Provide an address"),
      "ArgumentError",
      expect.any(Object),
    );
  });

  it("publishes from GitHub and tracks telemetry for public repos", async () => {
    mockedParseAddress.mockReturnValue({
      org: "mthds-ai",
      repo: "contract-analysis",
      subpath: null,
    });
    mockedResolveFromGitHub.mockResolvedValue(fakeResolved);

    await agentPublish("mthds-ai/contract-analysis", {});

    expect(mockedTrackPublish).toHaveBeenCalledWith(
      expect.objectContaining({
        address: "mthds-ai/contract-analysis",
        name: "contract-analysis",
      }),
    );
    expect(mockedShutdown).toHaveBeenCalled();
    expect(mockedAgentSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        published_methods: ["contract-analysis"],
        address: "mthds-ai/contract-analysis",
      }),
    );
  });

  it("does not track telemetry for private repos", async () => {
    mockedParseAddress.mockReturnValue({ org: "org", repo: "repo", subpath: null });
    mockedResolveFromGitHub.mockResolvedValue({
      ...fakeResolved,
      isPublic: false,
    });

    await agentPublish("org/repo", {});

    expect(mockedTrackPublish).not.toHaveBeenCalled();
    expect(mockedAgentSuccess).toHaveBeenCalled();
  });

  it("does not track telemetry for local sources", async () => {
    mockedResolveFromLocal.mockReturnValue({
      ...fakeResolved,
      source: "local",
    });

    await agentPublish(undefined, { local: "/some/path" });

    expect(mockedTrackPublish).not.toHaveBeenCalled();
    expect(mockedAgentSuccess).toHaveBeenCalled();
  });

  it("does not include share_urls in output", async () => {
    mockedParseAddress.mockReturnValue({
      org: "mthds-ai",
      repo: "contract-analysis",
      subpath: null,
    });
    mockedResolveFromGitHub.mockResolvedValue(fakeResolved);

    await agentPublish("mthds-ai/contract-analysis", {});

    const successCall = mockedAgentSuccess.mock.calls[0]![0];
    expect(successCall).not.toHaveProperty("share_urls");
  });

  it("filters by --method name", async () => {
    const multiResolved: ResolvedRepo = {
      ...fakeResolved,
      methods: [
        fakeMethod,
        {
          ...fakeMethod,
          name: "other-method",
          manifest: {
            ...fakeMethod.manifest,
            package: { ...fakeMethod.manifest.package, name: "other-method" },
          },
        },
      ],
    };
    mockedParseAddress.mockReturnValue({
      org: "mthds-ai",
      repo: "contract-analysis",
      subpath: null,
    });
    mockedResolveFromGitHub.mockResolvedValue(multiResolved);

    await agentPublish("mthds-ai/contract-analysis", { method: "other-method" });

    expect(mockedAgentSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        published_methods: ["other-method"],
      }),
    );
  });

  it("errors when --method filter does not match", async () => {
    mockedParseAddress.mockReturnValue({
      org: "mthds-ai",
      repo: "contract-analysis",
      subpath: null,
    });
    mockedResolveFromGitHub.mockResolvedValue(fakeResolved);

    await expect(
      agentPublish("mthds-ai/contract-analysis", { method: "nonexistent" }),
    ).rejects.toThrow(AgentErrorThrow);

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.stringContaining('Method "nonexistent" not found'),
      "PublishError",
      expect.any(Object),
    );
  });

  it("does not write any files or install runners", async () => {
    mockedParseAddress.mockReturnValue({ org: "org", repo: "repo", subpath: null });
    mockedResolveFromGitHub.mockResolvedValue(fakeResolved);

    await agentPublish("org/repo", {});

    // Only telemetry + success — no file system or runner calls
    expect(mockedTrackPublish).toHaveBeenCalledTimes(1);
    expect(mockedShutdown).toHaveBeenCalledTimes(1);
    expect(mockedAgentSuccess).toHaveBeenCalledTimes(1);
  });
});

// ── The skip list reaches the envelope ───────────────────────────────
//
// Before this, `resolved.skipped` was never read by any agent command, so an
// agent could not tell a full publish from a half one: the envelope said
// success and listed the survivors. Harmless while a skip meant a broken
// METHODS.toml; not harmless once an `mthds_version` this build does not
// satisfy became a refusal, since that manifest is well-formed.

const INCOMPATIBLE =
  '[package.mthds_version] "^1.0.0" is not satisfied by the MTHDS standard version this implementation implements (2.0.0).';

const partiallyResolved: ResolvedRepo = {
  ...fakeResolved,
  skipped: [{ dirName: "legacy_tool", errors: [INCOMPATIBLE] }],
};

describe("agentPublish and the refused methods", () => {
  it("reports the refused methods beside the published ones", async () => {
    mockedResolveFromLocal.mockReturnValue({ ...partiallyResolved, source: "local" });

    await agentPublish(undefined, { local: "/some/path" });

    expect(mockedAgentSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        published_methods: ["contract-analysis"],
        skipped_methods: [{ name: "legacy_tool", errors: [INCOMPATIBLE] }],
      }),
    );
  });

  it("carries the field as an empty array when nothing was refused", async () => {
    mockedResolveFromLocal.mockReturnValue({ ...fakeResolved, source: "local" });

    await agentPublish(undefined, { local: "/some/path" });

    const successCall = mockedAgentSuccess.mock.calls[0]![0];
    expect(successCall.skipped_methods).toEqual([]);
  });

  it("reports the refusals even under --method, since a skip is the repo's property", async () => {
    mockedResolveFromLocal.mockReturnValue({ ...partiallyResolved, source: "local" });

    await agentPublish(undefined, { local: "/some/path", method: "contract-analysis" });

    expect(mockedAgentSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        published_methods: ["contract-analysis"],
        skipped_methods: [{ name: "legacy_tool", errors: [INCOMPATIBLE] }],
      }),
    );
  });

  it("gives the filter the refusal reason instead of calling the method missing", async () => {
    mockedResolveFromLocal.mockReturnValue({ ...partiallyResolved, source: "local" });

    await expect(
      agentPublish(undefined, { local: "/some/path", method: "legacy_tool" }),
    ).rejects.toThrow(AgentErrorThrow);

    const [message, , extras] = mockedAgentError.mock.calls[0]!;
    expect(message).toContain('Method "legacy_tool" was found but skipped');
    expect(message).toContain(INCOMPATIBLE);
    expect(message).not.toContain("not found");
    expect(extras).toMatchObject({
      skipped_methods: [{ name: "legacy_tool", errors: [INCOMPATIBLE] }],
    });
  });

  it("says why when nothing survived, rather than only that nothing did", async () => {
    mockedResolveFromLocal.mockReturnValue({
      ...partiallyResolved,
      source: "local",
      methods: [],
    });

    await expect(agentPublish(undefined, { local: "/some/path" })).rejects.toThrow(AgentErrorThrow);

    const [message, , extras] = mockedAgentError.mock.calls[0]!;
    expect(message).toBe("No valid methods to publish.");
    expect(extras).toMatchObject({
      skipped_methods: [{ name: "legacy_tool", errors: [INCOMPATIBLE] }],
    });
  });
});
