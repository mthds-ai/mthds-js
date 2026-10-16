/**
 * Writing a method tree to disk for the local pipelex runner, and gathering the
 * `.mthds` closure of the inputs commands.
 *
 * A method travels as its tree, the protocol's `files` map (`method-target.ts`
 * resolves what a command line names into one). The local pipelex runner reads
 * files from disk, so `materializeMethodFiles` writes such a map back into a
 * directory of its own, its Python, templates and other files beside its
 * bundles; pipelex then lists that directory and chooses the bundle to start at.
 *
 * `/v1/pipe-io` still takes `.mthds` files alone, not trees: `resolveBundleClosure`
 * gathers every `.mthds` file of an inputs target and its library directories, so
 * a method split across files gets its inputs template on the API runner.
 */

import {
  type Dirent,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { FileEntry, MethodFiles } from "../protocol/file_entries.js";
import { PipelineRequestError } from "../protocol/exceptions.js";
import { decodeCanonicalBase64 } from "../method-tree/file-entries.js";
import { treePathViolation } from "../method-tree/tree-path.js";
import { readBundleMeta } from "./pipe-ref.js";
import type { MthdsFileItem } from "./types.js";

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
 * The closure the inputs commands send skips exactly what pipelex's library scan
 * skips, so it holds the files the pipelex runner loads from the same directories.
 */
function isSkippedLibraryDir(name: string): boolean {
  return LIBRARY_SKIP_DIR_NAMES.has(name);
}

function isMthdsFile(name: string): boolean {
  return name.endsWith(".mthds");
}

/** Errors meaning this user may not list a directory. */
const UNREADABLE_DIR_ERRORS: ReadonlySet<string> = new Set(["EACCES", "EPERM"]);

/**
 * Walk a directory and collect every file whose name `wanted` accepts, as a
 * `{ relativePath: text }` map with POSIX separators, never entering a directory
 * whose name `skipped` accepts. A folder below the root that this user may not
 * list is skipped, as pipelex's library scan (`Path.rglob`) skips it, so one
 * root-owned folder in a project does not fail every walk of it; the root's own
 * error still reaches the caller.
 */
function collectFilesWhere(
  bundleDir: string,
  wanted: (name: string) => boolean,
  skipped: (dirName: string) => boolean,
): Record<string, string> {
  const root = resolve(bundleDir);
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    let dirents: Dirent[];
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (dir !== root && code !== undefined && UNREADABLE_DIR_ERRORS.has(code)) return;
      throw err;
    }
    // Sorted, so the closure's order does not depend on the order the filesystem
    // lists entries in.
    const entries = dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
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

/**
 * Resolve a tree path to an absolute path GUARANTEED to stay under `root`, or
 * throw. A `files` map reaches this from the public `RunOptions.files` (a
 * programmatic caller can put anything there), so a key like `../../outside` or
 * an absolute path must never let `writeFileSync` clobber a file elsewhere with
 * the process's permissions. A key that is not a tree path is refused first, as a
 * runner refuses it.
 */
function resolveSafeBundlePath(root: string, rel: string): string {
  const violation = treePathViolation(rel);
  if (violation !== null) {
    throw new PipelineRequestError(
      `The key ${JSON.stringify(rel)} of the method's files is not a tree path: ${violation}.`,
    );
  }
  const abs = resolve(root, ...rel.split("/"));
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new PipelineRequestError(
      `Unsafe file path ${JSON.stringify(rel)}: it escapes the method's directory.`,
    );
  }
  return abs;
}

/** The bytes of an inline entry, refusing a hash entry, which only a blob store resolves. */
function entryBytes(treePath: string, entry: FileEntry): string | Uint8Array {
  if (typeof entry === "string") return entry;
  if (entry !== null && typeof entry === "object" && "base64" in entry) {
    const bytes = decodeCanonicalBase64(entry.base64);
    if (bytes === null) {
      throw new PipelineRequestError(
        `The entry of '${treePath}' is not canonical padded standard Base64.`,
      );
    }
    return bytes;
  }
  throw new PipelineRequestError(
    `The local pipelex runner keeps no blob store, so it cannot resolve the hash entry of '${treePath}'. Send the file inline, or pass the method as a tree.`,
  );
}

/**
 * Write a method's `files` map into `targetDir`, recreating its directories (so
 * `funcs/*.py` land under `funcs/`) and writing each file's exact bytes: a text
 * entry as UTF-8, a Base64 entry decoded. `targetDir` is the tree's root and holds
 * nothing else, so no file a run writes can land on a file of the method. Every key
 * is checked before any write, so a key that is not a tree path, or that would
 * escape `targetDir`, is refused instead of written, and so is a hash entry, which
 * needs a blob store.
 */
export function materializeMethodFiles(targetDir: string, files: MethodFiles): void {
  const root = resolve(targetDir);
  const writes = Object.entries(files).map(
    ([rel, entry]) => [resolveSafeBundlePath(root, rel), entryBytes(rel, entry)] as const,
  );
  mkdirSync(root, { recursive: true });
  for (const [abs, bytes] of writes) {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
}

/** A target the bundle-closure resolver refuses: neither a `.mthds` file nor a directory holding one. */
export class BundleTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleTargetError";
  }
}

/** What an `inputs` command names: a path, or inline `--content`. */
export type BundleTarget = { path: string } | { content: string };

