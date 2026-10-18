import { execFile, execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type {
  MethodsFile,
  ParsedAddress,
  ResolvedRepo,
  ResolvedMethod,
  SkippedMethod,
} from "../../package/manifest/types.js";
import { validateManifest } from "../../package/manifest/validate.js";
import { isResolveFailure, MethodResolveError, rewordResolveFailure } from "./exceptions.js";
import {
  GITIGNORE_NAME,
  MANIFEST_NAME,
  VENV_MARKER_NAME,
  isDefaultExcludedDirectory,
  isDotSegment,
  isRunInputsFile,
} from "../../method-tree/membership.js";
import { directoriesOf } from "../../method-tree/tree-path.js";
import { caseFold } from "../../method-tree/case-folding.js";
import { listMethodTree } from "../../method-tree/lister.js";
import { MethodTreeError } from "../../method-tree/exceptions.js";
import type { MethodTree } from "../../method-tree/tree.js";

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

/** Read an answer's body as JSON, a body GitHub garbled reading as a failed fetch. */
function parseGitHubJson(text: string, apiPath: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new MethodResolveError(
      `GitHub answered ${apiPath} with a body that is not JSON.`,
      "fetch_failed",
      { cause },
    );
  }
}

/**
 * Ask GitHub's API for `apiPath`. Throws a `MethodResolveError`: `not_found` on a `404`,
 * `not_configured` when GitHub refuses the credentials (`401`), of `GITHUB_TOKEN` or of the `gh`
 * CLI, and `fetch_failed` for every failure a
 * later attempt may get past, GitHub unreachable, a rate limit or a `403`, a `5xx`, or an answer
 * that is not JSON.
 */
