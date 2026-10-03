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
 *
 * The validate and inputs commands need only the `.mthds` text, but all of it:
 * `resolveBundleClosure` gathers every `.mthds` file of a target and its library
 * directories, so a method split across files validates on the API runner.
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { MthdsFileItem } from "./types.js";

/** File names (exact) that belong to a method bundle beyond the `.mthds`/`.py` set. */
const BUNDLE_FILE_NAMES: ReadonlySet<string> = new Set(["requirements.txt"]);
/** File extensions that belong to a method bundle. */
const BUNDLE_FILE_EXTENSIONS: readonly string[] = [".mthds", ".py"];
/**
 * Directories pipelex's library scan leaves out, its default `[interpreter.scan]
 * excluded_dirs`: virtual environments, caches, VCS data, dependencies and run
 * outputs. A virtual environment holding pipelex holds `.mthds` files of its own,
 * some deliberately invalid, so walking into one would send a method that is not
 * the caller's.
 */
const LIBRARY_SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  ".venv",
  "venv",
  "env",
  ".env",
  "virtualenv",
  ".virtualenv",
  ".git",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  "node_modules",
  "results",
]);

/**
 * The closure the API runner validates skips exactly what pipelex's library scan
 * skips, so it holds the files the pipelex runner loads from the same directories.
 */
function isSkippedLibraryDir(name: string): boolean {
  return LIBRARY_SKIP_DIR_NAMES.has(name);
}

/** A run bundle skips those and every other hidden directory, so nothing private travels with the method. */
function isSkippedBundleDir(name: string): boolean {
  return LIBRARY_SKIP_DIR_NAMES.has(name) || name.startsWith(".");
}

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

// `assertExclusiveRunSources` now lives in `protocol/options.ts`, beside the
// `RunRequest` shape whose invariant it enforces — it is a pure request-shape
// predicate, not runner logic, and downstream clients (`@pipelex/sdk`) consume
// it through the `mthds/protocol` subpath.

function isBundleFile(name: string): boolean {
  if (BUNDLE_FILE_NAMES.has(name)) return true;
  return BUNDLE_FILE_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function isMthdsFile(name: string): boolean {
  return name.endsWith(".mthds");
}

/**
 * Walk a method-bundle directory and collect every bundle file as a
 * `{ relativePath: text }` map. Relative paths are POSIX-normalized (the wire
 * form a runner materializes back to disk). Virtual environments, caches,
 * dependencies, run outputs and hidden directories are skipped so they never
 * travel with the method.
 */
export function collectBundleFiles(bundleDir: string): Record<string, string> {
  return collectFilesWhere(bundleDir, isBundleFile, isSkippedBundleDir);
}

/**
 * Walk a directory and collect every file whose name `wanted` accepts, as a
 * `{ relativePath: text }` map with POSIX separators, never entering a directory
 * whose name `skipped` accepts.
 */
function collectFilesWhere(
  bundleDir: string,
  wanted: (name: string) => boolean,
  skipped: (dirName: string) => boolean,
): Record<string, string> {
  const root = resolve(bundleDir);
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    // Sorted, so the map's order (and with it `pickMainBundleFile`'s fallback to the
    // first candidate) does not depend on the order the filesystem lists entries in.
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skipped(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile() && wanted(entry.name)) {
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

/** A target the bundle-closure resolver refuses: neither a `.mthds` file nor a directory holding one. */
export class BundleTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleTargetError";
  }
}

/** What a `validate` or `inputs` command names: a path, or inline `--content`. */
export type BundleTarget = { path: string } | { content: string };

/**
 * The `.mthds` files a per-bundle API route (`/v1/validate`, `/v1/build/inputs`)
 * receives for one command line: the closure the pipelex runner loads locally.
 */
export interface BundleClosure {
  /** Every `.mthds` file of the closure as `{ content, source }`, the entrypoint first. */
  files: MthdsFileItem[];
  /**
   * True when the caller gave the entrypoint itself, a `.mthds` file or inline
   * content, and false when it is a directory target's main file, inferred by
   * `pickMainBundleFile`.
   */
  entryNamed: boolean;
}

/**
 * Resolve a `validate` or `inputs` target and its library directories (`-L`) into
 * the closure the API runner sends, so a method split across several `.mthds`
 * files validates as it does on the pipelex runner:
 *
 * - a **directory** target contributes every `.mthds` file under it, its main file
 *   first;
 * - a **`.mthds` file** target contributes itself, first. A sibling file joins the
 *   closure only through a library directory, as on the pipelex runner, so
 *   validating one method never drags in an unrelated method stored beside it;
 * - **inline content** contributes itself, first, with no source;
 * - each **library directory** contributes every `.mthds` file under it.
 *
 * A directory walk skips the directories pipelex's library scan skips, its
 * virtual environments, caches and run outputs among them, and only those.
 *
 * The entrypoint goes first because the runner takes the first file declaring a
 * `main_pipe` as the closure's primary one. A file reached twice, as in the hook's
 * `validate bundle <file> -L <its dir>/`, is sent once, under the path it was first
 * reached by. Each `source` is the target or library directory as the caller wrote
 * it, joined with the file's place inside it, so a diagnostic names a file the
 * caller recognises.
 *
 * Throws `BundleTargetError` for a target that is neither a `.mthds` file nor a
 * directory holding one, and lets a filesystem error (a missing target, an
 * unreadable library directory) propagate.
 */
export function resolveBundleClosure(
  target: BundleTarget,
  libraryDirs: readonly string[] = [],
): BundleClosure {
  const files: MthdsFileItem[] = [];
  const seen = new Set<string>();
  const add = (path: string, content: string): void => {
    const key = realpathSync(path);
    if (seen.has(key)) return;
    seen.add(key);
    files.push({ content, source: path });
  };

  let entryNamed: boolean;
  if ("content" in target) {
    files.push({ content: target.content });
    entryNamed = true;
  } else if (statSync(target.path).isDirectory()) {
    const contents = collectFilesWhere(target.path, isMthdsFile, isSkippedLibraryDir);
    const rels = Object.keys(contents);
    if (rels.length === 0) {
      throw new BundleTargetError(`No .mthds file found in bundle directory: ${target.path}`);
    }
    const main = pickMainBundleFile(contents);
    for (const rel of [main, ...rels.filter((other) => other !== main)]) {
      add(join(target.path, rel), contents[rel]!);
    }
    entryNamed = false;
  } else {
    if (!target.path.endsWith(".mthds")) {
      throw new BundleTargetError(`'${target.path}' is not a .mthds file or a directory.`);
    }
    add(target.path, readFileSync(target.path, "utf-8"));
    entryNamed = true;
  }

  for (const dir of libraryDirs) {
    const contents = collectFilesWhere(dir, isMthdsFile, isSkippedLibraryDir);
    for (const [rel, content] of Object.entries(contents)) {
      add(join(dir, rel), content);
    }
  }
  return { files, entryNamed };
}
