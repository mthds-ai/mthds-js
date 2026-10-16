/**
 * A listed method tree: its root, its files and its digest, what it reads back, how it resolves a
 * file reference and where it finds a `PipeFunc`'s function. `listMethodTree` (`lister.ts`) makes
 * one from a directory or a `.mthds` file.
 */

import { readdir } from "node:fs/promises";
import { sep } from "node:path";
import type { MethodFiles, MethodTreeSource } from "../protocol/file_entries.js";
import { namesExcludedDirectory, type ExclusionRule, MethodTreeError } from "./exceptions.js";
import { readMember } from "./file-reading.js";
import { locateFunction, type FunctionLocation } from "./function-names.js";
import {
  resolveFileReference,
  ROOT_RESOLVED,
  type ReferenceContext,
  type ReferenceRefusalCode,
} from "./references.js";
import { entryKindOf } from "./membership.js";
import { defineFileEntry, inlineFileEntry } from "./file-entry-encoding.js";
import { directoriesOf } from "./tree-path.js";

/** A file of a listed tree. */
export interface MethodTreeFile {
  /** Its tree path. */
  readonly path: string;
  /** Its length in bytes. */
  readonly size: number;
  /** The SHA-256 of its bytes, in lowercase hexadecimal. */
  readonly sha256: string;
}

/** A part of the file system the membership rule kept out, as the listing recorded it. */
export interface RecordedExclusion {
  readonly rule: ExclusionRule;
  /** The directory the rule names: the one holding the marker, `.` for the root itself. */
  readonly directory: string | null;
  readonly isDirectory: boolean;
  /** Where it is on disk, so a reference into an excluded directory can be attributed. */
  readonly absolute: Buffer;
}

/** A refused file reference. */
export interface ReferenceRefusal {
  readonly code: ReferenceRefusalCode;
  /** The reference as written. */
  readonly reference: string;
  /** The path it resolved to, `.` for the root; absent when it was refused before resolving. */
  readonly resolved?: string;
  /** For a file the tree holds no copy of because the membership rule keeps it out, the rule. */
  readonly excludedBy?: ExclusionRule;
  /** For a nested repository or a nested package, the directory the rule excludes. */
  readonly excludedDirectory?: string;
  readonly message: string;
}

export type ReferenceResolution =
  | { readonly kind: "not_a_reference" }
  | { readonly kind: "tree_path"; readonly treePath: string }
  | { readonly kind: "refused"; readonly refusal: ReferenceRefusal };

export interface ResolveReferenceInput {
  /** The tree path of the file holding the reference. */
  readonly holder: string;
  readonly reference: string;
  /** `path` for a bundle field naming a file, `url` for a URL inside a file's text. */
  readonly context: ReferenceContext;
}

export interface MethodTreeInit {
  readonly root: string | null;
  readonly entry: string | null;
  readonly files: readonly MethodTreeFile[];
  readonly digest: string;
  readonly absolutes: ReadonlyMap<string, Buffer>;
  readonly exclusions: ReadonlyMap<string, RecordedExclusion>;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function referenceMessage(refusal: Omit<ReferenceRefusal, "message">): string {
  const { reference, resolved } = refusal;
  switch (refusal.code) {
    case "reference_invalid":
      return `The reference '${reference}' is malformed: a file reference is a relative path, with no backslash, no scheme and no authority, and in a URL no malformed percent-escape.`;
    case "reference_leaves_tree":
      return `The reference '${reference}' climbs above the root of its method tree.`;
    case "reference_not_a_tree_path":
      return resolved === undefined
        ? "The reference is empty."
        : `The reference '${reference}' resolves to '${resolved}', which is not a tree path.`;
    case "reference_in_one_file_tree":
      return `The reference '${reference}' names a file beside a .mthds file named alone, which travels without the files beside it: run the method's directory, or add a METHODS.toml to make that directory a method's root.`;
    case "reference_not_in_tree": {
      if (resolved === ROOT_RESOLVED) {
        return `The reference '${reference}' names the root of the tree, not a file of it.`;
      }
      if (refusal.excludedBy === undefined) {
        return `The reference '${reference}' resolves to '${resolved}', which is not a file of the method tree.`;
      }
      const directory =
        refusal.excludedDirectory === undefined ? "" : ` in '${refusal.excludedDirectory}'`;
      const why: Record<ExclusionRule, string> = {
        dot_segment: "a name starting with a dot is never part of a tree",
        pycache_or_node_modules: "a __pycache__ or node_modules directory is never part of a tree",
        virtual_environment: "a Python virtual environment is never part of a tree",
        nested_repository: `the nested repository${directory} is out of the tree`,
        nested_package: `the nested package${directory} is a tree of its own`,
        gitignore: "a .gitignore file of the tree excludes it",
        package_exclude: "the manifest's exclude patterns exclude it",
      };
      return `The reference '${reference}' resolves to '${resolved}', which the membership rule keeps out of the method tree: ${why[refusal.excludedBy]}.`;
    }
  }
}

/**
 * A method tree, listed from the file system. It is a `MethodTreeSource`, so it can be handed to a
 * client's `execute`, `start` or `validate` as `tree`, which sends it inline or by hash.
 */
export class MethodTree implements MethodTreeSource {
  /** The absolute path of the root, or `null` for the one-file tree of a `.mthds` file alone. */
  readonly root: string | null;
  /** The tree path of the `.mthds` file handed over alone, or `null` for a directory. */
  readonly entry: string | null;
  /** The tree's files, sorted by tree path byte for byte. */
  readonly files: readonly MethodTreeFile[];
  /** The tree digest, `sha256:` and 64 lowercase hexadecimal digits. */
  readonly digest: string;
  /** The total of the files' sizes, in bytes. */
  readonly totalSize: number;
  private readonly absolutes: ReadonlyMap<string, Buffer>;
  private readonly byPath: ReadonlyMap<string, MethodTreeFile>;
  private readonly exclusions: ReadonlyMap<string, RecordedExclusion>;

