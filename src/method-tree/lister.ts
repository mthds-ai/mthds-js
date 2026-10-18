/**
 * Listing a method tree (mthds/docs/spec/method-tree.md): finding the root from what a caller hands
 * over, walking it under the membership rule, refusing what the standard refuses, and hashing the
 * files into the tree digest.
 *
 * The walk prunes before it checks: a directory a rule excludes is never entered, so a symbolic
 * link, a `.gitignore` file or an invalid name inside it is never seen. It counts files and sums
 * their sizes from `lstat` as it goes, stopping at the first limit the caller set, before any file
 * is read. Names are read as bytes, sorted byte for byte, and normalized to NFC; the patterns of
 * `.gitignore` files and of `[package] exclude` match the UTF-8 bytes of those NFC names.
 */

import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { exactEntryKind, findManifestDirectory } from "./discovery.js";
import { treeDigest } from "./digest.js";
import {
  MethodTreeError,
  namesExcludedDirectory,
  TreeLimitExceededError,
  type ExclusionRule,
  type TreeRefusalCode,
} from "./exceptions.js";
import { readMember } from "./file-reading.js";
import {
  excludingSource,
  parseExcludePatterns,
  parseGitignore,
  type PatternList,
} from "./gitignore.js";
import {
  entryKindOf,
  GITIGNORE_NAME,
  isDefaultExcludedDirectory,
  isDotSegment,
  isMarkerRule,
  isRunInputsFile,
  isValidExcludePattern,
  MANIFEST_NAME,
  MARKER_RULES,
  markerRule,
  type EntryKind,
} from "./membership.js";
import { compareUtf8, directoriesOf, pathCollisions, treePathViolation } from "./tree-path.js";
import { MethodTree, type MethodTreeFile, type RecordedExclusion } from "./tree.js";

/**
 * The limits a caller sets on a tree, each its own policy: a file's size and a tree's file count
 * and total size, in bytes for the sizes. A tree past one is refused while it is listed, before
 * any file is hashed, with a `TreeLimitExceededError` naming the root, the limit and the count.
 */
export interface MethodTreeLimits {
  readonly maxFileSize?: number;
  readonly maxFileCount?: number;
  readonly maxTotalSize?: number;
}

export interface ListMethodTreeOptions {
  readonly limits?: MethodTreeLimits;
  /**
   * Whether to find the root by Manifest Discovery, the default. `false` roots the tree at the
   * directory handed over, as a dependency's tree is rooted at its package directory whatever lies
   * above it; a lone file still has its root discovered.
   */
  readonly discover?: boolean;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const SEPARATOR = Buffer.from(sep);
const SLASH = Buffer.from("/");
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lenientUtf8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** One entry of a directory, as the walk reads it. */
interface ListedEntry {
  readonly nameBytes: Buffer;
  /** The name in NFC, or decoded with replacement characters when its bytes are not UTF-8. */
  readonly name: string;
  /** The name as the file system holds it, decoded. */
  readonly rawName: string;
  readonly validUtf8: boolean;
  /** The bytes patterns match: the NFC name's UTF-8, or the raw bytes when they are not UTF-8. */
  readonly matchBytes: Buffer;
  readonly kind: EntryKind;
}

/** A directory being walked. */
interface WalkedDirectory {
  readonly absolute: Buffer;
  /** Its path from the root, in NFC, `""` for the root. */
  readonly path: string;
  /** Its path from the root as the file system spells it. */
  readonly rawPath: string;
  /** The bytes patterns match for it, empty for the root. */
  readonly matchPath: Buffer;
  /** Whether a name on its path is not UTF-8, which makes every file below no tree path. */
  readonly invalidName: boolean;
  readonly gitignoreLists: readonly PatternList[];
  readonly entries: readonly ListedEntry[];
}

interface Member {
  readonly path: string;
  readonly absolute: Buffer;
}

class Listing {
  readonly members: Member[] = [];
  readonly exclusions = new Map<string, RecordedExclusion>();
  /** NFC paths that two or more spellings on disk normalize to, with those spellings. */
  readonly spellings = new Map<string, Set<string>>();
  private fileCount = 0;
  private totalSize = 0;

