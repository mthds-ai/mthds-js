import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Problem } from "../../../src/problems/types.js";

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
    public problem: Problem,
    public extras?: Record<string, unknown>,
  ) {
    super(problem.code);
  }
}

// The problems are the real ones, built from the registry; only their writing is captured.
vi.mock("../../../src/agent/output.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/agent/output.js")>()),
  agentSuccess: vi.fn(),
  agentError: vi.fn((problem: Problem, extras?: Record<string, unknown>) => {
    throw new AgentErrorThrow(problem, extras);
  }),
}));

import { parseAddress } from "../../../src/installer/resolver/address.js";
import { resolveFromGitHub } from "../../../src/installer/resolver/github.js";
import { resolveFromLocal } from "../../../src/installer/resolver/local.js";
import { buildShareUrls } from "../../../src/cli/commands/share.js";
import { agentSuccess, agentError } from "../../../src/agent/output.js";
import { agentShare } from "../../../src/agent/commands/share.js";
import type { ResolvedRepo } from "../../../src/package/manifest/types.js";
import { MethodResolveError } from "../../../src/installer/resolver/exceptions.js";

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
  repoName: "mthds-ai/contract-analysis",
  isPublic: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("agentShare", () => {
  it("errors when both address and --local are provided", async () => {
    await expect(agentShare("org/repo", { local: "/some/path" })).rejects.toThrow(AgentErrorThrow);

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "client.argument_invalid",
        params: { argument: "--local", reason: "conflicts_with_address" },
        message: expect.stringContaining("Cannot use both"),
      }),
    );
  });

  it("errors when neither address nor --local is provided", async () => {
    await expect(agentShare(undefined, {})).rejects.toThrow(AgentErrorThrow);

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "client.argument_invalid",
        params: { argument: "address", reason: "missing" },
        message: expect.stringContaining("Provide an address"),
      }),
    );
  });

  it("returns share URLs from GitHub address", async () => {
    mockedParseAddress.mockReturnValue({
      org: "mthds-ai",
      repo: "contract-analysis",
      subpath: null,
    });
    mockedResolveFromGitHub.mockResolvedValue(fakeResolved);

    await agentShare("mthds-ai/contract-analysis", {});

    expect(mockedBuildShareUrls).toHaveBeenCalledWith(
      expect.objectContaining({
        methods: [{ displayName: "Contract Analysis", description: "Analyze contracts" }],
        address: "mthds-ai/contract-analysis",
      }),
    );
    const successCall = mockedAgentSuccess.mock.calls[0]![0];
    expect(successCall.share_urls).toHaveProperty("x");
    expect(successCall.share_urls).toHaveProperty("reddit");
    expect(successCall.share_urls).toHaveProperty("linkedin");
    expect(successCall.methods).toEqual(["contract-analysis"]);
  });

  it("returns share URLs from local directory", async () => {
    mockedResolveFromLocal.mockResolvedValue({
      ...fakeResolved,
      source: "local",
    });

    await agentShare(undefined, { local: "/some/path" });

    expect(mockedBuildShareUrls).toHaveBeenCalled();
    expect(mockedAgentSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        share_urls: expect.any(Object),
      }),
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
    mockedParseAddress.mockReturnValue({
      org: "mthds-ai",
      repo: "contract-analysis",
      subpath: null,
    });
    mockedResolveFromGitHub.mockResolvedValue(multiResolved);

    await agentShare("mthds-ai/contract-analysis", { method: "other-method" });

    expect(mockedAgentSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        methods: ["other-method"],
      }),
    );
  });

  it.each([
    ["not_found", "method.not_found", "no"],
    ["fetch_failed", "method.fetch_failed", "yes"],
  ] as const)("reads a GitHub resolve that failed as %s as %s", async (reason, code, retry) => {
    mockedParseAddress.mockReturnValue({ org: "mthds-ai", repo: "tools", subpath: null });
    mockedResolveFromGitHub.mockRejectedValue(new MethodResolveError("GitHub said no.", reason));

    await expect(agentShare("mthds-ai/tools", {})).rejects.toThrow(AgentErrorThrow);

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.objectContaining({
        code,
        retry,
        params: { method_ref: "mthds-ai/tools" },
        message: "Failed to resolve methods: GitHub said no.",
      }),
    );
  });

  it("reads a local directory the system refused as client.file_unreadable", async () => {
    mockedResolveFromLocal.mockImplementation(() => {
      throw new MethodResolveError("Cannot read /srv/methods: denied", "unreadable", {
        path: "/srv/methods",
        fsCode: "EACCES",
      });
    });

    await expect(agentShare(undefined, { local: "/srv" })).rejects.toThrow(AgentErrorThrow);

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "client.file_unreadable",
        params: { path: "/srv/methods", reason: "eacces" },
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
      agentShare("mthds-ai/contract-analysis", { method: "nonexistent" }),
    ).rejects.toThrow(AgentErrorThrow);

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "method.not_found",
        params: { method_ref: "nonexistent" },
        message: expect.stringContaining('Method "nonexistent" not found'),
      }),
      expect.objectContaining({ skipped_methods: [] }),
    );
  });

  it("filters share_urls to requested platforms only", async () => {
    mockedParseAddress.mockReturnValue({
      org: "mthds-ai",
      repo: "contract-analysis",
      subpath: null,
    });
    mockedResolveFromGitHub.mockResolvedValue(fakeResolved);

    await agentShare("mthds-ai/contract-analysis", { platform: ["x", "linkedin"] });

    const successCall = mockedAgentSuccess.mock.calls[0]![0];
    const urls = successCall.share_urls as Record<string, string>;
    expect(Object.keys(urls)).toEqual(["x", "linkedin"]);
    expect(urls).not.toHaveProperty("reddit");
  });

  it("returns all platforms when no --platform is specified", async () => {
    mockedParseAddress.mockReturnValue({
      org: "mthds-ai",
      repo: "contract-analysis",
      subpath: null,
    });
    mockedResolveFromGitHub.mockResolvedValue(fakeResolved);

    await agentShare("mthds-ai/contract-analysis", {});

    const successCall = mockedAgentSuccess.mock.calls[0]![0];
    const urls = successCall.share_urls as Record<string, string>;
    expect(Object.keys(urls).sort()).toEqual(["linkedin", "reddit", "x"]);
  });

  it("errors on invalid platform name", async () => {
    mockedParseAddress.mockReturnValue({
      org: "mthds-ai",
      repo: "contract-analysis",
      subpath: null,
    });
    mockedResolveFromGitHub.mockResolvedValue(fakeResolved);

    await expect(
      agentShare("mthds-ai/contract-analysis", { platform: ["twitter" as never] }),
    ).rejects.toThrow(AgentErrorThrow);

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "client.argument_invalid",
        params: { argument: "--platform", reason: "unknown_value" },
        message: expect.stringContaining('Invalid platform "twitter"'),
      }),
    );
    // Raised before the repository is read: an envelope that precedes the read
    // is the one kind that carries no skip list, and a misspelled flag is
    // knowable without fetching anything.
    expect(mockedResolveFromGitHub).not.toHaveBeenCalled();
  });
});
