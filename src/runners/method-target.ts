/**
 * What a `run` or `validate` command line names, resolved into the method it sends: one method
 * tree, as the MTHDS standard's lister defines it (`src/method-tree/`), and the bundle the command
 * named inside it.
 *
 * A directory is listed from its root, found by Manifest Discovery; a `.mthds` file is listed in
 * the tree of the nearest `METHODS.toml` above it, or alone as a one-file tree when there is none,
 * and then nothing beside it travels. Inline `--content` is a one-file tree of its own.
 *
 * A library directory (`-L`) cannot add a second tree to a request, since a request carries one.
 * One inside the tree's root adds nothing, the tree already holding its files. One holding a
 * `.mthds` file named alone becomes that file's root, so `validate bundle <file> -L <its dir>/`
 * sends the directory's tree with the file as its entry, as the pipelex runner loads the directory
 * beside the file. Any other is refused with a message saying how to make one tree of them.
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

/** What a `run` or `validate` command names: a path, or inline `--content`. */
export type MethodTarget = { path: string } | { content: string };

/** A command line's method, as a request carries it. */
export interface ResolvedMethodTarget {
  /** The listed tree, which the client sends inline or by hash, or the inline content's map. */
  readonly method: { tree: MethodTree } | { files: MethodFiles };
  /** The tree path of the `.mthds` file the command named, or `null` for a directory. */
  readonly entry: string | null;
  /** The `main_pipe` the named bundle declares, when it declares one. */
  readonly entryMainPipe: string | undefined;
}

/**
 * Resolve a command line's target and library directories into the one method tree it sends.
 * `limits` are the runner's announced tree limits, so a folder handed over by mistake is refused
 * while it is listed, before anything is hashed.
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
    if (libraryDirs.length > 0) {
      throw new MethodTargetError(
        "--content sends one bundle as a method tree of its own, so it takes no library directory (-L). Write the bundle into the method's directory and name that file or directory, or pass --runner pipelex.",
      );
    }
    const files: MethodFiles = {};
    defineFileEntry(files, INLINE_CONTENT_TREE_PATH, target.content);
    return {
      method: { files },
      entry: INLINE_CONTENT_TREE_PATH,
      entryMainPipe: readBundleMeta(target.content).mainPipe,
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
  for (const libraryDir of libraryDirs) {
    const directory = await realpath(libraryDir);
    if (tree.root !== null) {
      if (isWithin(directory, tree.root)) continue;
      throw new MethodTargetError(
        `The API runner sends a method as one tree, here the tree rooted at ${tree.root}, and the library directory ${libraryDir} is outside it. Move those files under the root, add a METHODS.toml to a directory holding both, or pass --runner pipelex.`,
      );
    }
    // A `.mthds` file named alone, with no manifest above it: a library directory holding it
    // becomes its root, so the files beside it travel with it.
    const fileDirectory = await realpath(dirname(resolve(target.path)));
    if (!isWithin(fileDirectory, directory)) {
      throw new MethodTargetError(
        `${target.path} is a .mthds file named alone, which travels without the files beside it, and the library directory ${libraryDir} does not hold it. Name a directory holding both, add a METHODS.toml to one, or pass --runner pipelex.`,
      );
    }
    const loneName = tree.entry!;
    tree = await listMethodTree(directory, { limits, discover: false });
    const below = relative(directory, fileDirectory);
    entry = (below === "" ? [] : below.split(sep))
      .map((segment) => segment.normalize("NFC"))
      .concat(loneName)
      .join("/");
    if (!tree.has(entry)) {
      throw new MethodTargetError(
        `${target.path} is not a file of the method tree at ${directory}, whose membership rule keeps it out, so it cannot be sent as that tree's entry.`,
      );
    }
  }

  if (!tree.files.some((file) => file.path.endsWith(".mthds"))) {
    throw new MethodTargetError(
      `The method tree at ${tree.root ?? target.path} holds no .mthds file.`,
    );
  }
  let entryMainPipe: string | undefined;
  if (entry !== null) {
    const text = utf8TextOf(await tree.readFile(entry));
    entryMainPipe = text === null ? undefined : readBundleMeta(text).mainPipe;
  }
  return { method: { tree }, entry, entryMainPipe };
}

/** Whether `path` is `directory` or lies below it; both are real paths. */
function isWithin(path: string, directory: string): boolean {
  return (
    path === directory || path.startsWith(directory.endsWith(sep) ? directory : directory + sep)
  );
}
