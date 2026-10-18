/**
 * The errors of listing a method tree and of reading a map of file entries.
 *
 * The codes the conformance corpus pins (`conformance/specs/mthds-method-tree.md`, "Refusals") are
 * stable; the wording of each message is this package's own. The other codes are this
 * implementation's, for what the corpus does not exercise: a path handed over that cannot be
 * listed, a manifest whose exclude patterns cannot be read, a document that is not JSON, and a tree
 * past a limit the caller set.
 */

/** A rule of the membership rule, as a refusal names it. */
export type ExclusionRule =
  | "dot_segment"
  | "pycache_or_node_modules"
  | "virtual_environment"
  | "nested_repository"
  | "nested_package"
  | "run_inputs"
  | "gitignore"
  | "package_exclude";

/** Whether a refusal citing `rule` also names the excluded directory, as the standard asks. */
export function namesExcludedDirectory(rule: ExclusionRule): boolean {
  return rule === "nested_repository" || rule === "nested_package";
}

/** The codes a listed tree is refused with, as the corpus pins them. */
export type TreeRefusalCode =
  | "symbolic_link"
  | "special_file"
  | "invalid_tree_path"
  | "normalization_collision"
  | "path_collision"
  | "empty_tree"
  | "lone_file_excluded"
  | "gitignore_not_utf8";

/** The codes a map of file entries is refused with, as the corpus pins them. */
export type MapRefusalCode =
  | "invalid_tree_path"
  | "path_collision"
  | "empty_tree"
  | "duplicate_key"
  | "excluded_name"
  | "malformed_entry"
  | "missing_blob";

/** This implementation's own codes, for what the corpus does not exercise. */
export type MethodTreeImplementationCode =
  | "not_found"
  | "not_listable"
  | "manifest_invalid"
  | "malformed_document"
  | "limit_exceeded";

export type MethodTreeErrorCode = TreeRefusalCode | MapRefusalCode | MethodTreeImplementationCode;

export interface MethodTreeErrorOptions {
  readonly names?: readonly string[];
  readonly excludedBy?: ExclusionRule;
  readonly excludedDirectory?: string;
}

/** A tree, or a map of file entries, that is refused. */
export class MethodTreeError extends Error {
  readonly code: MethodTreeErrorCode;
  /** What the refusal names: one offender, or every one for the codes that name them all. */
  readonly names: readonly string[];
  /** For `lone_file_excluded`, the rule keeping the file out of its tree. */
  readonly excludedBy?: ExclusionRule;
  /** For a nested repository or a nested package, the directory the rule excludes. */
  readonly excludedDirectory?: string;

  constructor(code: MethodTreeErrorCode, message: string, options: MethodTreeErrorOptions = {}) {
    super(message);
    this.name = "MethodTreeError";
    this.code = code;
    this.names = options.names ?? [];
    if (options.excludedBy !== undefined) this.excludedBy = options.excludedBy;
    if (options.excludedDirectory !== undefined) this.excludedDirectory = options.excludedDirectory;
  }
}

/** Which limit a tree passed. */
export type TreeLimit = "maxFileSize" | "maxFileCount" | "maxTotalSize";

/** A tree refused while it was being listed, at the first limit it passed, before any hashing. */
export class TreeLimitExceededError extends MethodTreeError {
  readonly root: string;
  readonly limit: TreeLimit;
  readonly maximum: number;
  /** The count or size reached when the listing stopped. */
  readonly reached: number;

  constructor(root: string, limit: TreeLimit, maximum: number, reached: number, path?: string) {
    super("limit_exceeded", limitMessage(root, limit, maximum, reached, path), {
      names: path === undefined ? [] : [path],
    });
    this.name = "TreeLimitExceededError";
    this.root = root;
    this.limit = limit;
    this.maximum = maximum;
    this.reached = reached;
  }
}

function limitMessage(
  root: string,
  limit: TreeLimit,
  maximum: number,
  reached: number,
  path: string | undefined,
): string {
  switch (limit) {
    case "maxFileSize":
      return `The method tree at ${root} holds ${path ?? "a file"}, of ${reached} bytes, past the limit of ${maximum} bytes for one file; listing stopped there, before hashing any file.`;
    case "maxFileCount":
      return `The method tree at ${root} holds more than ${maximum} files, the limit; listing stopped at ${reached} files, before hashing any file. Hand over the method's own directory, or keep the rest out with a .gitignore file or the manifest's exclude patterns.`;
    case "maxTotalSize":
      return `The method tree at ${root} holds more than ${maximum} bytes, the limit for a whole tree; listing stopped at ${reached} bytes, before hashing any file. Hand over the method's own directory, or keep the rest out with a .gitignore file or the manifest's exclude patterns.`;
  }
}
