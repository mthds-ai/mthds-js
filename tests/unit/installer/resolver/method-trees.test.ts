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
      // The default branch has moved on since the listing: its manifest is not the tree's.
      if (url === `${API}/contents/methods/demo/METHODS.toml`) {
        return json({
          type: "file",
          content: Buffer.from(manifest().replace("1.0.0", "9.9.9")).toString("base64"),
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

  it("reads the manifest from the method's git tree, never from the moving default branch", async () => {
    const asked = serve([
      { path: "METHODS.toml", blob: blob("b-manifest", MANIFEST) },
      { path: "bundle.mthds", blob: blob("b-bundle", "domain = 'demo'\n") },
    ]);

    const resolved = await resolveFromGitHub(parsed);

    expect(resolved.methods[0]!.rawManifest).toBe(MANIFEST);
    expect(resolved.methods[0]!.manifest.package.version).toBe("1.0.0");
    expect(asked.some((url) => url.includes("/contents/methods/demo/"))).toBe(false);
    expect(asked.filter((url) => url.endsWith("/git/blobs/b-manifest"))).toHaveLength(1);
  });

  it("applies .gitignore and the manifest's exclude before judging names, collisions and links, and fetches only the members' blobs", async () => {
    const asked = serve([
      { path: "METHODS.toml", blob: blob("b-manifest", manifest('exclude = ["scratch/"]')) },
      { path: ".gitignore", blob: blob("b-ignore", "drafts/\n") },
      { path: "bundle.mthds", blob: blob("b-bundle", "domain = 'demo'\n") },
      { path: "café.mthds", blob: blob("b-cafe", "domain = 'cafe'\n") },
      { path: "drafts/a\\b.txt", blob: blob("b-bad-name", "x") },
      { path: "drafts/A.txt", blob: blob("b-upper", "x") },
      { path: "drafts/a.txt", blob: blob("b-lower", "y") },
      { path: "drafts/link", mode: "120000", blob: blob("b-draft-link", "../bundle.mthds") },
      { path: "scratch/notes.txt", blob: blob("b-notes", "z") },
    ]);

    const resolved = await resolveFromGitHub(parsed);

    expect(resolved.skipped).toEqual([]);
    expect(contents(resolved.methods[0]!)).toEqual({
      "METHODS.toml": bytesOf(manifest('exclude = ["scratch/"]')),
      "bundle.mthds": bytesOf("domain = 'demo'\n"),
      "café.mthds": bytesOf("domain = 'cafe'\n"),
    });
    for (const sha of ["b-bad-name", "b-upper", "b-lower", "b-draft-link", "b-notes"]) {
      expect(asked.some((url) => url.endsWith(`/git/blobs/${sha}`))).toBe(false);
    }
  });

  it("refuses a link the tree admits without fetching it, and paths that collide among its members", async () => {
    let asked = serve([
      { path: "METHODS.toml", blob: blob("b-manifest", MANIFEST) },
      { path: "bundle.mthds", blob: blob("b-bundle", "domain = 'demo'\n") },
      { path: "link.mthds", mode: "120000", blob: blob("b-link", "bundle.mthds") },
    ]);
    let resolved = await resolveFromGitHub(parsed);
    expect(resolved.methods).toEqual([]);
    expect(resolved.skipped[0]!.errors[0]).toMatch(/refused/);
    expect(asked.some((url) => url.endsWith("/git/blobs/b-link"))).toBe(false);

    asked = serve([
      { path: "METHODS.toml", blob: blob("b-manifest", MANIFEST) },
      { path: "bundle.mthds", blob: blob("b-bundle", "domain = 'demo'\n") },
      { path: "Notes.txt", blob: blob("b-upper", "x") },
      { path: "notes.txt", blob: blob("b-lower", "y") },
    ]);
    resolved = await resolveFromGitHub(parsed);
    expect(resolved.methods).toEqual([]);
    expect(resolved.skipped[0]!.errors[0]).toMatch(/refused/);
  });

  describe("accepts exactly the trees the local lister accepts", () => {
    let repo: string;

    beforeEach(() => {
      repo = mkdtempSync(join(tmpdir(), "mthds-github-parity-"));
    });

    afterEach(() => {
      rmSync(repo, { recursive: true, force: true });
    });

    type Spec = Record<string, string | { link: string }>;

    /** What a resolve gives, comparable across the two resolvers. */
    function outcome(resolved: { methods: ResolvedMethod[]; skipped: unknown[] }): unknown {
      return resolved.methods.length === 0 ? "skipped" : contents(resolved.methods[0]!);
    }

    async function both(spec: Spec): Promise<[unknown, unknown]> {
      for (const [path, content] of Object.entries(spec)) {
        const target = join(repo, "methods", "demo", ...path.split("/"));
        mkdirSync(join(target, ".."), { recursive: true });
        if (typeof content === "string") writeFileSync(target, content);
        else symlinkSync(content.link, target);
      }
      const local = outcome(await resolveFromLocal(repo));
      serve(
        Object.entries(spec).map(([path, content], index) =>
          typeof content === "string"
            ? { path, blob: blob(`b${index}`, content) }
            : { path, mode: "120000", blob: blob(`b${index}`, content.link) },
        ),
      );
      const github = outcome(await resolveFromGitHub(parsed));
      return [local, github];
    }

    const base: Spec = { "METHODS.toml": manifest(), "bundle.mthds": "domain = 'demo'\n" };

    it.each<[string, Spec]>([
      ["a plain tree", { "funcs/f.py": "def f(): ...\n" }],
      ["a decomposed file name", { "café.mthds": "domain = 'cafe'\n" }],
      [
        "an invalid name in an ignored directory",
        { ".gitignore": "drafts/\n", "drafts/a\\b.txt": "x" },
      ],
      ["a link in an ignored directory", { ".gitignore": "drafts/\n", "drafts/l": { link: "x" } }],
      ["a link the tree admits", { "l.mthds": { link: "bundle.mthds" } }],
      ["a nested package", { "sub/METHODS.toml": "[package]\n", "sub/x.mthds": "domain = 'x'\n" }],
      ["a virtual environment", { "env/pyvenv.cfg": "home = /usr\n", "env/x.py": "x" }],
      ["a manifest named as a link", { "sub/METHODS.toml": { link: "x" }, "sub/y.py": "y" }],
    ])("%s", async (_topic, extra) => {
      const [local, github] = await both({ ...base, ...extra });
      expect(github).toEqual(local);
    });
  });
});
