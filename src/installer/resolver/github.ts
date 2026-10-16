import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import type {
  ParsedAddress,
  ResolvedRepo,
  ResolvedMethod,
  SkippedMethod,
  MethodsFile,
} from "../../package/manifest/types.js";
import { validateManifest } from "../../package/manifest/validate.js";
import { isResolveFailure, MethodResolveError, rewordResolveFailure } from "./exceptions.js";
import type { ResolveFailureReason } from "./exceptions.js";

const execFileAsync = promisify(execFile);

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
        maxBuffer: 10 * 1024 * 1024,
      }));
    } catch (err) {
      const stderr = (err as { stderr?: string })?.stderr ?? "";
      if (stderr.includes("HTTP 401") || stderr.includes("Bad credentials")) {
        throw new MethodResolveError(
          `GitHub refused the gh CLI's credentials (401) for ${apiPath}. Run gh auth login, or set GITHUB_TOKEN.`,
          "not_configured",
          { setting: "GITHUB_TOKEN", cause: err },
        );
      }
      if (stderr.includes("404") || stderr.includes("Not Found")) {
        throw new MethodResolveError(`Not found: ${apiPath}.`, "not_found", { cause: err });
      }
      if (stderr.includes("403") || stderr.includes("rate limit")) {
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
}

type GitHubContent = GitHubContentFile | GitHubContentDir;

/**
 * The text of the file at `path`. A download that fails, whatever its status, is `fetch_failed`:
 * the contents route named the file, so it exists. `noFile` is what a contents answer naming no
 * file reads as, such as a directory or a submodule standing at the path: `not_found` for a probe
 * whose absence skips a method, `fetch_failed` for a file the listing named.
 */
async function fetchFileContent(
  auth: AuthMethod,
  org: string,
  repo: string,
  path: string,
  noFile: ResolveFailureReason = "fetch_failed",
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
    const res = await fetchFromGitHub(data.download_url, headers, path);
    if (!res.ok) {
      throw new MethodResolveError(
        `Failed to download ${path}: HTTP ${res.status}`,
        "fetch_failed",
      );
    }
    return readGitHubBody(res, path);
  }

  // GitHub answered, and what stands at the path is no file, such as a directory or a submodule.
  throw new MethodResolveError(`No file at ${path}: GitHub lists no content for it.`, noFile);
}

async function listMthdFiles(
  auth: AuthMethod,
  org: string,
  repo: string,
  basePath: string,
): Promise<string[]> {
  const paths: string[] = [];
  const stack = [basePath];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    const data = (await githubFetch(
      auth,
      `repos/${org}/${repo}/contents/${dir}`,
    )) as GitHubContent[];

    if (!Array.isArray(data)) continue;

    for (const item of data) {
      if (item.type === "dir") {
        stack.push(item.path);
      } else if (item.type === "file" && item.name.endsWith(".mthds")) {
        paths.push(item.path);
      }
    }
  }

  return paths;
}

async function downloadFilesParallel(
  auth: AuthMethod,
  org: string,
  repo: string,
  filePaths: string[],
  basePath: string,
  concurrency: number = 5,
): Promise<MethodsFile[]> {
  const results: MethodsFile[] = [];

  for (let i = 0; i < filePaths.length; i += concurrency) {
    const batch = filePaths.slice(i, i + concurrency);
    const downloaded = await Promise.all(
      batch.map(async (fp) => {
        const content = await fetchFileContent(auth, org, repo, fp);
        const relativePath = fp.startsWith(basePath + "/")
          ? fp.slice(basePath.length + 1)
          : fp.slice(basePath.length === 0 ? 0 : basePath.length + 1);
        return { relativePath, content };
      }),
    );
    results.push(...downloaded);
  }

  return results;
}

async function resolveOneMethod(
  auth: AuthMethod,
  org: string,
  repo: string,
  methodsPath: string,
  dirName: string,
): Promise<{ method?: ResolvedMethod; skipped?: SkippedMethod }> {
  const dirPath = `${methodsPath}/${dirName}`;
  const tomlPath = `${dirPath}/METHODS.toml`;

  // Fetch METHODS.toml. Only its absence skips the method: GitHub failing to answer is no
  // finding about the method, and fails the whole resolve.
  let rawToml: string;
  try {
    rawToml = await fetchFileContent(auth, org, repo, tomlPath, "not_found");
  } catch (err) {
    if (!isResolveFailure(err, "not_found")) throw err;
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

  // Find and download .mthds files
  const mthdPaths = await listMthdFiles(auth, org, repo, dirPath);
  const files = await downloadFilesParallel(auth, org, repo, mthdPaths, dirPath);

  return {
    method: {
      name: result.manifest.package.name,
      manifest: result.manifest,
      rawManifest: rawToml,
      files,
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

  const methodDirs = contents.filter((c) => c.type === "dir").map((c) => c.name);

  if (methodDirs.length === 0) {
    throw new MethodResolveError(
      `No methods found in methods/ of ${org}/${repo}${subpath ? `/${subpath}` : ""}.`,
      "not_found",
    );
  }

  // Resolve each method (parallel, max 5 concurrent)
  const methods: ResolvedMethod[] = [];
  const skipped: SkippedMethod[] = [];

  for (let i = 0; i < methodDirs.length; i += 5) {
    const batch = methodDirs.slice(i, i + 5);
    const results = await Promise.all(
      batch.map((dirName) => resolveOneMethod(auth, org, repo, methodsPath, dirName)),
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
