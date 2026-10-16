import { resolve, join, basename } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import type {
  ResolvedRepo,
  ResolvedMethod,
  SkippedMethod,
  MethodsFile,
} from "../../package/manifest/types.js";
import { validateManifest } from "../../package/manifest/validate.js";
import { MethodResolveError } from "./exceptions.js";

/** The system's error code of `err`, such as `ENOENT`, when it carries one. */
function fsErrorCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** A path the system refused to read for another reason than its absence, as a resolve failure. */
function unreadablePath(path: string, err: unknown): MethodResolveError {
  const reason = err instanceof Error ? err.message : String(err);
  return new MethodResolveError(`Cannot read ${path}: ${reason}`, "unreadable", {
    cause: err,
    path,
    fsCode: fsErrorCode(err),
  });
}

function collectMthdFiles(dirPath: string): MethodsFile[] {
  const entries = readdirSync(dirPath, { recursive: true, encoding: "utf-8" });
  const files: MethodsFile[] = [];

  for (const entry of entries) {
    if (typeof entry === "string" && entry.endsWith(".mthds")) {
      const fullPath = resolve(dirPath, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) {
          files.push({
            relativePath: entry,
            content: readFileSync(fullPath, "utf-8"),
          });
        }
      } catch {
        // Skip files that can't be read
      }
    }
  }

  return files;
}

/**
 * Resolve the methods of a local directory's `methods/` folder. Throws a `MethodResolveError`:
 * `not_found` when the directory or its `methods/` folder is missing or holds no method, and
 * `unreadable` when the system refuses to read one of them for another reason, such as `EACCES`.
 */
export function resolveFromLocal(dirPath: string): ResolvedRepo {
  const absPath = resolve(dirPath);

  // Check directory exists
  let isDirectory: boolean;
  try {
    isDirectory = statSync(absPath).isDirectory();
  } catch (err) {
    if (fsErrorCode(err) === "ENOENT") {
      throw new MethodResolveError(`Directory not found: ${absPath}`, "not_found", { cause: err });
    }
    throw unreadablePath(absPath, err);
  }
  if (!isDirectory) {
    throw new MethodResolveError(`"${absPath}" is not a directory.`, "not_found");
  }

  // Look for methods/ folder
  const methodsDir = join(absPath, "methods");
  const noMethodsFolder = `No methods/ folder found in ${absPath}. Expected a "methods/" directory.`;
  let hasMethodsFolder: boolean;
  try {
    hasMethodsFolder = statSync(methodsDir).isDirectory();
  } catch (err) {
    if (fsErrorCode(err) === "ENOENT") {
      throw new MethodResolveError(noMethodsFolder, "not_found", { cause: err });
    }
    throw unreadablePath(methodsDir, err);
  }
  if (!hasMethodsFolder) {
    throw new MethodResolveError(noMethodsFolder, "not_found");
  }

  // List subdirectories in methods/
  let entries: string[];
  try {
    entries = readdirSync(methodsDir, { encoding: "utf-8" });
  } catch (err) {
    throw unreadablePath(methodsDir, err);
  }
  const methodDirs: string[] = [];

  for (const entry of entries) {
    const entryPath = join(methodsDir, entry);
    try {
      if (statSync(entryPath).isDirectory()) {
        methodDirs.push(entry);
      }
    } catch {
      // Skip entries that can't be stat'd
    }
  }

  if (methodDirs.length === 0) {
    throw new MethodResolveError(`No methods found in methods/ of ${absPath}.`, "not_found");
  }

  const methods: ResolvedMethod[] = [];
  const skipped: SkippedMethod[] = [];

  for (const dirName of methodDirs) {
    const dirPath = join(methodsDir, dirName);
    const tomlPath = join(dirPath, "METHODS.toml");

    // Read METHODS.toml
    let rawToml: string;
    try {
      rawToml = readFileSync(tomlPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        skipped.push({ dirName, errors: [`No METHODS.toml found at ${tomlPath}.`] });
      } else {
        skipped.push({ dirName, errors: [`Cannot read METHODS.toml: ${(err as Error).message}`] });
      }
      continue;
    }

    // Validate manifest
    const result = validateManifest(rawToml);
    if (!result.valid || !result.manifest) {
      skipped.push({ dirName, errors: result.errors });
      continue;
    }

    // Ensure directory name matches the expected snake_case form of package.name
    const manifestName = result.manifest.package.name;
    if (manifestName) {
      const expectedDir = manifestName;
      if (expectedDir !== dirName) {
        skipped.push({
          dirName,
          errors: [
            `Directory "${dirName}" does not match [package.name] "${manifestName}". ` +
              `Expected directory name: "${expectedDir}".`,
          ],
        });
        continue;
      }
    }

    // Collect .mthds files
    const files = collectMthdFiles(dirPath);

    methods.push({
      name: result.manifest.package.name,
      manifest: result.manifest,
      rawManifest: rawToml,
      files,
    });
  }

  // Derive repoName from directory basename
  const repoName = basename(absPath) || "local";

  return {
    methods,
    skipped,
    source: "local",
    repoName,
    isPublic: false,
  };
}
