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

vi.mock("../../../src/installer/telemetry/posthog.js", () => ({
  trackPublish: vi.fn(),
  shutdown: vi.fn().mockResolvedValue(undefined),
}));

// The route is faked at the client's request function; reading its answers stays real.
vi.mock("../../../src/installer/registry/client.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../src/installer/registry/client.js")>();
  return { ...original, registerMethods: vi.fn(), resolveHubUrl: vi.fn() };
});

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
import { trackPublish, shutdown } from "../../../src/installer/telemetry/posthog.js";
import { registerMethods, resolveHubUrl } from "../../../src/installer/registry/client.js";
import type {
  MethodRegistration,
  RegistrationAnswer,
} from "../../../src/installer/registry/client.js";
import { agentSuccess, agentError } from "../../../src/agent/output.js";
import { agentPublish, LOCAL_PUBLISH_MESSAGE } from "../../../src/agent/commands/publish.js";
import type { ResolvedRepo } from "../../../src/package/manifest/types.js";

const mockedParseAddress = vi.mocked(parseAddress);
const mockedResolveFromGitHub = vi.mocked(resolveFromGitHub);
const mockedResolveFromLocal = vi.mocked(resolveFromLocal);
const mockedTrackPublish = vi.mocked(trackPublish);
const mockedRegisterMethods = vi.mocked(registerMethods);
const mockedResolveHubUrl = vi.mocked(resolveHubUrl);
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

function acceptedAnswer(name: string, address = "Mthds-AI/contract-analysis"): RegistrationAnswer {
  return {
    outcome: "registered",
    method: {
      address,
      name,
      version: "1.0.0",
      commit_sha: "8d39d1dca38a4de613c20e85fbaa05dd75024835",
      url: `https://mthds.sh/methods/${address}/${name}`,
    },
    validation: "queued",
  };
}

const refusedAnswer: RegistrationAnswer = {
  outcome: "refused",
  reason: "manifest_invalid",
  message: "methods/contract-analysis/METHODS.toml cannot be registered.",
  errors: ["[package.version] is required and must be a semantic version, such as 1.0.0."],
};

const unavailableAnswer: RegistrationAnswer = {
  outcome: "error",
  error: {
    code: "upstream_unavailable",
    message: "GitHub could not be read.",
    retryable: true,
  },
};

/** Make the route answer every method with `answer(name)`. */
function routeAnswers(answer: (name: string) => RegistrationAnswer): void {
  mockedRegisterMethods.mockImplementation(async (requests) =>
    requests.map(
      (request): MethodRegistration => ({ name: request.name, answer: answer(request.name) }),
    ),
  );
}

function givenGitHubRepo(resolved: ResolvedRepo = fakeResolved): void {
  mockedParseAddress.mockReturnValue({ org: "mthds-ai", repo: "contract-analysis", subpath: null });
  mockedResolveFromGitHub.mockResolvedValue(resolved);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedResolveHubUrl.mockReturnValue({ ok: true, url: "https://mthds.sh" });
  routeAnswers((name) => acceptedAnswer(name));
});

