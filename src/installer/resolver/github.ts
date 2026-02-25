import { execFileSync } from "node:child_process";
import type { ParsedAddress, ResolvedRepo, ResolvedMethod, SkippedMethod, MethodsFile } from "../../package/manifest/types.js";
import { validateManifest } from "../../package/manifest/validate.js";

type AuthMethod =
  | { type: "token"; token: string }
  | { type: "gh" }
  | { type: "none" };

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

async function githubFetch(
  auth: AuthMethod,
  apiPath: string
): Promise<unknown> {
  if (auth.type === "gh") {
    try {
      const result = execFileSync("gh", ["api", apiPath], {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return JSON.parse(result);
    } catch (err) {
      const stderr = (err as { stderr?: Buffer | string })?.stderr?.toString() ?? "";
      if (stderr.includes("404") || stderr.includes("Not Found")) {
        throw new Error(`Not found: ${apiPath}.`);
      }
      if (stderr.includes("403") || stderr.includes("rate limit")) {
        throw new Error(`GitHub API rate limit or permission error for ${apiPath}. Try setting GITHUB_TOKEN.`);
      }
      throw new Error(`GitHub API error for ${apiPath}: ${stderr.trim() || (err as Error).message}`);
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
        `GitHub API rate limit or permission error (403) for ${apiPath}. Try setting GITHUB_TOKEN.`
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
}

type GitHubContent = GitHubContentFile | GitHubContentDir;

async function fetchFileContent(
  auth: AuthMethod,
  org: string,
  repo: string,
  path: string
): Promise<string> {
  const data = (await githubFetch(
    auth,
    `repos/${org}/${repo}/contents/${path}`
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

async function listMthdFiles(
  auth: AuthMethod,
  org: string,
  repo: string,
  basePath: string
): Promise<string[]> {
  const paths: string[] = [];
  const stack = [basePath];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    const data = (await githubFetch(
      auth,
      `repos/${org}/${repo}/contents/${dir}`
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
  concurrency: number = 5
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
      })
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
  dirName: string
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

export async function resolveFromGitHub(
  parsed: ParsedAddress
): Promise<ResolvedRepo> {
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
      throw new Error(`Repository "${org}/${repo}" not found on GitHub. Check the address and make sure the repository exists.`);
    }
    throw new Error(`Could not connect to GitHub for "${org}/${repo}": ${msg}`);
  }
  const isPublic = !repoMeta.private;

  // List directories inside methods/
  let contents: GitHubContent[];
  try {
    contents = (await githubFetch(
      auth,
      `repos/${org}/${repo}/contents/${methodsPath}`
    )) as GitHubContent[];
  } catch {
    throw new Error(
      `No methods/ folder found in ${org}/${repo}${subpath ? `/${subpath}` : ""}. Expected a "methods/" directory.`
    );
  }

  if (!Array.isArray(contents)) {
    throw new Error(
      `No methods/ folder found in ${org}/${repo}${subpath ? `/${subpath}` : ""}. Expected a "methods/" directory.`
    );
  }

  const methodDirs = contents.filter((c) => c.type === "dir").map((c) => c.name);

  if (methodDirs.length === 0) {
    throw new Error(
      `No methods found in methods/ of ${org}/${repo}${subpath ? `/${subpath}` : ""}.`
    );
  }

  // Resolve each method (parallel, max 5 concurrent)
  const methods: ResolvedMethod[] = [];
  const skipped: SkippedMethod[] = [];

  for (let i = 0; i < methodDirs.length; i += 5) {
    const batch = methodDirs.slice(i, i + 5);
    const results = await Promise.all(
      batch.map((dirName) => resolveOneMethod(auth, org, repo, methodsPath, dirName))
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
