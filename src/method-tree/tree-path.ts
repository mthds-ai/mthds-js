/**
 * Tree paths, the names of a method tree's files (mthds/docs/spec/method-tree.md, "Tree Paths"):
 * the rule a path must satisfy, the UTF-8 byte order paths are sorted in, and the collision rule,
 * which compares paths by their Unicode full case folding.
 */

import { caseFold } from "./case-folding.js";

/** The longest segment a tree path may hold, in bytes of UTF-8. */
export const MAX_SEGMENT_BYTES = 255;

/** The longest tree path, in bytes of UTF-8. */
export const MAX_TREE_PATH_BYTES = 1024;

const LONE_SURROGATE = /[\uD800-\uDFFF]/u;
const CONTROL_CHARACTER = /\p{Cc}/u;

const encoder = new TextEncoder();

/** The number of bytes `text` takes in UTF-8. */
export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** Whether `text` holds a code point UTF-8 cannot encode, which in JavaScript is a lone surrogate. */
export function holdsLoneSurrogate(text: string): boolean {
  return LONE_SURROGATE.test(text);
}

/** Whether `text` holds a character of Unicode general category `Cc`. */
export function holdsControlCharacter(text: string): boolean {
  return CONTROL_CHARACTER.test(text);
}

/**
 * Why `candidate` is not a tree path, or `null` when it is one. The checks run in the order the
 * conformance corpus's generator runs them, so the reason given matches theirs, though only the
 * verdict is part of the contract.
 */
export function treePathViolation(candidate: string): string | null {
  if (candidate === "") return "the path is empty";
  if (holdsLoneSurrogate(candidate)) return "the path holds a code point UTF-8 cannot encode";
  if (candidate.startsWith("/") || candidate.endsWith("/")) {
    return "the path starts or ends with '/'";
  }
  for (const segment of candidate.split("/")) {
    if (segment === "") return "the path holds an empty segment";
    if (segment === "." || segment === "..") return `the path holds the segment '${segment}'`;
    if (segment.includes("\\")) return "the path holds a backslash";
    if (segment.includes(":")) return "the path holds a colon";
    if (holdsControlCharacter(segment)) return "the path holds a control character";
    if (utf8Length(segment) > MAX_SEGMENT_BYTES) {
      return `a segment is longer than ${MAX_SEGMENT_BYTES} bytes`;
    }
  }
  if (candidate.normalize("NFC") !== candidate) {
    return "the path is not in Unicode Normalization Form C";
  }
  if (utf8Length(candidate) > MAX_TREE_PATH_BYTES) {
    return `the path is longer than ${MAX_TREE_PATH_BYTES} bytes`;
  }
  return null;
}

/** Whether `candidate` is a tree path. */
export function isTreePath(candidate: string): boolean {
  return treePathViolation(candidate) === null;
}

/**
 * Compare two strings byte for byte on their UTF-8 encoding, the order tree paths are sorted in.
 * JavaScript's own string order compares UTF-16 code units, which puts a character above U+FFFF
 * before one between U+E000 and U+FFFF, where UTF-8 puts it after.
 */
export function compareUtf8(left: string, right: string): number {
  if (left === right) return 0;
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

/** The directories a tree path names, outermost first: `a/b/c` names `a` and `a/b`. */
export function directoriesOf(treePath: string): string[] {
  const segments = treePath.split("/");
  const directories: string[] = [];
  for (let depth = 1; depth < segments.length; depth += 1) {
    directories.push(segments.slice(0, depth).join("/"));
  }
  return directories;
}

/**
 * The paths that collide: those equal to another once case-folded, and those naming, once
 * case-folded, a directory of another, together with the paths under that directory. Sorted byte
 * for byte, each named once.
 */
export function pathCollisions(treePaths: readonly string[]): string[] {
  const byFolded = new Map<string, Set<string>>();
  const underFoldedDirectory = new Map<string, Set<string>>();
  for (const treePath of treePaths) {
    const folded = caseFold(treePath);
    const group = byFolded.get(folded) ?? new Set<string>();
    group.add(treePath);
    byFolded.set(folded, group);
    for (const directory of directoriesOf(treePath)) {
      const foldedDirectory = caseFold(directory);
      const under = underFoldedDirectory.get(foldedDirectory) ?? new Set<string>();
      under.add(treePath);
      underFoldedDirectory.set(foldedDirectory, under);
    }
  }
  const colliding = new Set<string>();
  for (const group of byFolded.values()) {
    if (group.size > 1) for (const treePath of group) colliding.add(treePath);
  }
  for (const treePath of treePaths) {
    const under = underFoldedDirectory.get(caseFold(treePath));
    if (under !== undefined && under.size > 0) {
      colliding.add(treePath);
      for (const other of under) colliding.add(other);
    }
  }
  return [...colliding].sort(compareUtf8);
}
