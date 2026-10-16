import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Why a GitHub resolve failed, as `MethodResolveError.reason` says it: nothing there, a failure a
// later attempt may get past, or a refused token. GitHub is a stub here: `gh` is absent and
// `fetch` answers what each test routes.

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(() => {
    throw new Error("gh: not found");
  }),
}));

import { execFile, execFileSync } from "node:child_process";
import { resolveFromGitHub } from "../../../../src/installer/resolver/github.js";
import { MethodResolveError } from "../../../../src/installer/resolver/exceptions.js";

const fetchStub = vi.fn();
const PARSED = { org: "acme", repo: "tools", subpath: null } as const;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Answer each GitHub API path by the first route whose suffix it ends with. */
function route(routes: Array<[string, () => Response | Promise<Response>]>): void {
  fetchStub.mockImplementation(async (url: string) => {
    const match = routes.find(([suffix]) => url.endsWith(suffix));
    if (match === undefined) throw new Error(`No route for ${url}`);
    return match[1]();
  });
}

async function failure(): Promise<MethodResolveError> {
  const err = await resolveFromGitHub(PARSED).then(
    () => expect.fail("expected the resolve to fail"),
    (caught: unknown) => caught,
  );
  expect(err).toBeInstanceOf(MethodResolveError);
  return err as MethodResolveError;
}

beforeEach(() => {
  fetchStub.mockReset();
  vi.stubGlobal("fetch", fetchStub);
  vi.stubEnv("GITHUB_TOKEN", undefined);
});

afterEach(() => {
  vi.mocked(execFile).mockReset();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("resolveFromGitHub failures", () => {
  it("reads a repository GitHub does not know as not_found", async () => {
    route([["repos/acme/tools", () => json(404, { message: "Not Found" })]]);
    const err = await failure();
    expect(err.reason).toBe("not_found");
    expect(err.message).toContain('Repository "acme/tools" not found on GitHub');
  });

  it.each([
    ["a rate limit", 403],
    ["too many requests", 429],
    ["a server error", 502],
  ])("reads %s on the repository as fetch_failed", async (_topic, status) => {
    route([["repos/acme/tools", () => json(status, { message: "nope" })]]);
    const err = await failure();
    expect(err.reason).toBe("fetch_failed");
    expect(err.message).toContain("Could not connect to GitHub");
  });

  it("reads GitHub unreachable as fetch_failed", async () => {
    fetchStub.mockRejectedValue(new TypeError("fetch failed"));
    expect((await failure()).reason).toBe("fetch_failed");
  });

  it("reads a body that is not JSON as fetch_failed", async () => {
    route([["repos/acme/tools", () => new Response("<html>oops</html>", { status: 200 })]]);
    expect((await failure()).reason).toBe("fetch_failed");
  });

  it("reads a refused token as not_configured naming GITHUB_TOKEN", async () => {
    vi.stubEnv("GITHUB_TOKEN", "test-token");
    route([["repos/acme/tools", () => json(401, { message: "Bad credentials" })]]);
    const err = await failure();
    expect(err.reason).toBe("not_configured");
    expect(err.setting).toBe("GITHUB_TOKEN");
  });

  it("reads credentials the gh CLI holds and GitHub refuses as not_configured naming GITHUB_TOKEN", async () => {
    // `gh auth status` succeeds, so the resolve asks GitHub through `gh api`, which fails.
    vi.mocked(execFileSync).mockImplementationOnce(() => "");
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const callback = args[args.length - 1] as (err: Error) => void;
      callback(Object.assign(new Error("exit 1"), { stderr: "gh: Bad credentials (HTTP 401)\n" }));
    }) as unknown as typeof execFile);
    const err = await failure();
    expect(err.reason).toBe("not_configured");
    expect(err.setting).toBe("GITHUB_TOKEN");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("reads a missing methods/ folder as not_found, and a failure listing it as fetch_failed", async () => {
    route([
      ["repos/acme/tools", () => json(200, { private: false })],
      ["contents/methods", () => json(404, { message: "Not Found" })],
    ]);
    expect((await failure()).reason).toBe("not_found");
    route([
      ["repos/acme/tools", () => json(200, { private: false })],
      ["contents/methods", () => json(503, { message: "unavailable" })],
    ]);
    expect((await failure()).reason).toBe("fetch_failed");
  });

  it("fails the resolve when GitHub fails on a METHODS.toml, rather than skipping the method", async () => {
    route([
      ["repos/acme/tools", () => json(200, { private: false })],
      ["contents/methods", () => json(200, [{ type: "dir", name: "demo", path: "methods/demo" }])],
      ["contents/methods/demo/METHODS.toml", () => json(500, { message: "boom" })],
    ]);
    expect((await failure()).reason).toBe("fetch_failed");
  });

  it("skips a method whose METHODS.toml is absent", async () => {
    route([
      ["repos/acme/tools", () => json(200, { private: false })],
      ["contents/methods", () => json(200, [{ type: "dir", name: "demo", path: "methods/demo" }])],
      ["contents/methods/demo/METHODS.toml", () => json(404, { message: "Not Found" })],
    ]);
    const resolved = await resolveFromGitHub(PARSED);
    expect(resolved.methods).toEqual([]);
    expect(resolved.skipped).toEqual([
      { dirName: "demo", errors: ["No METHODS.toml found at methods/demo/METHODS.toml."] },
    ]);
  });
});
