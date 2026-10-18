import { beforeEach, describe, expect, it, vi } from "vitest";

// `mthds publish` lists methods on mthds.sh through its registry route, one request per method,
// and reports what the route answered for each: it says "Published" only for what was listed, and
// exits non-zero when any selected method was not. Telemetry plays no part in it.

// ── Mocks ────────────────────────────────────────────────────────────

const spinner = { start: vi.fn(), stop: vi.fn(), message: vi.fn() };

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  spinner: () => spinner,
  multiselect: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  cancel: vi.fn(),
  log: { info: vi.fn(), success: vi.fn(), warning: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../src/cli/commands/index.js", () => ({ printLogo: vi.fn() }));

vi.mock("../../../src/installer/resolver/address.js", () => ({ parseAddress: vi.fn() }));
vi.mock("../../../src/installer/resolver/github.js", () => ({
  resolveFromGitHub: vi.fn(),
  repositoryVisibility: vi.fn(),
}));
vi.mock("../../../src/installer/resolver/local.js", () => ({ resolveFromLocal: vi.fn() }));

vi.mock("../../../src/installer/telemetry/posthog.js", () => ({
  trackPublish: vi.fn(),
  trackLocalPublish: vi.fn(),
  shutdown: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../src/installer/registry/client.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../src/installer/registry/client.js")>();
  return { ...original, registerMethods: vi.fn(), resolveHubUrl: vi.fn() };
});

import * as p from "@clack/prompts";
import { parseAddress } from "../../../src/installer/resolver/address.js";
import { repositoryVisibility, resolveFromGitHub } from "../../../src/installer/resolver/github.js";
import { resolveFromLocal } from "../../../src/installer/resolver/local.js";
import { trackLocalPublish, trackPublish } from "../../../src/installer/telemetry/posthog.js";
import { registerMethods, resolveHubUrl } from "../../../src/installer/registry/client.js";
import type {
  MethodRegistration,
  RegistrationAnswer,
} from "../../../src/installer/registry/client.js";
import { publishMethod } from "../../../src/cli/commands/publish.js";
import type { ResolvedMethod, ResolvedRepo } from "../../../src/package/manifest/types.js";

const mockedRegisterMethods = vi.mocked(registerMethods);

const method: ResolvedMethod = {
  name: "contract_analysis",
  manifest: {
    package: {
      address: "github.com/mthds-ai/contract-analysis",
      name: "contract_analysis",
      version: "1.0.0",
      description: "Analyze contracts",
    },
  },
  rawManifest: "[package]\nname = 'contract_analysis'",
  files: [],
};

const publicRepo: ResolvedRepo = {
  methods: [method],
  skipped: [],
  source: "github",
  repoName: "mthds-ai/contract-analysis",
  isPublic: true,
};

function accepted(
  version = "1.0.0",
  validation: "queued" | "unavailable" = "queued",
): RegistrationAnswer {
  return {
    outcome: "registered",
    method: {
      address: "MTHDS-AI/contract-analysis",
      name: "contract_analysis",
      version,
      commit_sha: "8d39d1dca38a4de613c20e85fbaa05dd75024835",
      url: "https://mthds.sh/methods/MTHDS-AI/contract-analysis/contract_analysis",
    },
    validation,
  };
}

function routeAnswers(answer: RegistrationAnswer): void {
  mockedRegisterMethods.mockImplementation(async (requests) =>
    requests.map((request): MethodRegistration => ({ name: request.name, answer })),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(parseAddress).mockReturnValue({
    org: "mthds-ai",
    repo: "contract-analysis",
    subpath: null,
  });
  vi.mocked(resolveFromGitHub).mockResolvedValue(publicRepo);
  vi.mocked(repositoryVisibility).mockResolvedValue("public");
  vi.mocked(resolveHubUrl).mockReturnValue({ ok: true, url: "https://mthds.sh" });
  routeAnswers(accepted());
  // A failure ends in process.exit(1); throw a sentinel so the test can catch it.
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("__exit__");
  }) as never);
});

