import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Both resolvers give a method's whole tree, as the standard's lister defines it from the
// method's directory, with each file's exact bytes: its Python, templates and images travel
// with its manifest and bundles. GitHub is a stub here: `gh` is absent and `fetch` answers
// the routes the test gives it.

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(() => {
    throw new Error("gh: not found");
  }),
}));

import { resolveFromLocal } from "../../../../src/installer/resolver/local.js";
import { resolveFromGitHub } from "../../../../src/installer/resolver/github.js";
import type { ResolvedMethod } from "../../../../src/package/manifest/types.js";

function manifest(packageExtra = ""): string {
  return [
    "[package]",
    'name = "demo"',
    'address = "github.com/acme/tools"',
    'version = "1.0.0"',
    'description = "Demo"',
    packageExtra,
    "[exports.demo]",
    'pipes = ["main"]',
    "",
  ].join("\n");
}
const MANIFEST = manifest();
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0x0d, 0x0a]);

function contents(method: ResolvedMethod): Record<string, number[]> {
  return Object.fromEntries(method.files.map((file) => [file.path, [...file.bytes]]));
}

const bytesOf = (text: string): number[] => [...new TextEncoder().encode(text)];

describe("resolveFromLocal", () => {
  let repo: string;

  function write(relative: string, content: string | Uint8Array): void {
    const path = join(repo, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "mthds-local-resolve-"));
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("gives every file of the method's tree with its exact bytes, binary files included", async () => {
    write("methods/demo/METHODS.toml", MANIFEST);
    write("methods/demo/bundle.mthds", "domain = 'demo'\n");
    write("methods/demo/funcs/f.py", "def f(): ...\n");
    write("methods/demo/images/logo.png", PNG);

    const resolved = await resolveFromLocal(repo);

    expect(resolved.skipped).toEqual([]);
    expect(contents(resolved.methods[0]!)).toEqual({
      "METHODS.toml": bytesOf(MANIFEST),
      "bundle.mthds": bytesOf("domain = 'demo'\n"),
      "funcs/f.py": bytesOf("def f(): ...\n"),
      "images/logo.png": [...PNG],
    });
  });

  it("leaves out what the membership rule excludes, .gitignore and the manifest's exclude included", async () => {
    write("methods/demo/METHODS.toml", manifest('exclude = ["drafts/"]'));
    write("methods/demo/bundle.mthds", "domain = 'demo'\n");
    write("methods/demo/.gitignore", "*.log\n");
    write("methods/demo/run.log", "noise");
    write("methods/demo/drafts/d.mthds", "domain = 'draft'\n");
    write("methods/demo/.venv/pyvenv.cfg", "home = /usr\n");
    write("methods/demo/__pycache__/f.pyc", "x");
    write("methods/demo/sub/METHODS.toml", "[package]\n");
    write("methods/demo/sub/other.mthds", "domain = 'other'\n");

    const resolved = await resolveFromLocal(repo);

    expect(resolved.methods[0]!.files.map((file) => file.path)).toEqual([
      "METHODS.toml",
      "bundle.mthds",
    ]);
  });

  it("skips a method whose tree is refused, naming why", async () => {
    write("methods/demo/METHODS.toml", MANIFEST);
    write("methods/demo/bundle.mthds", "domain = 'demo'\n");
    symlinkSync("bundle.mthds", join(repo, "methods/demo/link.mthds"));

    const resolved = await resolveFromLocal(repo);

    expect(resolved.methods).toEqual([]);
    expect(resolved.skipped[0]!.dirName).toBe("demo");
    expect(resolved.skipped[0]!.errors[0]).toMatch(/tree is refused/);
  });
});