async function githubFetch(auth: AuthMethod, apiPath: string): Promise<unknown> {
  if (auth.type === "gh") {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("gh", ["api", apiPath], {
        encoding: "utf-8",
        // A blob comes back in Base64 inside the JSON, a third larger than the file.
        maxBuffer: GH_MAX_BUFFER_BYTES,
      }));
    } catch (err) {
      const stderr = (err as { stderr?: string })?.stderr ?? "";
      // `gh` names GitHub's status as `(HTTP 404)`, so the status is read there alone: a bare
      // `404` or `403` may stand in a path or a SHA that a message about another failure quotes.
      if (stderr.includes("HTTP 401") || stderr.includes("Bad credentials")) {
        throw new MethodResolveError(
          `GitHub refused the gh CLI's credentials (401) for ${apiPath}. Run gh auth login, or set GITHUB_TOKEN.`,
          "not_configured",
          { setting: "GITHUB_TOKEN", cause: err },
        );
      }
      if (/\bHTTP 404\b/.test(stderr)) {
        throw new MethodResolveError(`Not found: ${apiPath}.`, "not_found", { cause: err });
      }
      if (/\bHTTP (403|429)\b/.test(stderr) || stderr.includes("rate limit")) {
        throw new MethodResolveError(
          `GitHub API rate limit or permission error for ${apiPath}. Try setting GITHUB_TOKEN.`,
          "fetch_failed",
          { cause: err },
        );
      }
      throw new MethodResolveError(
        `GitHub API error for ${apiPath}: ${stderr.trim() || (err as Error).message}`,
        "fetch_failed",
        { cause: err },
      );
    }
    return parseGitHubJson(stdout, apiPath);
  }

  const url = `https://api.github.com/${apiPath}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "mthds-cli",
  };

  if (auth.type === "token") {
    headers["Authorization"] = `Bearer ${auth.token}`;
  }

  const res = await fetchFromGitHub(url, headers, apiPath);

  if (!res.ok) {
    if (res.status === 404) {
      const hint =
        auth.type === "none"
          ? " If this is a private repo, set GITHUB_TOKEN or install the gh CLI."
          : "";
      throw new MethodResolveError(`Not found: ${apiPath}.${hint}`, "not_found");
    }
    if (res.status === 401) {
      throw new MethodResolveError(
        `GitHub refused the token in GITHUB_TOKEN (401) for ${apiPath}.`,
        "not_configured",
        { setting: "GITHUB_TOKEN" },
      );
    }
    if (res.status === 403 || res.status === 429) {
      throw new MethodResolveError(
        `GitHub API rate limit or permission error (${res.status}) for ${apiPath}. Try setting GITHUB_TOKEN.`,
        "fetch_failed",
      );
    }
    throw new MethodResolveError(`GitHub API error ${res.status} for ${apiPath}.`, "fetch_failed");
  }

  return parseGitHubJson(await readGitHubBody(res, apiPath), apiPath);
}

/** `fetch`, a transport failure reading as a failed fetch of `what`. */
async function fetchFromGitHub(
  url: string,
  headers: Record<string, string>,
  what: string,
): Promise<Response> {
  try {
    return await fetch(url, { headers });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new MethodResolveError(`Could not reach GitHub for ${what}: ${reason}`, "fetch_failed", {
      cause,
    });
  }
}

/** An answer's body as text, a connection lost while reading it reading as a failed fetch. */
async function readGitHubBody(res: Response, what: string): Promise<string> {
  try {
    return await res.text();
  } catch (cause) {
    throw new MethodResolveError(`Lost the connection to GitHub reading ${what}.`, "fetch_failed", {
      cause,
    });
  }
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

/**
 * The blobs of a method's git tree that can be members of its tree, the rest left unread: a path
 * under a directory starting with a dot, a `__pycache__` or `node_modules` directory, or a
 * directory below the root that a `pyvenv.cfg` file or link marks as a virtual environment or a
 * `METHODS.toml` file as a package of its own, a dotted file other than a `.gitignore`, and a run's
 * inputs file, named `inputs.json` or `inputs.toml`, which every blob of either name is, a file or
 * a link alike. These the rule excludes whatever else the tree holds. What is left goes to the lister, which applies
 * the whole rule, `.gitignore` files and the manifest's `exclude` included. A submodule is a
 * repository of its own and never part of a tree.
 */
function memberCandidates(entries: readonly GitTreeEntry[]): GitTreeEntry[] {
  const blobs = entries.filter((entry) => entry.type === "blob");
  const markedDirectories = new Set<string>();
  for (const blob of blobs) {
    const segments = blob.path.split("/");
    const name = segments[segments.length - 1]!;
    const directory = segments.slice(0, -1).join("/");
    if (directory === "") continue;
    if (name === VENV_MARKER_NAME) markedDirectories.add(directory);
    // Only a manifest file marks a package; a link of that name is a link the tree may refuse.
    if (name === MANIFEST_NAME && blob.mode !== GIT_SYMLINK_MODE) markedDirectories.add(directory);
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
    if (isRunInputsFile(name, blob.mode === GIT_SYMLINK_MODE ? "symlink" : "file")) return false;
    return !directoriesOf(blob.path).some((directory) => markedDirectories.has(directory));
  });
}

/**
 * Ask GitHub for something a listing already named, such as a method's git tree or one of its
 * blobs. It exists, so a failure to read it, a `404` included, is `fetch_failed`, which a later
 * attempt may get past, never `not_found`, which would read as a method that does not exist.
 */
async function fetchListed(auth: AuthMethod, apiPath: string): Promise<unknown> {
  try {
    return await githubFetch(auth, apiPath);
  } catch (err) {
    if (!isResolveFailure(err, "not_found")) throw err;
    throw new MethodResolveError(
      `GitHub no longer serves ${apiPath}, which its listing named.`,
      "fetch_failed",
      { cause: err },
    );
  }
}

/** A blob's bytes, `GET /repos/{owner}/{repo}/git/blobs/{sha}`, read as `fetchListed` reads it. */
async function fetchBlob(
  auth: AuthMethod,
  org: string,
  repo: string,
  sha: string,
): Promise<Buffer> {
  const data = (await fetchListed(auth, `repos/${org}/${repo}/git/blobs/${sha}`)) as {
    content?: unknown;
    encoding?: unknown;
  };
  if (typeof data.content !== "string" || data.encoding !== "base64") {
    throw new MethodResolveError(
      `GitHub answered blob ${sha} of ${org}/${repo} without its Base64 content.`,
      "fetch_failed",
    );
  }
  return Buffer.from(data.content, "base64");
}

/** Every distinct blob's bytes not already in `bytes`, a few requests at a time, added to it. */
async function fetchBlobs(
  auth: AuthMethod,
  org: string,
  repo: string,
  shas: readonly string[],
  bytes: Map<string, Buffer>,
): Promise<void> {
  const unique = [...new Set(shas)].filter((sha) => !bytes.has(sha));
  for (let i = 0; i < unique.length; i += GITHUB_CONCURRENCY) {
    const batch = unique.slice(i, i + GITHUB_CONCURRENCY);
    const fetched = await Promise.all(batch.map((sha) => fetchBlob(auth, org, repo, sha)));
    batch.forEach((sha, index) => bytes.set(sha, fetched[index]!));
  }
}

/** Whether anything, a link included, lies at `path`. */
function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Errors meaning the file system holds another entry where one is written: it folds the names. */
const FOLDED_NAME_ERRORS: ReadonlySet<string> = new Set(["EEXIST", "ENOTDIR", "EISDIR"]);

/** A tree path, each segment normalized to NFC, as the lister names a file. */
function nfcPath(path: string): string {
  return path
    .split("/")
    .map((segment) => segment.normalize("NFC"))
    .join("/");
}

/** What the skeleton of a git tree written to disk holds. */
interface Skeleton {
  /** The entry each written file stands for, by its raw path and by its path in NFC. */
  readonly written: Map<string, GitTreeEntry>;
  /** Entries the file system could not hold apart from one written before them. */
  readonly folded: GitTreeEntry[];
  /** Links written as empty files, on a file system where no link can be made. */
  readonly linkPlaceholders: Set<GitTreeEntry>;
}

/**
 * Write the candidates into `scratch` as a checkout holds them, for the lister to judge: the root
 * manifest and each `.gitignore` with their bytes, every other file empty, since its bytes do not
 * change what the rule admits, and a link as a link. Gives the reason when an entry cannot be
 * written on this machine.
 */
function writeSkeleton(
  scratch: string,
  candidates: readonly GitTreeEntry[],
  ruleBytes: ReadonlyMap<string, Buffer>,
): Skeleton | { error: string } {
  const written = new Map<string, GitTreeEntry>();
  const folded: GitTreeEntry[] = [];
  const linkPlaceholders = new Set<GitTreeEntry>();
  for (const entry of candidates) {
    const segments = entry.path.split("/");
    const target = join(scratch, ...segments);
    if (
      (sep !== "/" && segments.some((segment) => segment.includes(sep))) ||
      !target.startsWith(scratch + sep)
    ) {
      return { error: `'${entry.path}' cannot be written on this machine to read the tree.` };
    }
    if (entryExists(target)) {
      folded.push(entry);
      continue;
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      if (entry.mode === GIT_SYMLINK_MODE) {
        // The link's target is never read: the lister refuses a link it admits, wherever it points.
        try {
          symlinkSync("mthds-github-link", target);
        } catch {
          writeFileSync(target, "");
          linkPlaceholders.add(entry);
        }
      } else {
        writeFileSync(target, ruleBytes.get(entry.path) ?? "");
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== undefined && FOLDED_NAME_ERRORS.has(code)) {
        folded.push(entry);
        continue;
      }
      return {
        error: `'${entry.path}' cannot be written on this machine to read the tree (${code ?? "error"}).`,
      };
    }
    written.set(entry.path, entry);
    written.set(nfcPath(entry.path), entry);
  }
  return { written, folded, linkPlaceholders };
}

/**
 * Read a method's tree from its git tree on GitHub, accepting exactly the trees the lister accepts
 * from a checkout: the candidates are written into a scratch directory as a skeleton, what the
 * rule reads (the manifest, each `.gitignore`) with its bytes and every other file empty, and the
 * lister lists it, so the whole membership rule decides first, names are normalized to NFC, and
 * invalid names, collisions and links are judged among the files it admits only. Then the blobs
 * of those files alone are fetched. Gives the reason the method is skipped when its tree is
 * refused or cannot be read on this machine.
 */
async function readGitHubMethodTree(
  auth: AuthMethod,
  org: string,
  repo: string,
  gitTree: GitTree,
  manifest: { sha: string; bytes: Buffer },
): Promise<{ files: MethodsFile[] } | { error: string }> {
  const candidates = memberCandidates(gitTree.tree);
  const isGitignore = (entry: GitTreeEntry): boolean =>
    entry.mode !== GIT_SYMLINK_MODE && entry.path.split("/").pop() === GITIGNORE_NAME;
  const bytes = new Map<string, Buffer>([[manifest.sha, manifest.bytes]]);
  const ruleFiles = candidates.filter(
    (entry) =>
      isGitignore(entry) || (entry.path === MANIFEST_NAME && entry.mode !== GIT_SYMLINK_MODE),
  );
  await fetchBlobs(
    auth,
    org,
    repo,
    ruleFiles.map((entry) => entry.sha),
    bytes,
  );
  const ruleBytes = new Map(ruleFiles.map((entry) => [entry.path, bytes.get(entry.sha)!]));

  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "mthds-github-method-")));
  try {
    const skeleton = writeSkeleton(scratch, candidates, ruleBytes);
    if ("error" in skeleton) return skeleton;
    let listed: MethodTree;
    try {
      listed = await listMethodTree(scratch, { discover: false });
    } catch (err) {
      if (err instanceof MethodTreeError) {
        return { error: `The method's tree is refused: ${err.message}` };
      }
      throw err;
    }

    const members: { path: string; entry: GitTreeEntry }[] = [];
    for (const file of listed.files) {
      const onDisk = relative(listed.root!, listed.onDiskPath(file.path)!).split(sep).join("/");
      const entry = skeleton.written.get(onDisk) ?? skeleton.written.get(nfcPath(onDisk));
      if (entry === undefined) {
        return { error: `'${file.path}' cannot be traced to a file of the git tree.` };
      }
      if (skeleton.linkPlaceholders.has(entry)) {
        return {
          error: `The method's tree is refused: '${file.path}' is a symbolic link, which a method's tree cannot hold.`,
        };
      }
      members.push({ path: file.path, entry });
    }
    // Names this file system folded onto another collide in the tree when they reach a member.
    const memberFolds = new Set<string>();
    for (const member of members) {
      for (const path of [...directoriesOf(member.path), member.path]) {
        memberFolds.add(caseFold(path));
      }
    }
    const collision = skeleton.folded.find((entry) =>
      [...directoriesOf(entry.path), entry.path].some((path) => memberFolds.has(caseFold(path))),
    );
    if (collision !== undefined) {
      return {
        error: `The method's tree is refused: '${collision.path}' collides with another path of the tree once case-folded and normalized.`,
      };
    }

    await fetchBlobs(
      auth,
      org,
      repo,
      members.map((member) => member.entry.sha),
      bytes,
    );
    return {
      files: members.map((member) => ({
        path: member.path,
        bytes: new Uint8Array(bytes.get(member.entry.sha)!),
      })),
    };
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
  const tomlPath = `${dirPath}/${MANIFEST_NAME}`;

  // The method's git tree, which the manifest and every file are read from, so all come from
  // one commit whatever the default branch does meanwhile. GitHub failing to answer is no finding
  // about the method, and fails the whole resolve; only a tree holding no manifest skips it.
  const gitTree = (await fetchListed(
    auth,
    `repos/${org}/${repo}/git/trees/${treeSha}?recursive=1`,
  )) as GitTree;
  if (gitTree.truncated) {
    return {
      skipped: {
        dirName,
        errors: [
          `GitHub truncated the listing of ${dirPath}, which holds too many entries to read in one answer.`,
        ],
      },
    };
  }
  const manifestEntry = gitTree.tree.find(
    (entry) =>
      entry.path === MANIFEST_NAME && entry.type === "blob" && entry.mode !== GIT_SYMLINK_MODE,
  );
  if (manifestEntry === undefined) {
    return { skipped: { dirName, errors: [`No METHODS.toml found at ${tomlPath}.`] } };
  }
  const manifestBytes = await fetchBlob(auth, org, repo, manifestEntry.sha);
  const rawToml = manifestBytes.toString("utf-8");

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
  const tree = await readGitHubMethodTree(auth, org, repo, gitTree, {
    sha: manifestEntry.sha,
    bytes: manifestBytes,
  });
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
 * see; an answer that does not say the repository is public counts as private. Throws a
 * `MethodResolveError` when GitHub cannot be asked.
 */
