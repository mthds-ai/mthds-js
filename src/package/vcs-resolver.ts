import { execFile } from "node:child_process";
import type { SemVer } from "semver";
import { VCSFetchError, VersionResolutionError } from "./exceptions.js";
import { parseConstraint, parseVersionTag, selectMinimumVersion, SemVerError } from "./semver.js";

/**
 * Map a package address to a git clone URL.
 * Prepends https:// and appends .git (unless already present).
 */
export function addressToCloneUrl(address: string): string {
  let url = `https://${address}`;
  if (!url.endsWith(".git")) {
    url = `${url}.git`;
  }
  return url;
}

function execGit(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new VCSFetchError("git is not installed or not found on PATH"));
          return;
        }
        if (error.killed) {
          reject(new VCSFetchError(`Timed out running: git ${args.join(" ")}`));
          return;
        }
        reject(new VCSFetchError(`git ${args[0]} failed: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * List remote git tags that are valid semver versions.
 * Runs `git ls-remote --tags <url>` and parses the output.
 */
export async function listRemoteVersionTags(
  cloneUrl: string,
): Promise<Array<[SemVer, string]>> {
  let stdout: string;
  try {
    stdout = await execGit(["ls-remote", "--tags", cloneUrl], 60_000);
  } catch (err) {
    if (err instanceof VCSFetchError) throw err;
    throw new VCSFetchError(`Failed to list remote tags from '${cloneUrl}': ${(err as Error).message}`);
  }

  const versionTags: Array<[SemVer, string]> = [];
  for (const line of stdout.trim().split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    const ref = parts[1]!;

    // Skip dereferenced tags
    if (ref.endsWith("^{}")) continue;

    // Extract tag name from refs/tags/...
    const tagName = ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : ref;
    const version = parseVersionTag(tagName);
    if (version !== null) {
      versionTags.push([version, tagName]);
    }
  }

  return versionTags;
}

/**
 * Select the minimum version matching a constraint from a list of tags (MVS).
 */
export function resolveVersionFromTags(
  versionTags: Array<[SemVer, string]>,
  versionConstraint: string,
): [SemVer, string] {
  if (versionTags.length === 0) {
    throw new VersionResolutionError(
      `No version tags available to satisfy constraint '${versionConstraint}'`,
    );
  }

  let constraint;
  try {
    constraint = parseConstraint(versionConstraint);
  } catch (err) {
    if (err instanceof SemVerError) {
      throw new VersionResolutionError(
        `Invalid version constraint '${versionConstraint}': ${err.message}`,
      );
    }
    throw err;
  }

  const versions = versionTags.map((entry) => entry[0]);
  const selected = selectMinimumVersion(versions, constraint);

  if (selected === null) {
    const availableStr = versionTags
      .map((entry) => entry[0])
      .sort((a, b) => a.compare(b))
      .map((ver) => ver.version)
      .join(", ");
    throw new VersionResolutionError(
      `No version satisfying '${versionConstraint}' found among: ${availableStr}`,
    );
  }

  for (const [ver, tagName] of versionTags) {
    if (ver.compare(selected) === 0) {
      return [selected, tagName];
    }
  }

  throw new VersionResolutionError(
    `Internal error: selected version ${selected.version} not found in tag list`,
  );
}

/**
 * Clone a git repository at a specific tag with depth 1.
 */
export async function cloneAtVersion(
  cloneUrl: string,
  versionTag: string,
  destination: string,
): Promise<void> {
  try {
    await execGit(
      ["clone", "--depth", "1", "--branch", versionTag, cloneUrl, destination],
      120_000,
    );
  } catch (err) {
    if (err instanceof VCSFetchError) throw err;
    throw new VCSFetchError(
      `Failed to clone '${cloneUrl}' at tag '${versionTag}': ${(err as Error).message}`,
    );
  }
}
