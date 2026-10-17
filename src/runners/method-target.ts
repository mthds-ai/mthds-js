/**
 * What a `run`, `validate` or `inputs` command line names, resolved into the method it sends: one
 * method tree, as the MTHDS standard's lister defines it (`src/method-tree/`), and the bundle the
 * command named inside it.
 *
 * A directory is listed from its root, found by Manifest Discovery; a `.mthds` file is listed in
 * the tree of the nearest `METHODS.toml` above it, or alone as a one-file tree when there is none,
 * and then nothing beside it travels. Inline `--content` is a one-file tree of its own.
 *
 * A library directory (`-L`) cannot add a second tree to a request, since a request carries one.
 * One inside the tree's root adds nothing, the tree already holding its files. For a `.mthds` file
 * named alone, the outermost library directory holding it becomes its root, so
 * `validate bundle <file> -L <its dir>/` sends the directory's tree with the file as its entry, as
 * the pipelex runner loads the directory beside the file, and every other library directory must
 * lie inside that root, in whatever order they were given. Any other is refused with a message
 * saying how to make one tree of them.
 */

import { realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { MethodFiles } from "../protocol/file_entries.js";
import { listMethodTree, type MethodTreeLimits } from "../method-tree/lister.js";
import type { MethodTree } from "../method-tree/tree.js";
import { defineFileEntry, utf8TextOf } from "../method-tree/file-entry-encoding.js";
import { readBundleMeta } from "./pipe-ref.js";

/** The tree path inline `--content` travels under. */
export const INLINE_CONTENT_TREE_PATH = "bundle.mthds";

/** A command line naming a method in a way that cannot be sent as one tree. */
export class MethodTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MethodTargetError";
  }
}

/** What a `run`, `validate` or `inputs` command names: a path, or inline `--content`. */
export type MethodTarget = { path: string } | { content: string };

/** A command line's method, as a request carries it. */
export interface ResolvedMethodTarget {
  /** The listed tree, which the client sends inline or by hash, or the inline content's map. */
  readonly method: { tree: MethodTree } | { files: MethodFiles };
  /** The tree path of the `.mthds` file the command named, or `null` for a directory. */
  readonly entry: string | null;
  /** The `main_pipe` the named bundle declares, when it declares one. */
  readonly entryMainPipe: string | undefined;
  /**
   * The named bundle's `main_pipe` qualified with the bundle's own domain
   * (`domain.main_pipe`), when it declares both: the pipe ref that names it in a tree
   * where several domains declare the same pipe code.
   */
  readonly entryPipeRef: string | undefined;
}

/**
 * Resolve a command line's target and library directories into the one method tree it sends.
 * `limits` are the runner's announced tree limits, so a folder handed over by mistake is refused
 * while it is listed, before anything is hashed.
 *
 * Library directories do not apply to inline content, which is a one-file tree of its own.
 *
 * Throws `MethodTargetError` for a combination that is not one tree, `MethodTreeError` (and its
 * `TreeLimitExceededError`) for a tree the lister refuses, and lets a missing library directory's
 * file-system error propagate.
 */
export async function resolveMethodTarget(
  target: MethodTarget,
  libraryDirs: readonly string[],
  limits: MethodTreeLimits = {},
): Promise<ResolvedMethodTarget> {
  if ("content" in target) {
    // Inline content is a one-file tree of its own: library directories do not apply to it,
    // so a global `-L`, which mthds-agent hands every command, neither joins nor refuses it.
    const files: MethodFiles = {};
    defineFileEntry(files, INLINE_CONTENT_TREE_PATH, target.content);
    return {
      method: { files },
      entry: INLINE_CONTENT_TREE_PATH,
      ...entryPipeOf(target.content),
    };
  }

  // A file the standard does not list is the command line's mistake, not an unreadable method;
  // a path that cannot be read is left to the lister, which says why.
  const handedOver = await stat(target.path).catch(() => undefined);
  if (handedOver?.isFile() === true && !target.path.endsWith(".mthds")) {
    throw new MethodTargetError(
      `${target.path} is neither a .mthds file nor a directory; name a method's directory or one of its .mthds files.`,
    );
  }
  let tree = await listMethodTree(target.path, { limits });
  let entry = tree.entry;
  const directories = await Promise.all(
    libraryDirs.map(async (libraryDir) => ({ libraryDir, real: await realpath(libraryDir) })),
  );
  if (tree.root !== null) {
    const outside = directories.find(({ real }) => !isWithin(real, tree.root!));
    if (outside !== undefined) {
      throw new MethodTargetError(
        `The API runner sends a method as one tree, here the tree rooted at ${tree.root}, and the library directory ${outside.libraryDir} is outside it. Move those files under the root, add a METHODS.toml to a directory holding both, or pass --runner pipelex.`,
      );
    }
  } else if (directories.length > 0) {
    // A `.mthds` file named alone, with no manifest above it: the outermost library
    // directory holding it becomes its root, so the files beside it travel with it,
    // and every other library directory must lie inside that root. The order the
    // directories were given in changes nothing.
    const fileDirectory = await realpath(dirname(resolve(target.path)));
    const holding = directories.filter(({ real }) => isWithin(fileDirectory, real));
    const root = holding.find(({ real }) => holding.every((other) => isWithin(other.real, real)));
    if (root === undefined) {
      throw new MethodTargetError(
        `${target.path} is a .mthds file named alone, which travels without the files beside it, and no library directory given holds it. Name a directory holding both, add a METHODS.toml to one, or pass --runner pipelex.`,
      );
    }
    const outside = directories.find(({ real }) => !isWithin(real, root.real));
    if (outside !== undefined) {
      throw new MethodTargetError(
        `${target.path} is a .mthds file named alone, which travels in the tree of the library directory ${root.libraryDir} holding it, and the library directory ${outside.libraryDir} is outside that tree. Name a directory holding both, add a METHODS.toml to one, or pass --runner pipelex.`,
      );
    }
    const loneName = tree.entry!;
    tree = await listMethodTree(root.real, { limits, discover: false });
    const below = relative(root.real, fileDirectory);
    entry = (below === "" ? [] : below.split(sep))
      .map((segment) => segment.normalize("NFC"))
      .concat(loneName)
      .join("/");
    if (!tree.has(entry)) {
      throw new MethodTargetError(
        `${target.path} is not a file of the method tree at ${root.real}, whose membership rule keeps it out, so it cannot be sent as that tree's entry.`,
      );
    }
  }

  if (!tree.files.some((file) => file.path.endsWith(".mthds"))) {
    throw new MethodTargetError(
      `The method tree at ${tree.root ?? target.path} holds no .mthds file.`,
    );
  }
  let entryPipe = entryPipeOf(null);
  if (entry !== null) {
    entryPipe = entryPipeOf(utf8TextOf(await tree.readFile(entry)));
  }
  return { method: { tree }, entry, ...entryPipe };
}

/** The entry pipe a named bundle declares, bare and qualified with its domain, from its text. */
function entryPipeOf(
  text: string | null,
): Pick<ResolvedMethodTarget, "entryMainPipe" | "entryPipeRef"> {
  const { domain, mainPipe } = text === null ? {} : readBundleMeta(text);
  return {
    entryMainPipe: mainPipe,
    entryPipeRef:
      domain !== undefined && mainPipe !== undefined ? `${domain}.${mainPipe}` : undefined,
  };
}

/** Whether `path` is `directory` or lies below it; both are real paths. */
function isWithin(path: string, directory: string): boolean {
  return (
    path === directory || path.startsWith(directory.endsWith(sep) ? directory : directory + sep)
  );
}