export async function repositoryVisibility(
  org: string,
  repo: string,
): Promise<RepositoryVisibility> {
  let meta: { private?: unknown };
  try {
    meta = (await githubFetch(detectAuth(), `repos/${org}/${repo}`)) as { private?: unknown };
  } catch (err) {
    if (isResolveFailure(err, "not_found")) return "not_found";
    throw err;
  }
  return meta.private === false ? "public" : "private";
}

/**
 * Resolve the methods of a GitHub repository's `methods/` folder. Throws a `MethodResolveError`:
 * `not_found` when the repository, its `methods/` folder or every method is missing, and the
 * reason GitHub's own failure reads as otherwise (`githubFetch`).
 */
export async function resolveFromGitHub(parsed: ParsedAddress): Promise<ResolvedRepo> {
  const auth = detectAuth();
  const { org, repo, subpath } = parsed;
  const methodsPath = subpath ? `${subpath}/methods` : "methods";

  // Check if repo exists and is public
  let repoMeta: { private: boolean };
  try {
    repoMeta = (await githubFetch(auth, `repos/${org}/${repo}`)) as { private: boolean };
  } catch (err) {
    if (isResolveFailure(err, "not_found")) {
      throw new MethodResolveError(
        `Repository "${org}/${repo}" not found on GitHub. Check the address and make sure the repository exists.`,
        "not_found",
        { cause: err },
      );
    }
    throw rewordResolveFailure(
      err,
      `Could not connect to GitHub for "${org}/${repo}": ${(err as Error).message}`,
      "fetch_failed",
    );
  }
  const isPublic = !repoMeta.private;

  // List directories inside methods/
  const noMethodsFolder = `No methods/ folder found in ${org}/${repo}${subpath ? `/${subpath}` : ""}. Expected a "methods/" directory.`;
  let contents: GitHubContent[];
  try {
    contents = (await githubFetch(
      auth,
      `repos/${org}/${repo}/contents/${methodsPath}`,
    )) as GitHubContent[];
  } catch (err) {
    if (isResolveFailure(err, "not_found")) {
      throw new MethodResolveError(noMethodsFolder, "not_found", { cause: err });
    }
    throw err;
  }

  if (!Array.isArray(contents)) {
    throw new MethodResolveError(noMethodsFolder, "not_found");
  }

  const methodDirs = contents.filter((c): c is GitHubContentDir => c.type === "dir");

  if (methodDirs.length === 0) {
    throw new MethodResolveError(
      `No methods found in methods/ of ${org}/${repo}${subpath ? `/${subpath}` : ""}.`,
      "not_found",
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
