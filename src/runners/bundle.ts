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
import { parse as parseToml } from "smol-toml";
import { PipelineRequestError } from "../protocol/exceptions.js";
import type { RunRequest } from "../protocol/options.js";

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
  /**
   * The bundle-relative path of the `.mthds` the target selected — the run's
   * entrypoint. Set when the caller named a specific `.mthds` (so a directory
   * holding several methods doesn't let a runner re-guess and run a sibling),
   * and when a directory resolves to a single main. A local runner points
   * `run bundle` at exactly this file instead of inferring it from the map.
   */
  main?: string;
}

/**
 * Enforce the run-source exclusivity contract shared by every runner: a method
 * bundle is self-contained (`files` / `bundle_b64` carry their own `.mthds`),
 * so it cannot be combined with `mthds_contents`, and `files` / `bundle_b64`
 * are two encodings of one bundle. Exclusivity keys off PRESENCE, not emptiness
 * — a caller who supplies `files: {}` alongside `bundle_b64` still expressed two
 * encodings — while `mthds_contents` counts only when non-empty (an empty array
 * is "no contents"). Throws `PipelineRequestError`; both the API client and the
 * local runner call it so they reject the same combinations identically.
 */
export function assertExclusiveRunSources(options: RunRequest): void {
  const hasFiles = options.files != null;
  const hasZip = options.bundle_b64 != null;
  const hasContents = options.mthds_contents != null && options.mthds_contents.length > 0;
  if (hasFiles && hasZip) {
    throw new PipelineRequestError(
      "files and bundle_b64 are two encodings of the same bundle and are mutually exclusive; provide one.",
    );
  }
  if ((hasFiles || hasZip) && hasContents) {
    throw new PipelineRequestError(
      "A method bundle (files/bundle_b64) is self-contained; it cannot be combined with mthds_contents.",
    );
  }
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
 * Does a `.mthds` document declare a top-level `main_pipe` key? Parsed with the
 * same TOML parser the rest of the toolchain uses (a `.mthds` file IS TOML), so
 * a quoted key (`"main_pipe" = …`) or an unusual-but-valid layout is recognized
 * — a regex missed those and fell back to file order, which could point a runner
 * at the wrong method. A document that isn't valid TOML simply doesn't count as
 * declaring `main_pipe` (the entrypoint pick falls back to the first candidate).
 */
function declaresMainPipe(content: string): boolean {
  let parsed: unknown;
  try {
    parsed = parseToml(content);
  } catch {
    return false;
  }
  return typeof parsed === "object" && parsed !== null && "main_pipe" in parsed;
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
  const withMainPipe = candidates.find((rel) => declaresMainPipe(files[rel] ?? ""));
  return withMainPipe ?? candidates[0]!;
}

/**
 * Resolve a bundle-map key to an absolute path GUARANTEED to stay under `root`,
 * or throw. A `files` map reaches this from the public `RunOptions.files` (a
 * programmatic caller can put anything there), so a key like `../../outside` or
 * an absolute path must never let `writeFileSync` clobber a file elsewhere with
 * the process's permissions. Mirrors the runner-side path-safety guard in
 * `pipelex-api` (`_safe_relpath`), so both runners reject the same escapes.
 */
function resolveSafeBundlePath(root: string, rel: string): string {
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(
      `Unsafe bundle file path ${JSON.stringify(rel)}: it escapes the bundle directory.`,
    );
  }
  return abs;
}

/**
 * Write a bundle's `{ relativePath: text }` map into `targetDir`, recreating the
 * directory structure (so `funcs/*.py` land under `funcs/`). Returns the
 * absolute path of the bundle's main `.mthds` file — what a local runner points
 * `run bundle` at, with `targetDir` as its library directory.
 *
 * `main` (when given) is the caller-selected entrypoint's bundle-relative path;
 * it is honored verbatim rather than re-inferring the main from the map, so a
 * bundle holding several methods runs the one the caller named. It must be a
 * `.mthds` key present in `files`. Every key is validated to stay under
 * `targetDir` before any write, so a traversal (`..`) or absolute-path key is
 * rejected instead of escaping.
 */
export function materializeBundleFiles(
  targetDir: string,
  files: Record<string, string>,
  main?: string,
): string {
  const root = resolve(targetDir);
  for (const [rel, text] of Object.entries(files)) {
    const abs = resolveSafeBundlePath(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text, "utf-8");
  }
  const mainRel = main != null && main in files ? main : pickMainBundleFile(files);
  return join(targetDir, mainRel);
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
    // No file was named, so the entrypoint is inferred (main_pipe, then order).
    return { files, main: pickMainBundleFile(files) };
  }
  const parentDir = dirname(resolved);
  const siblingFiles = collectBundleFiles(parentDir);
  if (hasCustomPython(siblingFiles)) {
    // The caller named a specific `.mthds`; preserve it as the entrypoint so a
    // sibling method in the same directory can never be run in its place.
    const main = relative(parentDir, resolved).split(sep).join("/");
    return { files: siblingFiles, main };
  }
  return { mthds_contents: [readFileSync(resolved, "utf-8")] };
}