describe("publishMethod", () => {
  it("publishes through the registry route and reports the method's page", async () => {
    await publishMethod({ address: "mthds-ai/contract-analysis" });

    expect(mockedRegisterMethods).toHaveBeenCalledWith(
      [{ address: "mthds-ai/contract-analysis", name: "contract_analysis" }],
      expect.objectContaining({ hubUrl: "https://mthds.sh" }),
    );
    expect(p.log.success).toHaveBeenCalledWith(
      expect.stringContaining(
        "https://mthds.sh/methods/MTHDS-AI/contract-analysis/contract_analysis",
      ),
    );
    expect(p.log.success).toHaveBeenCalledWith("Published 1 method to mthds.sh");
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("counts the publish under the address mthds.sh lists", async () => {
    await publishMethod({ address: "mthds-ai/contract-analysis" });

    expect(trackPublish).toHaveBeenCalledWith(method, "MTHDS-AI/contract-analysis");
  });

  it("shows a refusal and exits non-zero instead of claiming a publish", async () => {
    routeAnswers({
      outcome: "refused",
      reason: "method_not_found",
      message: "The default branch has no methods/contract_analysis/METHODS.toml.",
      errors: [],
    });

    await expect(publishMethod({ address: "mthds-ai/contract-analysis" })).rejects.toThrow(
      "__exit__",
    );

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("method_not_found"));
    expect(p.log.error).toHaveBeenCalledWith("Nothing was published to mthds.sh.");
    expect(p.log.success).not.toHaveBeenCalledWith(expect.stringContaining("Published"));
    expect(trackPublish).not.toHaveBeenCalled();
  });

  it("refuses a private repository before asking the hub", async () => {
    vi.mocked(resolveFromGitHub).mockResolvedValue({ ...publicRepo, isPublic: false });

    await expect(publishMethod({ address: "mthds-ai/contract-analysis" })).rejects.toThrow(
      "__exit__",
    );

    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("is a private repository"));
    expect(mockedRegisterMethods).not.toHaveBeenCalled();
  });

  it("refuses a subdirectory address before reading the repository", async () => {
    vi.mocked(parseAddress).mockReturnValue({ org: "mthds-ai", repo: "tools", subpath: "sub" });

    await expect(publishMethod({ address: "mthds-ai/tools/sub" })).rejects.toThrow("__exit__");

    expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("names a subdirectory"));
    expect(resolveFromGitHub).not.toHaveBeenCalled();
  });

  it("publishes a local directory by each manifest's address, and points out an unpushed version", async () => {
    vi.mocked(resolveFromLocal).mockResolvedValue({
      ...publicRepo,
      source: "local",
      isPublic: false,
      methods: [
        {
          ...method,
          manifest: { package: { ...method.manifest.package, version: "1.1.0" } },
        },
      ],
    });
    routeAnswers(accepted("1.0.0", "unavailable"));

    await publishMethod({ dir: "/some/path" });

    expect(mockedRegisterMethods).toHaveBeenCalledWith(
      [{ address: "github.com/mthds-ai/contract-analysis", name: "contract_analysis" }],
      expect.anything(),
    );
    const report = String(
      vi
        .mocked(p.log.success)
        .mock.calls.find((call) => String(call[0]).includes("mthds.sh at"))![0],
    );
    expect(report).toContain("Your local copy is version 1.1.0");
    expect(report).toContain("validation badge will not refresh yet");
  });

  describe("from a local directory, before any request", () => {
    async function localMethodAt(address: string): Promise<void> {
      const actual = await vi.importActual<
        typeof import("../../../src/installer/resolver/address.js")
      >("../../../src/installer/resolver/address.js");
      vi.mocked(parseAddress).mockImplementation(actual.parseAddress);
      vi.mocked(resolveFromLocal).mockResolvedValue({
        ...publicRepo,
        source: "local",
        isPublic: false,
        methods: [{ ...method, manifest: { package: { ...method.manifest.package, address } } }],
      });
    }

    it("asks GitHub whether the manifest's repository is public, then publishes", async () => {
      await localMethodAt("github.com/mthds-ai/contract-analysis");
      await publishMethod({ dir: "/some/path" });
      expect(repositoryVisibility).toHaveBeenCalledWith("mthds-ai", "contract-analysis");
      expect(mockedRegisterMethods).toHaveBeenCalled();
    });

    it("refuses a private repository without sending its name to the hub", async () => {
      await localMethodAt("github.com/acme/secret-plans");
      vi.mocked(repositoryVisibility).mockResolvedValue("private");
      await expect(publishMethod({ dir: "/some/path" })).rejects.toThrow("__exit__");
      expect(p.log.error).toHaveBeenCalledWith(
        expect.stringContaining("acme/secret-plans is a private repository"),
      );
      expect(mockedRegisterMethods).not.toHaveBeenCalled();
    });

    it("refuses a repository GitHub does not show, which a private one can be", async () => {
      await localMethodAt("github.com/acme/secret-plans");
      vi.mocked(repositoryVisibility).mockResolvedValue("not_found");
      await expect(publishMethod({ dir: "/some/path" })).rejects.toThrow("__exit__");
      expect(p.log.error).toHaveBeenCalledWith(
        expect.stringContaining("GitHub has no public repository acme/secret-plans"),
      );
      expect(mockedRegisterMethods).not.toHaveBeenCalled();
    });

    it("refuses when GitHub cannot say whether the repository is public", async () => {
      await localMethodAt("github.com/acme/secret-plans");
      vi.mocked(repositoryVisibility).mockRejectedValue(new Error("network down"));
      await expect(publishMethod({ dir: "/some/path" })).rejects.toThrow("__exit__");
      expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("could not check"));
      expect(mockedRegisterMethods).not.toHaveBeenCalled();
    });

    it("refuses an address naming a subdirectory without asking GitHub", async () => {
      await localMethodAt("github.com/acme/tools/sub/dir");
      await expect(publishMethod({ dir: "/some/path" })).rejects.toThrow("__exit__");
      expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("names a subdirectory"));
      expect(repositoryVisibility).not.toHaveBeenCalled();
      expect(mockedRegisterMethods).not.toHaveBeenCalled();
    });

    it("refuses an address outside GitHub without asking anyone", async () => {
      await localMethodAt("gitlab.example.com/acme/tools");
      await expect(publishMethod({ dir: "/some/path" })).rejects.toThrow("__exit__");
      expect(p.log.error).toHaveBeenCalledWith(expect.stringContaining("is not on GitHub"));
      expect(repositoryVisibility).not.toHaveBeenCalled();
      expect(mockedRegisterMethods).not.toHaveBeenCalled();
    });
  });

  it("counts a local publish with what the hub read, never the local manifest's fields", async () => {
    // The local manifest holds edits never pushed; the public one, at the commit the hub accepted,
    // is version 1.0.0.
    const localEdits = {
      ...method,
      manifest: {
        package: {
          ...method.manifest.package,
          version: "2.0.0-draft",
          description: "Confidential: the acquisition scoring rules",
          authors: ["Unannounced Partner"],
          main_pipe: "secret_pipe",
        },
        exports: { secret: { pipes: ["secret_pipe"] } },
      },
    };
    vi.mocked(resolveFromLocal).mockResolvedValue({
      ...publicRepo,
      source: "local",
      isPublic: false,
      methods: [localEdits],
    });
    const answer = accepted("1.0.0");
    routeAnswers(answer);

    await publishMethod({ dir: "/some/path" });

    expect(trackPublish).not.toHaveBeenCalled();
    expect(trackLocalPublish).toHaveBeenCalledWith(
      answer.outcome === "registered" ? answer.method : undefined,
    );
    const sent = JSON.stringify(vi.mocked(trackLocalPublish).mock.calls);
    for (const secret of ["2.0.0-draft", "Confidential", "Unannounced Partner", "secret_pipe"]) {
      expect(sent).not.toContain(secret);
    }
  });
});
