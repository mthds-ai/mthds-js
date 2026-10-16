import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  ParsedAddress,
  ResolvedRepo,
  ResolvedMethod,
  SkippedMethod,
} from "../../package/manifest/types.js";
import { validateManifest } from "../../package/manifest/validate.js";
import {
  GITIGNORE_NAME,
  MANIFEST_NAME,
  VENV_MARKER_NAME,
  isDefaultExcludedDirectory,
  isDotSegment,
} from "../../method-tree/membership.js";
import { directoriesOf, pathCollisions, treePathViolation } from "../../method-tree/tree-path.js";
import { readMethodTreeOrSkip } from "./method-tree-files.js";

const execFileAsync = promisify(execFile);

/** The most `gh api` may print, which bounds the largest file a method can hold through it. */
const GH_MAX_BUFFER_BYTES = 256 * 1024 * 1024;
/** How many GitHub requests a resolve keeps in flight. */
const GITHUB_CONCURRENCY = 5;
/** Git's file modes for a symbolic link and a submodule. */
const GIT_SYMLINK_MODE = "120000";

type AuthMethod = { type: "token"; token: string } | { type: "gh" } | { type: "none" };

function detectAuth(): AuthMethod {
  const token = process.env["GITHUB_TOKEN"];
  if (token) {
    return { type: "token", token };
  }

  try {
    execFileSync("gh", ["auth", "status"], { stdio: "ignore" });
    return { type: "gh" };
  } catch {
    // gh not available or not authenticated
  }

  return { type: "none" };
}

