import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Problem } from "../../../src/problems/types.js";

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("../../../src/installer/resolver/local.js", () => ({
  resolveFromLocal: vi.fn(),
}));

vi.mock("../../../src/installer/methods/install-flow.js", () => ({
  runInstallFlow: vi.fn(),
}));

vi.mock("../../../src/installer/telemetry/posthog.js", () => ({
  shutdown: vi.fn().mockResolvedValue(undefined),
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

import { resolveFromLocal } from "../../../src/installer/resolver/local.js";
import { runInstallFlow } from "../../../src/installer/methods/install-flow.js";
import { agentInstall } from "../../../src/agent/commands/install.js";
import { problemError } from "../../../src/problems/errors.js";
import type { ResolvedMethod, ResolvedRepo } from "../../../src/package/manifest/types.js";

const mockedResolveFromLocal = vi.mocked(resolveFromLocal);
const mockedRunInstallFlow = vi.mocked(runInstallFlow);

const resolved: ResolvedRepo = {
  methods: [
    {
      name: "legit",
      manifest: { package: { address: "github.com/org/repo" } },
    } as unknown as ResolvedMethod,
  ],
  skipped: [],
  source: "local",
  repoName: "org/repo",
  isPublic: false,
};

/** The problem `mthds-agent install --local … --location <location>` fails with when the install flow throws `err`. */
async function installFailure(err: unknown, location = "local"): Promise<Problem> {
  mockedRunInstallFlow.mockImplementation(() => {
    throw err;
  });
  const failure = await agentInstall(undefined, {
    local: "/methods/repo",
    location,
    noRunner: true,
  }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(failure).toBeInstanceOf(AgentErrorThrow);
  return (failure as AgentErrorThrow).problem;
}

// Only a failure of the file system that names the path it refused is a write that failed; any
// other failure of the install reads as the code that fits it, or keeps its own problem, and the
// install location, `local` or `global`, is never written as a path.
describe("mthds-agent install, when the install flow fails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedResolveFromLocal.mockReturnValue(resolved);
  });

  it("reads a file system failure naming its path as client.write_failed on that path", async () => {
    const err = Object.assign(new Error("EACCES: permission denied, mkdir '/x/.mthds/methods'"), {
      code: "EACCES",
      path: "/x/.mthds/methods",
    });
    expect(await installFailure(err)).toMatchObject({
      code: "client.write_failed",
      params: { path: "/x/.mthds/methods", reason: "eacces" },
    });
  });

  it.each([
    ["a failure of the install's telemetry", new Error("PostHog client exploded")],
    [
      "a system error naming no path",
      Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }),
    ],
    ["a thrown value that is no error", "boom"],
  ])("reads %s as runtime.unexpected, naming no path", async (_topic, err) => {
    for (const location of ["local", "global"]) {
      const problem = await installFailure(err, location);
      expect(problem.code).toBe("runtime.unexpected");
      expect(problem).not.toHaveProperty("params");
      expect(JSON.stringify(problem)).not.toContain(`'${location}'`);
    }
  });

  it("keeps the problem a failure carries, such as a tree path the writer refused", async () => {
    const refusal = problemError(
      "method.package_invalid",
      { reason: "invalid_tree_path", path: "../escape.mthds" },
      { message: 'Path traversal detected: "../escape.mthds" escapes install directory.' },
    );
    const problem = await installFailure(refusal);
    expect(problem).toEqual(refusal.problem);
  });
});
