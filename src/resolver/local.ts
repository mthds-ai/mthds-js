import { resolve, join } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import type { ResolvedRepo, ResolvedMethod, SkippedMethod, MethodsFile } from "./types.js";
import { validateManifest } from "./validate.js";
import { validateSlug } from "./validate.js";

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

export function resolveFromLocal(dirPath: string): ResolvedRepo {
  const absPath = resolve(dirPath);

  // Check directory exists
  try {
    const stat = statSync(absPath);
    if (!stat.isDirectory()) {
      throw new Error(`"${absPath}" is not a directory.`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Directory not found: ${absPath}`);
    }
    throw err;
  }

  // Look for methods/ folder
  const methodsDir = join(absPath, "methods");
  try {
    const stat = statSync(methodsDir);
    if (!stat.isDirectory()) {
      throw new Error(`No methods/ folder found in ${absPath}. Expected a "methods/" directory.`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`No methods/ folder found in ${absPath}. Expected a "methods/" directory.`);
    }
    throw err;
  }

  // List subdirectories in methods/
  const entries = readdirSync(methodsDir, { encoding: "utf-8" });
  const slugDirs: string[] = [];

  for (const entry of entries) {
    const entryPath = join(methodsDir, entry);
    try {
      if (statSync(entryPath).isDirectory()) {
        slugDirs.push(entry);
      }
    } catch {
      // Skip entries that can't be stat'd
    }
  }

  if (slugDirs.length === 0) {
    throw new Error(`No methods found in methods/ of ${absPath}.`);
  }

  const methods: ResolvedMethod[] = [];
  const skipped: SkippedMethod[] = [];

  for (const slug of slugDirs) {
    // Validate slug name
    const slugResult = validateSlug(slug);
    if (!slugResult.valid) {
      skipped.push({ slug, errors: [slugResult.error!] });
      continue;
    }

    const slugDir = join(methodsDir, slug);
    const tomlPath = join(slugDir, "METHODS.toml");

    // Read METHODS.toml
    let rawToml: string;
    try {
      rawToml = readFileSync(tomlPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        skipped.push({ slug, errors: [`No METHODS.toml found at ${tomlPath}.`] });
      } else {
        skipped.push({ slug, errors: [`Cannot read METHODS.toml: ${(err as Error).message}`] });
      }
      continue;
    }

    // Validate manifest
    const result = validateManifest(rawToml);
    if (!result.valid || !result.manifest) {
      skipped.push({ slug, errors: result.errors });
      continue;
    }

    // Collect .mthds files
    const files = collectMthdFiles(slugDir);

    methods.push({
      slug,
      manifest: result.manifest,
      rawManifest: rawToml,
      files,
    });
  }

  // Derive repoName from directory basename
  const repoName = absPath.split("/").pop() ?? "local";

  return {
    methods,
    skipped,
    source: "local",
    repoName,
  };
}