/**
 * The `.mthds` files `/v1/pipe-io` receives for one command line, which takes
 * `.mthds` files alone rather than a method's tree: the closure the pipelex runner
 * loads locally.
 */
export interface BundleClosure {
  /**
   * Every `.mthds` file of the closure as `{ content, source }`, the entry first:
   * the named file, the inline content, or a directory target's entry file.
   */
  files: MthdsFileItem[];
}

/** The file the pipelex runner takes as a directory target's entry when it exists. */
const DEFAULT_BUNDLE_FILE_NAME = "bundle.mthds";

/**
 * The entry file of a directory target, chosen as the pipelex runner chooses it
 * (`resolve_bundle_target_core`), so the closure's first file, and the pipe an
 * `inputs` template defaults to, are the ones the pipelex runner would use:
 * `bundle.mthds` at the directory's root, else the only `.mthds` file there. Like
 * the pipelex runner, it refuses a directory with no `.mthds` file at its root or
 * several and no `bundle.mthds`, and a `bundle.mthds` that is a symbolic link,
 * which it will not take as an entry it was not named.
 */
function pickDirectoryEntry(dir: string, contents: Record<string, string>): string {
  if (lstatSync(join(dir, DEFAULT_BUNDLE_FILE_NAME), { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new BundleTargetError(
      `Refusing to take the symbolic link ${join(dir, DEFAULT_BUNDLE_FILE_NAME)} as the entry of a bundle directory. Name the entry file, with the directory as -L.`,
    );
  }
  const rootFiles = Object.keys(contents).filter((rel) => !rel.includes("/"));
  if (rootFiles.includes(DEFAULT_BUNDLE_FILE_NAME)) return DEFAULT_BUNDLE_FILE_NAME;
  if (rootFiles.length === 0) {
    throw new BundleTargetError(`No .mthds file found at the root of bundle directory: ${dir}`);
  }
  if (rootFiles.length > 1) {
    throw new BundleTargetError(
      `Several .mthds files at the root of bundle directory ${dir} and no ${DEFAULT_BUNDLE_FILE_NAME} (${rootFiles.join(", ")}). Name the entry file, with the directory as -L.`,
    );
  }
  return rootFiles[0]!;
}

/**
 * Resolve an `inputs` target and its library directories (`-L`) into the closure
 * the API runner sends to `/v1/pipe-io`, so a method split across several `.mthds`
 * files gets its template as it does on the pipelex runner:
 *
 * - a **directory** target contributes every `.mthds` file under it, its entry file
 *   first, chosen by `pickDirectoryEntry` as the pipelex runner chooses it;
 * - a **`.mthds` file** target contributes itself, first. A sibling file joins the
 *   closure only through a library directory, as on the pipelex runner, so
 *   describing one method never drags in an unrelated method stored beside it;
 * - **inline content** contributes itself, first, with no source;
 * - each **library directory** contributes every `.mthds` file under it.
 *
 * A directory walk skips the directories pipelex's library scan skips, its
 * virtual environments, caches and run outputs among them, and only those.
 *
 * The entry goes first, and since `/v1/pipe-io` takes no cue from the order, the
 * inputs commands also name the entry's own pipe (`closureEntryPipeRef`). A file
 * reached twice, as in `inputs bundle <file> -L <its dir>/`, is sent once, under the path it
 * was first reached by. Each `source` is the target or library directory as the
 * caller wrote it, joined with the file's place inside it, so a diagnostic names a
 * file the caller recognises.
 *
 * Throws `BundleTargetError` for a target that is neither a `.mthds` file nor a
 * directory whose entry file can be chosen, and lets a filesystem error (a missing
 * target, an unreadable library directory) propagate.
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

  if ("content" in target) {
    files.push({ content: target.content });
  } else if (statSync(target.path).isDirectory()) {
    const contents = collectFilesWhere(target.path, isMthdsFile, isSkippedLibraryDir);
    const entry = pickDirectoryEntry(target.path, contents);
    for (const rel of [entry, ...Object.keys(contents).filter((other) => other !== entry)]) {
      add(join(target.path, rel), contents[rel]!);
    }
  } else {
    if (!target.path.endsWith(".mthds")) {
      throw new BundleTargetError(`'${target.path}' is not a .mthds file or a directory.`);
    }
    add(target.path, readFileSync(target.path, "utf-8"));
  }

  for (const dir of libraryDirs) {
    const contents = collectFilesWhere(dir, isMthdsFile, isSkippedLibraryDir);
    for (const [rel, content] of Object.entries(contents)) {
      add(join(dir, rel), content);
    }
  }
  return { files };
}

/**
 * The pipe an inputs command asks for when `--pipe` is omitted. When the closure
 * holds several files, it is the entry's own `main_pipe`, qualified with its domain:
 * the named file's, the inline content's, or a directory target's entry file's, the
 * pipe the pipelex runner templates. Left to the runner's selection chain, a closure
 * declaring a `main_pipe` in several domains would be refused as ambiguous, and one
 * declaring it elsewhere than the entry would be answered for another pipe. With the
 * entry alone, or an entry declaring no `main_pipe`, the choice is left to the chain.
 */
export function closureEntryPipeRef(closure: BundleClosure): string | undefined {
  if (closure.files.length < 2) return undefined;
  const { domain, mainPipe } = readBundleMeta(closure.files[0]!.content);
  return domain && mainPipe ? `${domain}.${mainPipe}` : undefined;
}
