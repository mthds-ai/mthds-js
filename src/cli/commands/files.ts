/**
 * `mthds files [path]`: the method tree of a directory or of a `.mthds` file, each file with its
 * size, and the tree digest. It shows what will travel with a method before anything travels, and
 * reads nothing beyond the file system (docs/method-tree.md).
 */

import { listMethodTree, MethodTreeError, type MethodTree } from "../../method-tree/index.js";
import { noteErrorDomain } from "../../usage-stats/outcome.js";

/** The answer of `mthds files --format json`. */
export interface FilesListing {
  /** The absolute path of the root, or `null` for the one-file tree of a `.mthds` file alone. */
  root: string | null;
  /** The tree path of the `.mthds` file handed over alone, `null` for a directory. */
  entry: string | null;
  files: { path: string; size: number; sha256: string }[];
  file_count: number;
  total_size: number;
  digest: string;
}

export function filesListing(tree: MethodTree): FilesListing {
  return {
    root: tree.root,
    entry: tree.entry,
    files: tree.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
    file_count: tree.files.length,
    total_size: tree.totalSize,
    digest: tree.digest,
  };
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** The listing as text: the root, each file's size and tree path, the totals and the digest. */
export function renderFilesText(listing: FilesListing): string {
  const lines: string[] = [];
  if (listing.root === null) {
    lines.push(`One-file tree of ${listing.entry} (no METHODS.toml above it)`);
  } else {
    lines.push(`Method tree at ${listing.root}`);
    if (listing.entry !== null) lines.push(`Entry: ${listing.entry}`);
  }
  lines.push("");
  const width = Math.max(...listing.files.map((file) => String(file.size).length));
  for (const file of listing.files) {
    lines.push(`${String(file.size).padStart(width)}  ${file.path}`);
  }
  lines.push("");
  lines.push(
    `${plural(listing.file_count, "file", "files")}, ${plural(listing.total_size, "byte", "bytes")}`,
  );
  lines.push(`Digest: ${listing.digest}`);
  return `${lines.join("\n")}\n`;
}

export async function listFiles(path: string, options: { format?: string }): Promise<void> {
  let tree: MethodTree;
  try {
    tree = await listMethodTree(path);
  } catch (err) {
    // A tree the standard refuses is the author's to fix.
    if (err instanceof MethodTreeError) noteErrorDomain("input");
    throw err;
  }
  const listing = filesListing(tree);
  process.stdout.write(
    options.format === "json" ? `${JSON.stringify(listing, null, 2)}\n` : renderFilesText(listing),
  );
}