describe("agentPublish", () => {
  it("errors when both address and --local are provided", async () => {
    await expect(agentPublish("org/repo", { local: "/some/path" })).rejects.toThrow(
      AgentErrorThrow,
    );

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "client.argument_invalid",
        params: { argument: "--local", reason: "conflicts_with_address" },
        message: expect.stringContaining("Cannot use both"),
      }),
    );
  });

  it("errors when neither address nor --local is provided", async () => {
    await expect(agentPublish(undefined, {})).rejects.toThrow(AgentErrorThrow);

    expect(mockedAgentError).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "client.argument_invalid",
        params: { argument: "address", reason: "missing" },
        message: expect.stringContaining("Provide an address"),
      }),
    );
  });

  it("publishes through the registry route, one request per method, and reports its answers", async () => {
    givenGitHubRepo();

    await agentPublish("mthds-ai/contract-analysis", {});

    expect(mockedRegisterMethods).toHaveBeenCalledWith(
      [{ address: "mthds-ai/contract-analysis", name: "contract-analysis" }],
      expect.objectContaining({ hubUrl: "https://mthds.sh" }),
    );
    expect(mockedAgentSuccess).toHaveBeenCalledWith({
      success: true,
      published_methods: ["contract-analysis"],
      address: "mthds-ai/contract-analysis",
      skipped_methods: [],
      registrations: [{ name: "contract-analysis", ...acceptedAnswer("contract-analysis") }],
    });
  });

  it("counts a publish under the address mthds.sh lists the method under", async () => {
    givenGitHubRepo();

    await agentPublish("mthds-ai/contract-analysis", {});

    expect(mockedTrackPublish).toHaveBeenCalledWith(fakeMethod, "Mthds-AI/contract-analysis");
    expect(mockedShutdown).toHaveBeenCalled();
  });

  it("fails, method by method, when the route listed nothing", async () => {
    givenGitHubRepo();
    routeAnswers(() => refusedAnswer);

    await expect(agentPublish("mthds-ai/contract-analysis", {})).rejects.toThrow(AgentErrorThrow);

    const [problem, extras] = mockedAgentError.mock.calls[0]!;
    // Every method refused for its manifest: the package breaks a rule of mthds.sh.
    expect(problem).toMatchObject({
      code: "method.package_invalid",
      params: { reason: "manifest_invalid" },
      retry: "no",
    });
    expect(problem.message).toMatch(/^Nothing was published/);
    expect(problem.message).toContain("manifest_invalid");
    expect(problem.message).toContain("[package.version] is required");
    expect(extras).toMatchObject({
      skipped_methods: [],
      registrations: [{ name: "contract-analysis", ...refusedAnswer }],
    });
    expect(mockedTrackPublish).not.toHaveBeenCalled();
    expect(mockedAgentSuccess).not.toHaveBeenCalled();
  });

  it("says a failure is retryable when every method failed in a way a retry can fix", async () => {
    givenGitHubRepo();
    routeAnswers(() => unavailableAnswer);

    await expect(agentPublish("mthds-ai/contract-analysis", {})).rejects.toThrow(AgentErrorThrow);

    expect(mockedAgentError.mock.calls[0]![0]).toMatchObject({
      code: "runtime.unavailable",
      retry: "yes",
    });
  });

  it("names only the methods the route listed when some were refused", async () => {
    givenGitHubRepo({
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
    });
    routeAnswers((name) => (name === "other-method" ? refusedAnswer : acceptedAnswer(name)));

    await agentPublish("mthds-ai/contract-analysis", {});

    const envelope = mockedAgentSuccess.mock.calls[0]![0];
    expect(envelope.published_methods).toEqual(["contract-analysis"]);
    expect(
      (envelope.registrations as Array<{ name: string; outcome: string }>).map((r) => [
        r.name,
        r.outcome,
      ]),
    ).toEqual([
      ["contract-analysis", "registered"],
      ["other-method", "refused"],
    ]);
    expect(mockedTrackPublish).toHaveBeenCalledTimes(1);
  });

  it("refuses a private repository without asking the hub", async () => {
    givenGitHubRepo({ ...fakeResolved, isPublic: false });

    await expect(agentPublish("mthds-ai/contract-analysis", {})).rejects.toThrow(AgentErrorThrow);

    const [problem, extras] = mockedAgentError.mock.calls[0]!;
    expect(problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "address", reason: "private_repository" },
    });
    expect(problem.message).toContain("is a private repository");
    expect(extras).toMatchObject({ skipped_methods: [] });
    expect(mockedRegisterMethods).not.toHaveBeenCalled();
    expect(mockedTrackPublish).not.toHaveBeenCalled();
  });

  it("refuses a subdirectory address before reading the repository", async () => {
    mockedParseAddress.mockReturnValue({ org: "mthds-ai", repo: "tools", subpath: "sub/dir" });

    await expect(agentPublish("mthds-ai/tools/sub/dir", {})).rejects.toThrow(AgentErrorThrow);

    const [problem, extras] = mockedAgentError.mock.calls[0]!;
    expect(problem).toMatchObject({
      code: "client.argument_invalid",
      params: { argument: "address", reason: "subdirectory" },
    });
    expect(problem.message).toContain("names a subdirectory");
    expect(extras ?? {}).not.toHaveProperty("skipped_methods");
    expect(mockedResolveFromGitHub).not.toHaveBeenCalled();
  });

  it("refuses a hub override that is not a loopback origin", async () => {
    givenGitHubRepo();
    mockedResolveHubUrl.mockReturnValue({
      ok: false,
      message: "MTHDS_HUB_URL is set to something else.",
    });

    await expect(agentPublish("mthds-ai/contract-analysis", {})).rejects.toThrow(AgentErrorThrow);

    expect(mockedAgentError.mock.calls[0]![0]).toMatchObject({
      code: "client.not_configured",
      params: { setting: "MTHDS_HUB_URL" },
      message: "MTHDS_HUB_URL is set to something else.",
    });
    expect(mockedRegisterMethods).not.toHaveBeenCalled();
  });

  it("registers nothing from a local directory, and says so", async () => {
    mockedResolveFromLocal.mockResolvedValue({ ...fakeResolved, source: "local", isPublic: false });

    await agentPublish(undefined, { local: "/some/path" });

    expect(mockedRegisterMethods).not.toHaveBeenCalled();
    expect(mockedTrackPublish).not.toHaveBeenCalled();
    expect(mockedAgentSuccess).toHaveBeenCalledWith({
      success: true,
      published_methods: ["contract-analysis"],
      address: "mthds-ai/contract-analysis",
      skipped_methods: [],
      registrations: [],
      message: LOCAL_PUBLISH_MESSAGE,
    });
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
      expect.objectContaining({
        code: "method.not_found",
        params: { method_ref: "nonexistent" },
        message: expect.stringContaining('Method "nonexistent" not found'),
      }),
      expect.objectContaining({ skipped_methods: [] }),
    );
  });

  it("does not write any files or install runners", async () => {
    mockedParseAddress.mockReturnValue({ org: "org", repo: "repo", subpath: null });
    mockedResolveFromGitHub.mockResolvedValue(fakeResolved);

    await agentPublish("org/repo", {});

    // Only the route, the publish count and the envelope — no file system or runner calls
    expect(mockedRegisterMethods).toHaveBeenCalledTimes(1);
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
    mockedResolveFromLocal.mockResolvedValue({ ...partiallyResolved, source: "local" });

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
    mockedResolveFromLocal.mockResolvedValue({ ...fakeResolved, source: "local" });

    await agentPublish(undefined, { local: "/some/path" });

    const successCall = mockedAgentSuccess.mock.calls[0]![0];
    expect(successCall.skipped_methods).toEqual([]);
  });

  it("reports the refusals even under --method, since a skip is the repo's property", async () => {
    mockedResolveFromLocal.mockResolvedValue({ ...partiallyResolved, source: "local" });

    await agentPublish(undefined, { local: "/some/path", method: "contract-analysis" });

    expect(mockedAgentSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        published_methods: ["contract-analysis"],
        skipped_methods: [{ name: "legacy_tool", errors: [INCOMPATIBLE] }],
      }),
    );
  });

  it("gives the filter the refusal reason instead of calling the method missing", async () => {
    mockedResolveFromLocal.mockResolvedValue({ ...partiallyResolved, source: "local" });

    await expect(
      agentPublish(undefined, { local: "/some/path", method: "legacy_tool" }),
    ).rejects.toThrow(AgentErrorThrow);

    const [problem, extras] = mockedAgentError.mock.calls[0]!;
    // The publisher is the method's author: the step is theirs to take.
    expect(problem).toMatchObject({
      code: "method.invalid",
      next_step: { kind: "change_method" },
      errors: [{ code: "method.package_invalid", detail: `Method 'legacy_tool': ${INCOMPATIBLE}` }],
    });
    expect(problem.message).toContain('Method "legacy_tool" was found but skipped');
    expect(problem.message).toContain(INCOMPATIBLE);
    expect(problem.message).not.toContain("not found");
    expect(extras).toMatchObject({
      skipped_methods: [{ name: "legacy_tool", errors: [INCOMPATIBLE] }],
    });
  });

  it("says why when nothing survived, rather than only that nothing did", async () => {
    mockedResolveFromLocal.mockResolvedValue({
      ...partiallyResolved,
      source: "local",
      methods: [],
    });

    await expect(agentPublish(undefined, { local: "/some/path" })).rejects.toThrow(AgentErrorThrow);

    const [problem, extras] = mockedAgentError.mock.calls[0]!;
    expect(problem).toMatchObject({
      code: "method.invalid",
      next_step: { kind: "change_method" },
      message: "No valid methods to publish.",
      errors: [{ code: "method.package_invalid", detail: `Method 'legacy_tool': ${INCOMPATIBLE}` }],
    });
    expect(extras).toMatchObject({
      skipped_methods: [{ name: "legacy_tool", errors: [INCOMPATIBLE] }],
    });
  });
});
