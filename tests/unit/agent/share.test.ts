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

vi.mock("../../../src/cli/commands/share.js", () => ({
  buildShareUrls: vi.fn().mockReturnValue({
    x: "https://twitter.com/intent/tweet?text=test",
    reddit: "https://old.reddit.com/submit?type=TEXT&title=test&text=test",
    linkedin: "https://www.linkedin.com/feed/?shareActive=true&text=test",
  }),
}));

class AgentErrorThrow extends Error {
  constructor(
    public errorType: string,
    public extras?: Record<string, unknown>
  ) {
    super(errorType);
  }
}

vi.mock("../../../src/agent/output.js", () => ({
  agentSuccess: vi.fn(),
  agentError: vi.fn(
    (message: string, errorType: string, extras?: Record<string, unknown>) => {
      throw new AgentErrorThrow(errorType, { message, ...extras });
    }
  ),
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
import { buildShareUrls } from "../../../src/cli/commands/share.js";
import { agentSuccess, agentError } from "../../../src/agent/output.js";
import { agentShare } from "../../../src/agent/commands/share.js";
import type { ResolvedRepo } from "../../../src/package/manifest/types.js";

const mockedParseAddress = vi.mocked(parseAddress);
const mockedResolveFromGitHub = vi.mocked(resolveFromGitHub);
const mockedResolveFromLocal = vi.mocked(resolveFromLocal);
const mockedBuildShareUrls = vi.mocked(buildShareUrls);
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
  isPublic: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agentShare", () => {
  it("errors when both address and --local are provided", async () => {
    await expect(
      agentShare("org/repo", { local: "/some/path" })
    ).rejects.toThrow(AgentErrorThrow);

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.stringContaining("Cannot use both"),
      "ArgumentError",
      expect.any(Object)
    );
  });

  it("errors when neither address nor --local is provided", async () => {
    await expect(
      agentShare(undefined, {})
    ).rejects.toThrow(AgentErrorThrow);

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.stringContaining("Provide an address"),
      "ArgumentError",
      expect.any(Object)
    );
  });

  it("returns share URLs from GitHub address", async () => {
    mockedParseAddress.mockReturnValue({ org: "mthds-ai", repo: "contract-analysis", subpath: null });
    mockedResolveFromGitHub.mockResolvedValue(fakeResolved);

    await agentShare("mthds-ai/contract-analysis", {});

    expect(mockedBuildShareUrls).toHaveBeenCalledWith(
      expect.objectContaining({
        methods: [{ displayName: "Contract Analysis", description: "Analyze contracts" }],
        address: "mthds-ai/contract-analysis",
      })
    );
    const successCall = mockedAgentSuccess.mock.calls[0]![0];
    expect(successCall.share_urls).toHaveProperty("x");
    expect(successCall.share_urls).toHaveProperty("reddit");
    expect(successCall.share_urls).toHaveProperty("linkedin");
    expect(successCall.methods).toEqual(["contract-analysis"]);
  });

  it("returns share URLs from local directory", async () => {
    mockedResolveFromLocal.mockReturnValue({
      ...fakeResolved,
      source: "local",
    });

    await agentShare(undefined, { local: "/some/path" });

    expect(mockedBuildShareUrls).toHaveBeenCalled();
    expect(mockedAgentSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        share_urls: expect.any(Object),
      })
    );
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
    mockedParseAddress.mockReturnValue({ org: "mthds-ai", repo: "contract-analysis", subpath: null });
    mockedResolveFromGitHub.mockResolvedValue(multiResolved);

    await agentShare("mthds-ai/contract-analysis", { method: "other-method" });

    expect(mockedAgentSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        methods: ["other-method"],
      })
    );
  });

  it("errors when --method filter does not match", async () => {
    mockedParseAddress.mockReturnValue({ org: "mthds-ai", repo: "contract-analysis", subpath: null });
    mockedResolveFromGitHub.mockResolvedValue(fakeResolved);

    await expect(
      agentShare("mthds-ai/contract-analysis", { method: "nonexistent" })
    ).rejects.toThrow(AgentErrorThrow);

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.stringContaining('Method "nonexistent" not found'),
      "ShareError",
      expect.any(Object)
    );
  });

  it("filters share_urls to requested platforms only", async () => {
    mockedParseAddress.mockReturnValue({ org: "mthds-ai", repo: "contract-analysis", subpath: null });
    mockedResolveFromGitHub.mockResolvedValue(fakeResolved);

    await agentShare("mthds-ai/contract-analysis", { platform: ["x", "linkedin"] });

    const successCall = mockedAgentSuccess.mock.calls[0]![0];
    const urls = successCall.share_urls as Record<string, string>;
    expect(Object.keys(urls)).toEqual(["x", "linkedin"]);
    expect(urls).not.toHaveProperty("reddit");
  });

  it("returns all platforms when no --platform is specified", async () => {
    mockedParseAddress.mockReturnValue({ org: "mthds-ai", repo: "contract-analysis", subpath: null });
    mockedResolveFromGitHub.mockResolvedValue(fakeResolved);

    await agentShare("mthds-ai/contract-analysis", {});

    const successCall = mockedAgentSuccess.mock.calls[0]![0];
    const urls = successCall.share_urls as Record<string, string>;
    expect(Object.keys(urls).sort()).toEqual(["linkedin", "reddit", "x"]);
  });

  it("errors on invalid platform name", async () => {
    mockedParseAddress.mockReturnValue({ org: "mthds-ai", repo: "contract-analysis", subpath: null });
    mockedResolveFromGitHub.mockResolvedValue(fakeResolved);

    await expect(
      agentShare("mthds-ai/contract-analysis", { platform: ["twitter" as never] })
    ).rejects.toThrow(AgentErrorThrow);

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.stringContaining('Invalid platform "twitter"'),
      "ArgumentError",
      expect.any(Object)
    );
  });
});
