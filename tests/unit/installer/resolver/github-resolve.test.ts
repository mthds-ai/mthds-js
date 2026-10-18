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

/** The `methods/demo` directory as the contents route lists it, its git tree `t1`. */
const DEMO_DIR = { type: "dir", name: "demo", path: "methods/demo", sha: "t1" };

const MANIFEST = [
  "[package]",
  'name = "demo"',
  'address = "github.com/acme/tools"',
  'version = "1.0.0"',
  'description = "Demo."',
  "",
  "[exports.default]",
  'pipes = ["main"]',
].join("\n");

const MANIFEST_ENTRY = { path: "METHODS.toml", mode: "100644", type: "blob", sha: "m1" };
const MAIN_ENTRY = { path: "main.mthds", mode: "100644", type: "blob", sha: "b1" };

/** A recursive git tree as `GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1` gives it. */
function gitTree(entries: readonly object[]): unknown {
  return { tree: entries, truncated: false };
}

/** A blob as `GET /repos/{owner}/{repo}/git/blobs/{sha}` gives it. */
function blob(text: string): unknown {
  return { content: Buffer.from(text).toString("base64"), encoding: "base64" };
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

  /** A resolve through `gh api`, which `gh auth status` lets it use, failing with `stderr`. */
  function ghFailing(stderr: string): void {
    vi.mocked(execFileSync).mockImplementationOnce(() => "");
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const callback = args[args.length - 1] as (err: Error) => void;
      callback(Object.assign(new Error("exit 1"), { stderr }));
    }) as unknown as typeof execFile);
  }

  it("reads a 404 the gh CLI reports as not_found", async () => {
    ghFailing("gh: Not Found (HTTP 404)\n");
    expect((await failure()).reason).toBe("not_found");
  });

  it("reads a gh failure quoting a path or a SHA holding 404 or 403 by its own status", async () => {
    // A server error whose message quotes the path asked for: neither the directory `error_404`
    // nor the SHA holding `403` is GitHub's status, so the failure is worth a retry, and the
    // method is never skipped as missing.
    ghFailing(
      "gh: HTTP 502: Bad Gateway (https://api.github.com/repos/acme/tools/contents/methods/error_404?ref=4031ab)\n",
    );
    expect((await failure()).reason).toBe("fetch_failed");
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

  it.each([
    ["the method's git tree", "git/trees/t1?recursive=1"],
    ["its METHODS.toml", "git/blobs/m1"],
  ])(
    "fails the resolve when GitHub fails on %s, rather than skipping the method",
    async (_what, failing) => {
      route([
        [failing, () => json(500, { message: "boom" })],
        ["repos/acme/tools", () => json(200, { private: false })],
        ["contents/methods", () => json(200, [DEMO_DIR])],
        ["git/trees/t1?recursive=1", () => json(200, gitTree([MANIFEST_ENTRY]))],
        ["git/blobs/m1", () => json(200, blob(MANIFEST))],
      ]);
      expect((await failure()).reason).toBe("fetch_failed");
    },
  );

  it("fails the resolve as fetch_failed when GitHub no longer serves the method's git tree", async () => {
    route([
      ["repos/acme/tools", () => json(200, { private: false })],
      ["contents/methods", () => json(200, [DEMO_DIR])],
      ["git/trees/t1?recursive=1", () => json(404, { message: "Not Found" })],
    ]);
    expect((await failure()).reason).toBe("fetch_failed");
  });

  it("skips a method whose METHODS.toml is absent", async () => {
    route([
      ["repos/acme/tools", () => json(200, { private: false })],
      ["contents/methods", () => json(200, [DEMO_DIR])],
      ["git/trees/t1?recursive=1", () => json(200, gitTree([MAIN_ENTRY]))],
    ]);
    const resolved = await resolveFromGitHub(PARSED);
    expect(resolved.methods).toEqual([]);
    expect(resolved.skipped).toEqual([
      { dirName: "demo", errors: ["No METHODS.toml found at methods/demo/METHODS.toml."] },
    ]);
  });

  it.each([
    ["a directory", { path: "METHODS.toml", mode: "040000", type: "tree", sha: "d1" }],
    ["a submodule", { path: "METHODS.toml", mode: "160000", type: "commit", sha: "c1" }],
  ])("skips a method whose METHODS.toml is %s rather than a file", async (_what, entry) => {
    route([
      ["repos/acme/tools", () => json(200, { private: false })],
      ["contents/methods", () => json(200, [DEMO_DIR])],
      ["git/trees/t1?recursive=1", () => json(200, gitTree([entry, MAIN_ENTRY]))],
    ]);
    const resolved = await resolveFromGitHub(PARSED);
    expect(resolved.methods).toEqual([]);
    expect(resolved.skipped).toEqual([
      { dirName: "demo", errors: ["No METHODS.toml found at methods/demo/METHODS.toml."] },
    ]);
  });

  it.each([
    ["GitHub no longer serves its blob", () => json(404, { message: "Not Found" })],
    ["GitHub answers its blob without content", () => json(200, { sha: "b1" })],
  ])("fails the resolve as fetch_failed when a listed file is gone: %s", async (_what, answer) => {
    route([
      ["repos/acme/tools", () => json(200, { private: false })],
      ["contents/methods", () => json(200, [DEMO_DIR])],
      ["git/trees/t1?recursive=1", () => json(200, gitTree([MANIFEST_ENTRY, MAIN_ENTRY]))],
      ["git/blobs/m1", () => json(200, blob(MANIFEST))],
      ["git/blobs/b1", answer],
    ]);
    const err = await failure();
    expect(err.reason).toBe("fetch_failed");
    expect(err.message).toContain("b1");
  });
});
