/**
 * The membership rule's defaults (mthds/docs/spec/method-tree.md, "The Membership Rule"): the names
 * that keep a file out of every tree whatever its patterns say. The lister applies them to what it
 * walks, as a sender does, and the map reader to the keys it is sent, as a receiver does; both read
 * them from here, so the two cannot drift apart.
 */

import type { ExclusionRule } from "./exceptions.js";

export const MANIFEST_NAME = "METHODS.toml";
export const GIT_ENTRY_NAME = ".git";
export const VENV_MARKER_NAME = "pyvenv.cfg";
export const GITIGNORE_NAME = ".gitignore";

/** The directories excluded by their name alone. */
export const DEFAULT_EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "__pycache__",
  "node_modules",
]);

/**
 * The names of a run's inputs file, which the run-inputs default keeps out of every tree at any
 * depth when the entry is a regular file or a symbolic link, never followed. They match byte for
 * byte, so `Inputs.json` is an ordinary member, and a directory of either name excludes nothing.
 */
export const RUN_INPUTS_NAMES: ReadonlySet<string> = new Set(["inputs.json", "inputs.toml"]);

/**
 * The rules that exclude a directory for an entry it holds, in the order they are named when
 * several apply.
 */
export const MARKER_RULES: readonly ExclusionRule[] = [
  "virtual_environment",
  "nested_repository",
  "nested_package",
];

/** What an entry is, read without following a symbolic link. */
export type EntryKind = "file" | "directory" | "symlink" | "other";

/** What an `lstat` result or a `readdir` entry is, never following a link. */
export function entryKindOf(entry: {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
}): EntryKind {
  if (entry.isSymbolicLink()) return "symlink";
  if (entry.isFile()) return "file";
  if (entry.isDirectory()) return "directory";
  return "other";
}

/** Whether a name starts with a dot, which keeps it, and everything under it, out of a tree. */
export function isDotSegment(name: string): boolean {
  return name.startsWith(".");
}

/** Whether a directory of this name is excluded by its name alone. */
export function isDefaultExcludedDirectory(name: string): boolean {
  return DEFAULT_EXCLUDED_DIRECTORY_NAMES.has(name);
}

/**
 * Whether an entry of this name and kind is a run's inputs file, which the run-inputs default keeps
 * out of every tree: one named `inputs.json` or `inputs.toml` that is a regular file or a symbolic
 * link, the link never followed. A directory of either name is an ordinary directory, and any other
 * entry, such as a named pipe, is left for the walk to refuse.
 */
export function isRunInputsFile(name: string, kind: EntryKind): boolean {
  return RUN_INPUTS_NAMES.has(name) && (kind === "file" || kind === "symlink");
}

/**
 * The rule an entry of this name and kind makes its directory fall under, or `null`: a
 * `pyvenv.cfg` file or link marks a virtual environment, a `.git` entry of any kind a nested
 * repository, and a `METHODS.toml` file a nested package. `belowRoot` is false for the root itself,
 * whose `.git` entry and manifest exclude nothing.
 */
export function markerRule(
  name: string,
  kind: EntryKind,
  belowRoot: boolean,
): ExclusionRule | null {
  if (name === VENV_MARKER_NAME && (kind === "file" || kind === "symlink")) {
    return "virtual_environment";
  }
  if (!belowRoot) return null;
  if (name === GIT_ENTRY_NAME) return "nested_repository";
  if (name === MANIFEST_NAME && kind === "file") return "nested_package";
  return null;
}

/** Whether a rule excludes a directory for an entry it holds rather than for its name or a pattern. */
export function isMarkerRule(rule: ExclusionRule): boolean {
  return MARKER_RULES.includes(rule);
}

/**
 * Whether a tree path names a file the defaults could never admit to a tree: one with a segment
 * starting with a dot, one inside a `__pycache__` or `node_modules` directory, one named as a run's
 * inputs file, `inputs.json` or `inputs.toml`, at any depth, or one whose own name marks its
 * directory as excluded, such as a `pyvenv.cfg` or a `METHODS.toml` below the root.
 */
export function isExcludedName(treePath: string): boolean {
  const segments = treePath.split("/");
  const name = segments[segments.length - 1]!;
  if (segments.some(isDotSegment)) return true;
  if (segments.slice(0, -1).some(isDefaultExcludedDirectory)) return true;
  if (isRunInputsFile(name, "file")) return true;
  return markerRule(name, "file", segments.length > 1) !== null;
}

/** Whether an `exclude` pattern of a manifest is acceptable: one pattern, holding no line break. */
export function isValidExcludePattern(pattern: string): boolean {
  return !/[\n\r]/.test(pattern);
}
