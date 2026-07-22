/**
 * Method-bundle collection and materialization.
 *
 * A custom-PipeFunc method is a directory: a `.mthds` file plus the Python it
 * references (`funcs/*.py`, `structures/*.py`) and an optional
 * `requirements.txt`. The pure MTHDS Protocol only carries the `.mthds` text
 * (`mthds_contents`), so that Python never reaches a runner. The pipelex-api
 * bundle extension fixes this: the whole directory travels as a
 * `{ relativePath: text }` map (`files`), which a runner materializes into a
 * temporary library directory before the run.
 *
 * This module is the universal bundle representation shared by every runner:
 *  - the CLI resolves a run target into `files` (or plain `mthds_contents`);
 *  - the API runner ships `files` over the wire;
 *  - the pipelex runner writes `files` back to a temp dir and runs it locally.
 *
 * A plain `.mthds` file with no custom Python stays on the lighter
 * `mthds_contents` path — nothing changes for the common case.
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/** File names (exact) that belong to a method bundle beyond the `.mthds`/`.py` set. */
const BUNDLE_FILE_NAMES: ReadonlySet<string> = new Set(["requirements.txt"]);
/** File extensions that belong to a method bundle. */
const BUNDLE_FILE_EXTENSIONS: readonly string[] = [".mthds", ".py"];
/** Directories never shipped as part of a bundle (caches, deps, hidden/VCS). */
const SKIP_DIR_NAMES: ReadonlySet<string> = new Set(["__pycache__", "node_modules"]);

/** How a run target resolved: either an inline `.mthds` or a full bundle map. */
export interface ResolvedRunBundle {
  /** The bundle as a `{ relativePath: text }` map (POSIX separators). */
  files?: Record<string, string>;
  /** The single `.mthds` text, when the target carries no custom Python. */
  mthds_contents?: string[];
}

function isBundleFile(name: string): boolean {
  if (BUNDLE_FILE_NAMES.has(name)) return true;
  return BUNDLE_FILE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * Walk a method-bundle directory and collect every bundle file as a
 * `{ relativePath: text }` map. Relative paths are POSIX-normalized (the wire
 * form a runner materializes back to disk). Cache/deps/hidden directories are
 * skipped so they never travel with the method.
 */
export function collectBundleFiles(bundleDir: string): Record<string, string> {
  const root = resolve(bundleDir);
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(abs);
      } else if (entry.isFile() && isBundleFile(entry.name)) {
        const rel = relative(root, abs).split(sep).join("/");
        files[rel] = readFileSync(abs, "utf-8");
      }
    }
  };
  walk(root);
  return files;
}

/** Does the bundle carry custom Python (a `.py` or a `requirements.txt`)? */
export function hasCustomPython(files: Record<string, string>): boolean {
  return Object.keys(files).some(
    (rel) => rel.endsWith(".py") || rel === "requirements.txt" || rel.endsWith("/requirements.txt"),
  );
}

/**
 * Pick the main `.mthds` file of a bundle — the one a runner should point
 * `run bundle` at. Prefers a root-level `.mthds` that declares a `main_pipe`,
 * then any root-level `.mthds`, then the first `.mthds` found.
 */
export function pickMainBundleFile(files: Record<string, string>): string {
  const mthdsFiles = Object.keys(files).filter((rel) => rel.endsWith(".mthds"));
  if (mthdsFiles.length === 0) {
    throw new Error("Method bundle contains no .mthds file.");
  }
  const rootLevel = mthdsFiles.filter((rel) => !rel.includes("/"));
  const candidates = rootLevel.length > 0 ? rootLevel : mthdsFiles;
  const withMainPipe = candidates.find((rel) => /(^|\n)\s*main_pipe\s*=/.test(files[rel] ?? ""));
  return withMainPipe ?? candidates[0]!;
}

/**
 * Write a bundle's `{ relativePath: text }` map into `targetDir`, recreating the
 * directory structure (so `funcs/*.py` land under `funcs/`). Returns the
 * absolute path of the bundle's main `.mthds` file — what a local runner points
 * `run bundle` at, with `targetDir` as its library directory.
 */
export function materializeBundleFiles(targetDir: string, files: Record<string, string>): string {
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(targetDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, "utf-8");
  }
  return join(targetDir, pickMainBundleFile(files));
}

/**
 * Resolve a `run bundle` / `run pipe` target into run options.
 *
 * - **Directory** → the whole directory is a method bundle; ship it as `files`.
 * - **`.mthds` file whose directory carries custom Python** → ship the
 *   containing directory as `files`, so the `funcs/*.py` travel with the method.
 * - **plain `.mthds` file** → the classic single-content path (`mthds_contents`).
 *
 * Throws (via `statSync`) if the target does not exist, and with a clear message
 * if a directory has no `.mthds`.
 */
export function resolveRunBundle(target: string): ResolvedRunBundle {
  const resolved = resolve(target);
  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    const files = collectBundleFiles(resolved);
    if (!Object.keys(files).some((rel) => rel.endsWith(".mthds"))) {
      throw new Error(`No .mthds file found in bundle directory: ${resolved}`);
    }
    return { files };
  }
  const siblingFiles = collectBundleFiles(dirname(resolved));
  if (hasCustomPython(siblingFiles)) {
    return { files: siblingFiles };
  }
  return { mthds_contents: [readFileSync(resolved, "utf-8")] };
}