  constructor(init: MethodTreeInit) {
    this.root = init.root;
    this.entry = init.entry;
    this.files = init.files;
    this.digest = init.digest;
    this.totalSize = init.files.reduce((total, file) => total + file.size, 0);
    this.absolutes = init.absolutes;
    this.byPath = new Map(init.files.map((file) => [file.path, file]));
    this.exclusions = init.exclusions;
  }

  /** Whether the tree is the one-file tree of a `.mthds` file named alone, with no manifest. */
  get isOneFileTree(): boolean {
    return this.root === null;
  }

  /** Whether `treePath` names a file of the tree. */
  has(treePath: string): boolean {
    return this.absolutes.has(treePath);
  }

  /**
   * A file's bytes, read again as the listing read them, never through a link, and checked against
   * the hash the listing recorded.
   */
  async readFile(treePath: string): Promise<Buffer> {
    const absolute = this.absolutes.get(treePath);
    const listed = this.byPath.get(treePath);
    if (absolute === undefined || listed === undefined) {
      throw new MethodTreeError("not_found", `'${treePath}' is not a file of the method tree.`, {
        names: [treePath],
      });
    }
    const { bytes, sha256 } = await readMember(
      absolute,
      treePath,
      this.root ?? absolute.toString(),
      true,
    );
    if (sha256 !== listed.sha256 || bytes === null) {
      throw new MethodTreeError(
        "not_listable",
        `'${treePath}' changed since the method tree was listed; list it again.`,
        { names: [treePath] },
      );
    }
    return bytes;
  }

  /**
   * The tree as a map of file entries: a file whose bytes are UTF-8 as its text, any other in
   * Base64.
   */
  async toMethodFiles(): Promise<MethodFiles> {
    const entries: MethodFiles = {};
    for (const file of this.files) {
      // Each an own property, so a file named `__proto__` travels like any other.
      defineFileEntry(entries, file.path, inlineFileEntry(await this.readFile(file.path)));
    }
    return entries;
  }

  /** Locate a `PipeFunc`'s function, named by its import path from the root, among the files. */
  locateFunction(functionName: string): FunctionLocation {
    return locateFunction(functionName, (treePath) => this.has(treePath));
  }

  /**
   * Resolve a file reference written in one of the tree's files. A reference to a file the
   * membership rule keeps out says which rule does, and for a nested repository or package, which
   * directory.
   */
  async resolveReference(input: ResolveReferenceInput): Promise<ReferenceResolution> {
    const bare = resolveFileReference({
      ...input,
      isMember: (treePath) => this.has(treePath),
      oneFileTree: this.isOneFileTree,
    });
    if (bare.kind !== "refused") return bare;
    let refusal: Omit<ReferenceRefusal, "message"> = {
      code: bare.code,
      reference: bare.reference,
      ...(bare.resolved !== undefined ? { resolved: bare.resolved } : {}),
    };
    if (bare.code === "reference_not_in_tree" && bare.resolved !== undefined) {
      const exclusion = await this.exclusionOfFileAt(bare.resolved);
      if (exclusion !== null) {
        refusal = {
          ...refusal,
          excludedBy: exclusion.rule,
          ...(namesExcludedDirectory(exclusion.rule) && exclusion.directory !== null
            ? { excludedDirectory: exclusion.directory }
            : {}),
        };
      }
    }
    return { kind: "refused", refusal: { ...refusal, message: referenceMessage(refusal) } };
  }

  /**
   * The exclusion keeping out the file at `treePath`, or `null` when no file the rule excludes is
   * there: the exclusion recorded at the path itself when it is not a directory, or at an excluded
   * directory above it when a look inside that directory, never following a link, finds a file at
   * the path.
   */
  private async exclusionOfFileAt(treePath: string): Promise<RecordedExclusion | null> {
    if (treePath === ROOT_RESOLVED) return null;
    const prefixes = ["", ...directoriesOf(treePath)];
    for (const prefix of prefixes) {
      const exclusion = this.exclusions.get(prefix);
      if (exclusion === undefined) continue;
      // Only a real directory holds files: an excluded link is never followed to look inside it.
      if (!exclusion.isDirectory) return null;
      const below = (prefix === "" ? treePath : treePath.slice(prefix.length + 1)).split("/");
      return (await holdsFileBelow(exclusion.absolute, below)) ? exclusion : null;
    }
    const exclusion = this.exclusions.get(treePath);
    return exclusion !== undefined && !exclusion.isDirectory ? exclusion : null;
  }
}

/**
 * Whether the directory at `absolute` holds an entry other than a directory at `segments`, each
 * segment matched against a name of the directory in NFC, never following a link on the way.
 */
async function holdsFileBelow(absolute: Buffer, segments: readonly string[]): Promise<boolean> {
  let current = absolute;
  for (let index = 0; index < segments.length; index += 1) {
    let dirents;
    try {
      dirents = await readdir(current, { withFileTypes: true, encoding: "buffer" });
    } catch {
      return false;
    }
    const last = index === segments.length - 1;
    const found = dirents.find((dirent) => {
      let name: string;
      try {
        name = strictUtf8.decode(dirent.name);
      } catch {
        return false;
      }
      return name.normalize("NFC") === segments[index];
    });
    if (found === undefined) return false;
    const kind = entryKindOf(found);
    if (last) return kind !== "directory";
    if (kind !== "directory") return false;
    current = Buffer.concat([current, Buffer.from(sep), found.name]);
  }
  return false;
}