async function githubFetch(auth: AuthMethod, apiPath: string): Promise<unknown> {
  if (auth.type === "gh") {
    try {
      const { stdout } = await execFileAsync("gh", ["api", apiPath], {
        encoding: "utf-8",
        // A blob comes back in Base64 inside the JSON, a third larger than the file.
        maxBuffer: GH_MAX_BUFFER_BYTES,
      });
      return JSON.parse(stdout);
    } catch (err) {
      const stderr = (err as { stderr?: string })?.stderr ?? "";
      if (stderr.includes("404") || stderr.includes("Not Found")) {
        throw new Error(`Not found: ${apiPath}.`);
      }
      if (stderr.includes("403") || stderr.includes("rate limit")) {
        throw new Error(
          `GitHub API rate limit or permission error for ${apiPath}. Try setting GITHUB_TOKEN.`,
        );
      }
      throw new Error(
        `GitHub API error for ${apiPath}: ${stderr.trim() || (err as Error).message}`,
      );
    }
  }

  const url = `https://api.github.com/${apiPath}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "mthds-cli",
  };

  if (auth.type === "token") {
    headers["Authorization"] = `Bearer ${auth.token}`;
  }

  const res = await fetch(url, { headers });

  if (!res.ok) {
    if (res.status === 404) {
      const hint =
        auth.type === "none"
          ? " If this is a private repo, set GITHUB_TOKEN or install the gh CLI."
          : "";
      throw new Error(`Not found: ${apiPath}.${hint}`);
    }
    if (res.status === 403) {
      throw new Error(
        `GitHub API rate limit or permission error (403) for ${apiPath}. Try setting GITHUB_TOKEN.`,
      );
    }
    throw new Error(`GitHub API error ${res.status} for ${apiPath}.`);
  }

  return res.json();
}

interface GitHubContentFile {
  type: "file";
  name: string;
  path: string;
  download_url: string | null;
  content?: string;
  encoding?: string;
}

interface GitHubContentDir {
  type: "dir";
  name: string;
  path: string;
  /** The SHA of the directory's git tree. */
  sha: string;
}

/** One entry of a recursive git tree, as `GET /repos/{owner}/{repo}/git/trees/{sha}` gives it. */
interface GitTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

interface GitTree {
  tree: GitTreeEntry[];
  truncated: boolean;
}

type GitHubContent = GitHubContentFile | GitHubContentDir;

async function fetchFileContent(
  auth: AuthMethod,
  org: string,
  repo: string,
  path: string,
): Promise<string> {
  const data = (await githubFetch(
    auth,
    `repos/${org}/${repo}/contents/${path}`,
  )) as GitHubContentFile;

  if (data.content && data.encoding === "base64") {
    return Buffer.from(data.content, "base64").toString("utf-8");
  }

  if (data.download_url) {
    const headers: Record<string, string> = {
      "User-Agent": "mthds-cli",
    };
    if (auth.type === "token") {
      headers["Authorization"] = `Bearer ${auth.token}`;
    }
    const res = await fetch(data.download_url, { headers });
    if (!res.ok) {
      throw new Error(`Failed to download ${path}: HTTP ${res.status}`);
    }
    return res.text();
  }

  throw new Error(`Cannot retrieve content for ${path}.`);
}

/**
 * The blobs of a method's git tree that can be members of its tree, the rest left unread: a path
 * under a directory starting with a dot, a `__pycache__` or `node_modules` directory, or a
 * directory below the root that a `pyvenv.cfg` marks as a virtual environment or a `METHODS.toml`
 * as a package of its own, and a dotted file other than a `.gitignore`. What is left is written to
 * disk for the lister, which applies the whole rule, `.gitignore` files and the manifest's
 * `exclude` included. A submodule is a repository of its own and never part of a tree.
 */
function memberCandidates(entries: readonly GitTreeEntry[]): GitTreeEntry[] {
  const blobs = entries.filter((entry) => entry.type === "blob");
  const markedDirectories = new Set<string>();
  for (const blob of blobs) {
    const segments = blob.path.split("/");
    const name = segments[segments.length - 1]!;
    const directory = segments.slice(0, -1).join("/");
    if (name === VENV_MARKER_NAME && directory !== "") markedDirectories.add(directory);
    if (name === MANIFEST_NAME && directory !== "") markedDirectories.add(directory);
  }
  return blobs.filter((blob) => {
    const segments = blob.path.split("/");
    const name = segments[segments.length - 1]!;
    const directories = segments.slice(0, -1);
    if (
      directories.some((segment) => isDotSegment(segment) || isDefaultExcludedDirectory(segment))
    ) {
      return false;
    }
    if (isDotSegment(name) && name !== GITIGNORE_NAME) return false;
    return !directoriesOf(blob.path).some((directory) => markedDirectories.has(directory));
  });
}

/** A blob's bytes, `GET /repos/{owner}/{repo}/git/blobs/{sha}`. */
async function fetchBlob(
  auth: AuthMethod,
  org: string,
  repo: string,
  sha: string,
): Promise<Buffer> {
  const data = (await githubFetch(auth, `repos/${org}/${repo}/git/blobs/${sha}`)) as {
    content?: unknown;
    encoding?: unknown;
  };
  if (typeof data.content !== "string" || data.encoding !== "base64") {
    throw new Error(`GitHub answered blob ${sha} of ${org}/${repo} without its Base64 content.`);
  }
  return Buffer.from(data.content, "base64");
}

/** Every distinct blob's bytes, a few requests at a time. */
async function fetchBlobs(
  auth: AuthMethod,
  org: string,
  repo: string,
  shas: readonly string[],
): Promise<Map<string, Buffer>> {
  const unique = [...new Set(shas)];
  const bytes = new Map<string, Buffer>();
  for (let i = 0; i < unique.length; i += GITHUB_CONCURRENCY) {
    const batch = unique.slice(i, i + GITHUB_CONCURRENCY);
    const fetched = await Promise.all(batch.map((sha) => fetchBlob(auth, org, repo, sha)));
    batch.forEach((sha, index) => bytes.set(sha, fetched[index]!));
  }
  return bytes;
}

/**
 * Read a method's tree from its git tree on GitHub, as the lister defines it: the candidate files
 * are written into a scratch directory as a checkout would hold them, a symbolic link as a link,
 * the lister lists that directory as the method's root, and the scratch directory is removed.
 * Gives the reason the method is skipped when its tree cannot be read faithfully or is refused.
 */
async function readGitHubMethodTree(
  auth: AuthMethod,
  org: string,
  repo: string,
  treeSha: string,
  dirPath: string,
): Promise<Awaited<ReturnType<typeof readMethodTreeOrSkip>>> {
  const gitTree = (await githubFetch(
    auth,
    `repos/${org}/${repo}/git/trees/${treeSha}?recursive=1`,
  )) as GitTree;
  if (gitTree.truncated) {
    return {
      error: `GitHub truncated the listing of ${dirPath}, which holds too many entries to read in one answer.`,
    };
  }
  const candidates = memberCandidates(gitTree.tree);
  for (const candidate of candidates) {
    const violation = treePathViolation(candidate.path);
    if (violation !== null) {
      return {
        error: `The method's tree is refused: '${candidate.path}' is not a tree path: ${violation}.`,
      };
    }
  }
  const collisions = pathCollisions(candidates.map((candidate) => candidate.path));
  if (collisions.length > 0) {
    return {
      error: `The method's tree is refused: paths collide once case-folded: ${collisions.join(", ")}.`,
    };
  }
  const files = candidates.filter((candidate) => candidate.mode !== GIT_SYMLINK_MODE);
  const bytes = await fetchBlobs(
    auth,
    org,
    repo,
    files.map((file) => file.sha),
  );

  const scratch = mkdtempSync(join(tmpdir(), "mthds-github-method-"));
  try {
    for (const candidate of candidates) {
      const target = join(scratch, ...candidate.path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      if (candidate.mode === GIT_SYMLINK_MODE) {
        // The link's target is never read: a link is refused by the lister wherever it points.
        try {
          symlinkSync("mthds-github-link", target);
        } catch {
          return {
            error: `The method's tree is refused: '${candidate.path}' is a symbolic link, which a method's tree cannot hold.`,
          };
        }
      } else {
        writeFileSync(target, bytes.get(candidate.sha)!);
      }
    }
    return await readMethodTreeOrSkip(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function resolveOneMethod(
  auth: AuthMethod,
  org: string,
  repo: string,
  methodsPath: string,
  dirName: string,
  treeSha: string,
): Promise<{ method?: ResolvedMethod; skipped?: SkippedMethod }> {
  const dirPath = `${methodsPath}/${dirName}`;
  const tomlPath = `${dirPath}/METHODS.toml`;

  // Fetch METHODS.toml
  let rawToml: string;
  try {
    rawToml = await fetchFileContent(auth, org, repo, tomlPath);
  } catch {
    return { skipped: { dirName, errors: [`No METHODS.toml found at ${tomlPath}.`] } };
  }

  // Validate manifest
  const result = validateManifest(rawToml);
  if (!result.valid || !result.manifest) {
    return { skipped: { dirName, errors: result.errors } };
  }

  // Ensure directory name matches the expected snake_case form of package.name
  const manifestName = result.manifest.package.name;
  if (manifestName) {
    const expectedDir = manifestName;
    if (expectedDir !== dirName) {
      return {
        skipped: {
          dirName,
          errors: [
            `Directory "${dirName}" does not match [package.name] "${manifestName}". ` +
              `Expected directory name: "${expectedDir}".`,
          ],
        },
      };
    }
  }

  // The method's whole tree, its Python, templates and other files beside its bundles.
  const tree = await readGitHubMethodTree(auth, org, repo, treeSha, dirPath);
  if ("error" in tree) {
    return { skipped: { dirName, errors: [tree.error] } };
  }

  return {
    method: {
      name: result.manifest.package.name,
      manifest: result.manifest,
      rawManifest: rawToml,
      files: tree.files,
    },
  };
}

/** What GitHub says about a repository's visibility to the credentials at hand. */
export type RepositoryVisibility = "public" | "private" | "not_found";

/**
 * Ask GitHub whether `org/repo` is public, with the credentials a resolve uses. GitHub answers
 * `not_found` for a repository that does not exist and for a private one these credentials cannot
 * see; an answer that does not say the repository is public counts as private. Throws when GitHub
 * cannot be asked.
 */
export async function repositoryVisibility(
  org: string,
  repo: string,
): Promise<RepositoryVisibility> {
  let meta: { private?: unknown };
  try {
    meta = (await githubFetch(detectAuth(), `repos/${org}/${repo}`)) as { private?: unknown };
  } catch (err) {
    if ((err as Error).message.startsWith("Not found")) return "not_found";
    throw err;
  }
  return meta.private === false ? "public" : "private";
}

export async function resolveFromGitHub(parsed: ParsedAddress): Promise<ResolvedRepo> {
  const auth = detectAuth();
  const { org, repo, subpath } = parsed;
  const methodsPath = subpath ? `${subpath}/methods` : "methods";

  // Check if repo exists and is public
  let repoMeta: { private: boolean };
  try {
    repoMeta = (await githubFetch(auth, `repos/${org}/${repo}`)) as { private: boolean };
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("Not found")) {
      throw new Error(
        `Repository "${org}/${repo}" not found on GitHub. Check the address and make sure the repository exists.`,
      );
    }
    throw new Error(`Could not connect to GitHub for "${org}/${repo}": ${msg}`);
  }
  const isPublic = !repoMeta.private;

  // List directories inside methods/
  let contents: GitHubContent[];
  try {
    contents = (await githubFetch(
      auth,
      `repos/${org}/${repo}/contents/${methodsPath}`,
    )) as GitHubContent[];
  } catch {
    throw new Error(
      `No methods/ folder found in ${org}/${repo}${subpath ? `/${subpath}` : ""}. Expected a "methods/" directory.`,
    );
  }

  if (!Array.isArray(contents)) {
    throw new Error(
      `No methods/ folder found in ${org}/${repo}${subpath ? `/${subpath}` : ""}. Expected a "methods/" directory.`,
    );
  }

  const methodDirs = contents.filter((c): c is GitHubContentDir => c.type === "dir");

  if (methodDirs.length === 0) {
    throw new Error(
      `No methods found in methods/ of ${org}/${repo}${subpath ? `/${subpath}` : ""}.`,
    );
  }

  // Resolve each method (parallel, max 5 concurrent)
  const methods: ResolvedMethod[] = [];
  const skipped: SkippedMethod[] = [];

  for (let i = 0; i < methodDirs.length; i += GITHUB_CONCURRENCY) {
    const batch = methodDirs.slice(i, i + GITHUB_CONCURRENCY);
    const results = await Promise.all(
      batch.map((dir) => resolveOneMethod(auth, org, repo, methodsPath, dir.name, dir.sha)),
    );
    for (const r of results) {
      if (r.method) methods.push(r.method);
      if (r.skipped) skipped.push(r.skipped);
    }
  }

  return {
    methods,
    skipped,
    source: "github",
    repoName: `${org}/${repo}`,
    isPublic,
  };
}