  constructor(
    readonly root: string,
    readonly manifestPatterns: PatternList | null,
    private readonly limits: MethodTreeLimits,
  ) {}

  /** Count a member from its `lstat` size, stopping at the first limit passed. */
  count(path: string, size: number): void {
    const { maxFileSize, maxFileCount, maxTotalSize } = this.limits;
    if (maxFileSize !== undefined && size > maxFileSize) {
      throw new TreeLimitExceededError(this.root, "maxFileSize", maxFileSize, size, path);
    }
    this.fileCount += 1;
    if (maxFileCount !== undefined && this.fileCount > maxFileCount) {
      throw new TreeLimitExceededError(this.root, "maxFileCount", maxFileCount, this.fileCount);
    }
    this.totalSize += size;
    if (maxTotalSize !== undefined && this.totalSize > maxTotalSize) {
      throw new TreeLimitExceededError(this.root, "maxTotalSize", maxTotalSize, this.totalSize);
    }
  }
}

function joinPath(directory: string, name: string): string {
  return directory === "" ? name : `${directory}/${name}`;
}

function refusal(
  code: TreeRefusalCode,
  message: string,
  names: readonly string[],
  extra: { excludedBy?: ExclusionRule; excludedDirectory?: string } = {},
): MethodTreeError {
  return new MethodTreeError(code, message, { names, ...extra });
}

function describeIoError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A member's size from `lstat`, which the limits count before anything is read. */
async function lstatSize(absolute: Buffer | string, path: string, where: string): Promise<number> {
  try {
    return (await lstat(absolute)).size;
  } catch (err) {
    throw new MethodTreeError(
      "not_listable",
      `Cannot read '${path}' under ${where}: ${describeIoError(err)}`,
      { names: [path] },
    );
  }
}

/** Read a directory's entries as bytes, sorted byte for byte by name. */
async function readEntries(absolute: Buffer, displayPath: string): Promise<ListedEntry[]> {
  let dirents: Dirent<Buffer>[];
  try {
    dirents = await readdir(absolute, { withFileTypes: true, encoding: "buffer" });
  } catch (err) {
    throw new MethodTreeError(
      "not_listable",
      `Cannot list the directory '${displayPath}': ${describeIoError(err)}`,
      { names: [displayPath] },
    );
  }
  return dirents
    .map((dirent): ListedEntry => {
      const nameBytes = dirent.name;
      let rawName: string;
      let validUtf8 = true;
      try {
        rawName = strictUtf8.decode(nameBytes);
      } catch {
        rawName = lenientUtf8.decode(nameBytes);
        validUtf8 = false;
      }
      const name = validUtf8 ? rawName.normalize("NFC") : rawName;
      return {
        nameBytes,
        name,
        rawName,
        validUtf8,
        matchBytes: validUtf8 ? Buffer.from(name, "utf8") : nameBytes,
        kind: entryKindOf(dirent),
      };
    })
    .sort((left, right) => Buffer.compare(left.nameBytes, right.nameBytes));
}

function findEntry(entries: readonly ListedEntry[], name: string): ListedEntry | undefined {
  return entries.find((entry) => entry.validUtf8 && entry.rawName === name);
}

/**
 * The default that excludes a directory for what it holds (`markerRule`), or `null`, the first in
 * `MARKER_RULES` order when several apply. `belowRoot` is false for the root itself.
 */
function markerExclusion(
  entries: readonly ListedEntry[],
  belowRoot: boolean,
): ExclusionRule | null {
  let found: ExclusionRule | null = null;
  for (const entry of entries) {
    if (!entry.validUtf8) continue;
    const rule = markerRule(entry.rawName, entry.kind, belowRoot);
    if (
      rule !== null &&
      (found === null || MARKER_RULES.indexOf(rule) < MARKER_RULES.indexOf(found))
    ) {
      found = rule;
    }
  }
  return found;
}

/** A directory's entries when it can be listed, or `null` when it cannot. */
async function tryReadEntries(
  absolute: Buffer,
  displayPath: string,
): Promise<ListedEntry[] | null> {
  try {
    return await readEntries(absolute, displayPath);
  } catch (err) {
    if (err instanceof MethodTreeError) return null;
    throw err;
  }
}

/** The patterns of a directory's `.gitignore` file, or `null` when it holds no regular one. */
async function readGitignore(
  directory: WalkedDirectory,
  root: string,
): Promise<PatternList | null> {
  const entry = findEntry(directory.entries, GITIGNORE_NAME);
  // A `.gitignore` that is a link is not read, as git does not read one inside a work tree.
  if (entry === undefined || entry.kind !== "file") return null;
  const path = joinPath(directory.path, GITIGNORE_NAME);
  let bytes: Buffer;
  try {
    bytes = await readFile(Buffer.concat([directory.absolute, SEPARATOR, entry.nameBytes]));
  } catch (err) {
    throw new MethodTreeError(
      "not_listable",
      `Cannot read '${path}' under ${root}: ${describeIoError(err)}`,
      { names: [path] },
    );
  }
  // Read as UTF-8, a leading byte order mark skipped as git skips it.
  const body = bytes.subarray(0, 3).equals(UTF8_BOM) ? bytes.subarray(3) : bytes;
  let text: string;
  try {
    text = strictUtf8.decode(body);
  } catch {
    throw new MethodTreeError(
      "gitignore_not_utf8",
      `The file '${path}' under ${root} is not UTF-8; a .gitignore file of a method tree is read as UTF-8, so re-save it in that encoding.`,
      { names: [path] },
    );
  }
  return parseGitignore(text, directory.matchPath, "gitignore");
}

async function walk(listing: Listing, directory: WalkedDirectory): Promise<void> {
  const ownPatterns = await readGitignore(directory, listing.root);
  const gitignoreLists =
    ownPatterns === null ? directory.gitignoreLists : [...directory.gitignoreLists, ownPatterns];

  // Two names of this directory equal in NFC are refused, naming both, when a file of the tree
  // lies at or under them; the check runs once the walk knows the tree's files.
  const byName = new Map<string, Set<string>>();
  for (const entry of directory.entries) {
    if (!entry.validUtf8) continue;
    const group = byName.get(entry.name) ?? new Set<string>();
    group.add(entry.rawName);
    byName.set(entry.name, group);
  }
  for (const [name, rawNames] of byName) {
    if (rawNames.size < 2) continue;
    listing.spellings.set(
      joinPath(directory.path, name),
      new Set([...rawNames].map((rawName) => joinPath(directory.rawPath, rawName))),
    );
  }

  for (const entry of directory.entries) {
    const path = joinPath(directory.path, entry.name);
    const rawPath = joinPath(directory.rawPath, entry.rawName);
    const absolute = Buffer.concat([directory.absolute, SEPARATOR, entry.nameBytes]);
    const matchPath =
      directory.matchPath.length === 0
        ? entry.matchBytes
        : Buffer.concat([directory.matchPath, SLASH, entry.matchBytes]);
    const isDirectory = entry.kind === "directory";

    let rule: ExclusionRule | null = null;
    let children: ListedEntry[] | null = null;
    if (isDotSegment(entry.rawName)) {
      rule = "dot_segment";
    } else if (isDirectory && isDefaultExcludedDirectory(entry.rawName)) {
      rule = "pycache_or_node_modules";
    } else if (isRunInputsFile(entry.rawName, entry.kind)) {
      // A run's inputs file, at any depth, a link among them, never followed; a default outranks
      // the patterns, so the rule is named whatever a `.gitignore` file says of the file.
      rule = "run_inputs";
    } else {
      // The patterns are decided first, so a directory they exclude is pruned without having to be
      // listed. A marker inside it still names the rule, which outranks the patterns, when the
      // directory can be listed; one that cannot be holds no marker the walk can see.
      const patternRule = excludingSource(
        gitignoreLists,
        listing.manifestPatterns,
        matchPath,
        entry.matchBytes,
        isDirectory,
      );
      if (isDirectory) {
        const displayPath = `${listing.root}${sep}${rawPath}`;
        children =
          patternRule === null
            ? await readEntries(absolute, displayPath)
            : await tryReadEntries(absolute, displayPath);
        if (children !== null) rule = markerExclusion(children, true);
      }
      rule ??= patternRule;
    }
    if (rule !== null) {
      listing.exclusions.set(path, {
        rule,
        directory: isMarkerRule(rule) ? path : null,
        isDirectory,
        absolute,
      });
      continue;
    }

    switch (entry.kind) {
      case "symlink":
        throw refusal(
          "symbolic_link",
          `The method tree at ${listing.root} holds a symbolic link, '${path}': a link is never followed. Replace it with the file itself, or keep it out with a .gitignore file or the manifest's exclude patterns.`,
          [path],
        );
      case "other":
        throw refusal(
          "special_file",
          `The method tree at ${listing.root} holds '${path}', which is neither a file nor a directory, such as a named pipe or a device. Remove it, or keep it out with a .gitignore file or the manifest's exclude patterns.`,
          [path],
        );
      case "directory":
        await walk(listing, {
          absolute,
          path,
          rawPath,
          matchPath,
          invalidName: directory.invalidName || !entry.validUtf8,
          gitignoreLists,
          entries: children!,
        });
        continue;
      case "file": {
        const violation =
          directory.invalidName || !entry.validUtf8
            ? "a name on the path is not UTF-8"
            : treePathViolation(path);
        if (violation !== null) {
          throw refusal(
            "invalid_tree_path",
            `The method tree at ${listing.root} holds '${path}', which is not a tree path: ${violation}. Rename it, or keep it out with a .gitignore file or the manifest's exclude patterns.`,
            [path],
          );
        }
        listing.count(path, await lstatSize(absolute, path, listing.root));
        listing.members.push({ path, absolute });
        continue;
      }
    }
  }
}

/** The manifest's `exclude` patterns, or `null` when it has none. */
async function readManifestPatterns(root: string): Promise<PatternList | null> {
  const manifestPath = join(root, MANIFEST_NAME);
  let raw: unknown;
  try {
    raw = parseToml(await readFile(manifestPath, "utf-8"));
  } catch (err) {
    // A manifest the walk cannot read cannot say what it excludes, so the tree is not listed
    // rather than listed with files the author meant to keep out.
    throw new MethodTreeError(
      "manifest_invalid",
      `Cannot read the exclude patterns of ${manifestPath}: ${describeIoError(err)}`,
      { names: [MANIFEST_NAME] },
    );
  }
  const packageSection = (raw as Record<string, unknown>)["package"];
  const exclude =
    packageSection !== null && typeof packageSection === "object" && !Array.isArray(packageSection)
      ? (packageSection as Record<string, unknown>)["exclude"]
      : undefined;
  if (exclude === undefined) return null;
  if (
    !Array.isArray(exclude) ||
    !exclude.every((pattern) => typeof pattern === "string" && isValidExcludePattern(pattern))
  ) {
    throw new MethodTreeError(
      "manifest_invalid",
      `[package] exclude in ${manifestPath} must be an array of patterns, each a string without a line break.`,
      { names: [MANIFEST_NAME] },
    );
  }
  return parseExcludePatterns(exclude as string[]);
}

/** The exclusion recorded at or above `treePath`, the outermost first, since the walk prunes. */
function exclusionCovering(
  exclusions: ReadonlyMap<string, RecordedExclusion>,
  treePath: string,
): RecordedExclusion | undefined {
  for (const prefix of ["", ...directoriesOf(treePath), treePath]) {
    const exclusion = exclusions.get(prefix);
    if (exclusion !== undefined) return exclusion;
  }
  return undefined;
}

async function hashMembers(
  members: readonly Member[],
  where: string,
): Promise<{ files: MethodTreeFile[]; absolutes: Map<string, Buffer> }> {
  const sorted = [...members].sort((left, right) => compareUtf8(left.path, right.path));
  const files: MethodTreeFile[] = [];
  const absolutes = new Map<string, Buffer>();
  for (const member of sorted) {
    const { size, sha256 } = await readMember(member.absolute, member.path, where, false);
    files.push({ path: member.path, size, sha256 });
    absolutes.set(member.path, member.absolute);
  }
  return { files, absolutes };
}

/**
 * The one-file tree of a `.mthds` file named alone, with no manifest above it: the file is the one
 * member of its tree, judged as one, so a link is refused and never followed, as a named pipe is.
 */
async function listOneFileTree(
  file: string,
  kind: EntryKind,
  limits: MethodTreeLimits,
): Promise<MethodTree> {
  const name = basename(file).normalize("NFC");
  // Nothing beside the file is read: of the membership rule, only the dot-segment rule reaches it.
  if (name.startsWith(".")) {
    throw refusal(
      "lone_file_excluded",
      `The file '${name}' starts with a dot, so the membership rule keeps it out of its own tree; rename it.`,
      [name],
      { excludedBy: "dot_segment" },
    );
  }
  if (kind === "symlink") {
    throw refusal(
      "symbolic_link",
      `'${file}' is a symbolic link, which a method tree never follows; hand over the file it points to.`,
      [name],
    );
  }
  if (kind !== "file") {
    throw refusal(
      "special_file",
      `'${file}' is neither a file nor a directory, such as a named pipe or a device.`,
      [name],
    );
  }
  const violation = treePathViolation(name);
  if (violation !== null) {
    throw refusal("invalid_tree_path", `'${name}' is not a tree path: ${violation}.`, [name]);
  }
  const listing = new Listing(file, null, limits);
  listing.count(name, await lstatSize(file, name, file));
  const { files, absolutes } = await hashMembers(
    [{ path: name, absolute: Buffer.from(file) }],
    file,
  );
  return new MethodTree({
    root: null,
    entry: name,
    files,
    digest: treeDigest(files),
    absolutes,
    exclusions: new Map(),
  });
}

/** What a caller handed over: a directory, resolved to its physical path, or a lone file. */
type HandedOver =
  | { readonly kind: "directory"; readonly directory: string }
  | { readonly kind: "lone"; readonly file: string; readonly entryKind: EntryKind };

async function readHandedOver(handedOver: string): Promise<HandedOver> {
  const absolute = resolve(handedOver);
  try {
    const stats = await lstat(absolute);
    // A directory reached through a link is the caller's choice of path, never a file of a tree,
    // so it is resolved; a lone file keeps its own name, a link among them, and only the
    // directory holding it is resolved, since Manifest Discovery walks up physical parents.
    if (stats.isDirectory() || (stats.isSymbolicLink() && (await isDirectoryBehind(absolute)))) {
      return { kind: "directory", directory: await realpath(absolute) };
    }
    // A link keeps the name it was handed over by, its parent alone resolved. Any other file takes
    // the name the file system holds, so a name typed in another case on a case-insensitive file
    // system names the same tree path, and the suffix check reads the real name.
    const file = stats.isSymbolicLink()
      ? join(await realpath(dirname(absolute)), basename(absolute))
      : await realpath(absolute);
    return { kind: "lone", file, entryKind: entryKindOf(stats) };
  } catch (err) {
    throw new MethodTreeError("not_found", `Cannot read '${handedOver}': ${describeIoError(err)}`, {
      names: [handedOver],
    });
  }
}

async function isDirectoryBehind(link: string): Promise<boolean> {
  try {
    return (await stat(link)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * List the method tree of what a caller hands over: a directory, or a `.mthds` file named alone.
 * The root is found by Manifest Discovery from the directory, or from the file's own directory;
 * with no manifest, a directory is its own root and a lone file is a one-file tree.
 *
 * A directory handed over is resolved to its physical path, and so is the directory holding a lone
 * file, since the walk up to a manifest follows physical parents; a lone file keeps its own name,
 * so a link named alone is refused as a link. Refusals are `MethodTreeError`s whose codes the
 * conformance corpus pins.
 */
export async function listMethodTree(
  handedOver: string,
  options: ListMethodTreeOptions = {},
): Promise<MethodTree> {
  const limits = options.limits ?? {};
  const handed = await readHandedOver(handedOver);
  // The standard names a directory or a `.mthds` file; any other file is refused rather than
  // guessed at, since it is no method on its own.
  if (handed.kind === "lone" && !handed.file.endsWith(".mthds")) {
    throw new MethodTreeError(
      "not_listable",
      `'${handedOver}' is not a .mthds file; hand over a method's directory or a .mthds file.`,
      { names: [handedOver] },
    );
  }

  const start = handed.kind === "directory" ? handed.directory : dirname(handed.file);
  const manifestDirectory =
    handed.kind === "directory" && options.discover === false ? null : findManifestDirectory(start);
  if (handed.kind === "lone" && manifestDirectory === null) {
    return listOneFileTree(handed.file, handed.entryKind, limits);
  }
  const root = manifestDirectory ?? start;
  const manifestPatterns =
    exactEntryKind(root, MANIFEST_NAME) === "file" ? await readManifestPatterns(root) : null;

  const listing = new Listing(root, manifestPatterns, limits);
  const rootAbsolute = Buffer.from(root);
  const rootEntries = await readEntries(rootAbsolute, root);
  if (markerExclusion(rootEntries, false) === "virtual_environment") {
    // A root that is itself a virtual environment holds an empty tree.
    listing.exclusions.set("", {
      rule: "virtual_environment",
      directory: ".",
      isDirectory: true,
      absolute: rootAbsolute,
    });
  } else {
    await walk(listing, {
      absolute: rootAbsolute,
      path: "",
      rawPath: "",
      matchPath: Buffer.alloc(0),
      invalidName: false,
      gitignoreLists: [],
      entries: rootEntries,
    });
  }

  const memberPaths = listing.members.map((member) => member.path);
  const collidingSpellings = new Set<string>();
  for (const memberPath of memberPaths) {
    for (const prefix of [...directoriesOf(memberPath), memberPath]) {
      for (const spelling of listing.spellings.get(prefix) ?? []) collidingSpellings.add(spelling);
    }
  }
  if (collidingSpellings.size > 0) {
    const names = [...collidingSpellings].sort(compareUtf8);
    throw refusal(
      "normalization_collision",
      `The method tree at ${root} holds names that are equal once normalized to NFC: ${names.join(", ")}. Keep one spelling.`,
      names,
    );
  }
  const collisions = pathCollisions(memberPaths);
  if (collisions.length > 0) {
    throw refusal(
      "path_collision",
      `The method tree at ${root} holds paths that collide once case-folded, which a case-insensitive file system cannot hold apart: ${collisions.join(", ")}. Rename them.`,
      collisions,
    );
  }

  let entry: string | null = null;
  if (handed.kind === "lone") {
    entry = relative(root, handed.file)
      .split(sep)
      .map((segment) => segment.normalize("NFC"))
      .join("/");
    if (!memberPaths.includes(entry)) {
      const exclusion = exclusionCovering(listing.exclusions, entry);
      throw refusal(
        "lone_file_excluded",
        `The file '${entry}' is not part of the method tree at ${root}${exclusion === undefined ? "" : `, which the membership rule's ${exclusion.rule} rule keeps out`}.`,
        [entry],
        exclusion === undefined
          ? {}
          : {
              excludedBy: exclusion.rule,
              ...(exclusion.directory !== null && namesExcludedDirectory(exclusion.rule)
                ? { excludedDirectory: exclusion.directory }
                : {}),
            },
      );
    }
  }
  if (memberPaths.length === 0) {
    throw refusal(
      "empty_tree",
      `The method tree at ${root} holds no file; a tree holds at least one.`,
      [],
    );
  }

  const { files, absolutes } = await hashMembers(listing.members, root);
  return new MethodTree({
    root,
    entry,
    files,
    digest: treeDigest(files),
    absolutes,
    exclusions: listing.exclusions,
  });
}