describe("resolveFromGitHub", () => {
  const fetchStub = vi.fn();
  const API = "https://api.github.com/repos/acme/tools";

  interface Blob {
    sha: string;
    content: Uint8Array;
  }

  function blob(sha: string, content: string | Uint8Array): Blob {
    return {
      sha,
      content: typeof content === "string" ? new TextEncoder().encode(content) : content,
    };
  }

  /** Stub the GitHub API: the repository, its methods listing, the manifest, one git tree and its blobs. */
  function serve(
    tree: { path: string; mode?: string; type?: string; blob?: Blob }[],
    options: { truncated?: boolean } = {},
  ): string[] {
    const asked: string[] = [];
    const blobs = new Map(
      tree.flatMap((entry) => (entry.blob ? [[entry.blob.sha, entry.blob]] : [])),
    );
    fetchStub.mockImplementation(async (input: unknown) => {
      const url = String(input);
      asked.push(url);
      const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (url === API) return json({ private: false });
      if (url === `${API}/contents/methods`) {
        return json([{ type: "dir", name: "demo", path: "methods/demo", sha: "tree-demo" }]);
      }
      if (url === `${API}/contents/methods/demo/METHODS.toml`) {
        return json({
          type: "file",
          content: Buffer.from(MANIFEST).toString("base64"),
          encoding: "base64",
        });
      }
      if (url === `${API}/git/trees/tree-demo?recursive=1`) {
        return json({
          truncated: options.truncated ?? false,
          tree: tree.map((entry) => ({
            path: entry.path,
            mode: entry.mode ?? "100644",
            type: entry.type ?? "blob",
            sha: entry.blob?.sha ?? `sha-${entry.path}`,
          })),
        });
      }
      const blobMatch = /\/git\/blobs\/(.+)$/.exec(url);
      if (blobMatch && blobs.has(blobMatch[1]!)) {
        return json({
          content: Buffer.from(blobs.get(blobMatch[1]!)!.content).toString("base64"),
          encoding: "base64",
        });
      }
      return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    });
    return asked;
  }

  beforeEach(() => {
    fetchStub.mockReset();
    vi.stubGlobal("fetch", fetchStub);
    vi.stubEnv("GITHUB_TOKEN", undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  const parsed = { org: "acme", repo: "tools", subpath: null };

  it("gives every file of the method's git tree with its exact bytes, reading each blob once", async () => {
    const shared = blob("b-shared", "def f(): ...\n");
    const asked = serve([
      { path: "METHODS.toml", blob: blob("b-manifest", MANIFEST) },
      { path: "bundle.mthds", blob: blob("b-bundle", "domain = 'demo'\n") },
      { path: "funcs", type: "tree" },
      { path: "funcs/f.py", blob: shared },
      { path: "funcs/g.py", blob: shared },
      { path: "images/logo.png", blob: blob("b-png", PNG) },
    ]);

    const resolved = await resolveFromGitHub(parsed);

    expect(resolved.skipped).toEqual([]);
    expect(contents(resolved.methods[0]!)).toEqual({
      "METHODS.toml": bytesOf(MANIFEST),
      "bundle.mthds": bytesOf("domain = 'demo'\n"),
      "funcs/f.py": bytesOf("def f(): ...\n"),
      "funcs/g.py": bytesOf("def f(): ...\n"),
      "images/logo.png": [...PNG],
    });
    expect(asked.filter((url) => url.endsWith("/git/blobs/b-shared"))).toHaveLength(1);
  });

  it("applies the membership rule, never fetching what it excludes by name or marker", async () => {
    const asked = serve([
      { path: "METHODS.toml", blob: blob("b-manifest", MANIFEST) },
      { path: "bundle.mthds", blob: blob("b-bundle", "domain = 'demo'\n") },
      { path: ".gitignore", blob: blob("b-ignore", "*.log\n") },
      { path: "run.log", blob: blob("b-log", "noise") },
      { path: ".github/workflows/ci.yml", blob: blob("b-ci", "on: push\n") },
      { path: "node_modules/x/index.js", blob: blob("b-node", "x") },
      { path: "env/pyvenv.cfg", blob: blob("b-venv", "home = /usr\n") },
      { path: "env/lib/site.py", blob: blob("b-site", "x") },
      { path: "sub/METHODS.toml", blob: blob("b-sub", "[package]\n") },
      { path: "sub/other.mthds", blob: blob("b-other", "domain = 'other'\n") },
      { path: "vendored", type: "commit", mode: "160000" },
    ]);

    const resolved = await resolveFromGitHub(parsed);

    // A `.gitignore` is read for its patterns, never a member, being a dotted name.
    expect(resolved.methods[0]!.files.map((file) => file.path)).toEqual([
      "METHODS.toml",
      "bundle.mthds",
    ]);
    for (const sha of ["b-ci", "b-node", "b-venv", "b-site", "b-sub", "b-other"]) {
      expect(asked.some((url) => url.endsWith(`/git/blobs/${sha}`))).toBe(false);
    }
  });

  it("skips a method whose tree holds a symbolic link, as a lister refuses it", async () => {
    serve([
      { path: "METHODS.toml", blob: blob("b-manifest", MANIFEST) },
      { path: "bundle.mthds", blob: blob("b-bundle", "domain = 'demo'\n") },
      { path: "link.mthds", mode: "120000", blob: blob("b-link", "bundle.mthds") },
    ]);

    const resolved = await resolveFromGitHub(parsed);

    expect(resolved.methods).toEqual([]);
    expect(resolved.skipped[0]!.errors[0]).toMatch(/refused/);
  });

  it("skips a method whose git tree GitHub truncated, rather than install part of it", async () => {
    serve([{ path: "METHODS.toml", blob: blob("b-manifest", MANIFEST) }], { truncated: true });

    const resolved = await resolveFromGitHub(parsed);

    expect(resolved.methods).toEqual([]);
    expect(resolved.skipped[0]!.errors[0]).toMatch(/truncated/);
  });
});
