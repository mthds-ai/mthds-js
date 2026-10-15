/**
 * File references (mthds/docs/spec/method-tree.md, "File References"): a path a file of a tree
 * writes to name another file of the same tree, resolved in seven steps against the directory of
 * the file that holds it. This module is the pure procedure; a listed tree adds to a refusal the
 * rule that keeps a file out of the tree (`MethodTree.resolveReference`).
 */

import { holdsControlCharacter, treePathViolation } from "./tree-path.js";

/**
 * Where a reference is written: `path` for a bundle field naming a file (a template's path, say),
 * `url` for a URL inside a file's text, such as an HTML `src`, which may name something else.
 */
export type ReferenceContext = "path" | "url";

export type ReferenceRefusalCode =
  | "reference_invalid"
  | "reference_leaves_tree"
  | "reference_not_a_tree_path"
  | "reference_not_in_tree"
  | "reference_in_one_file_tree";

/** What a reference resolved to, before a listed tree adds the rule excluding a file. */
export type BareReferenceResolution =
  | { readonly kind: "not_a_reference" }
  | { readonly kind: "tree_path"; readonly treePath: string }
  | {
      readonly kind: "refused";
      readonly code: ReferenceRefusalCode;
      readonly reference: string;
      /** The path the reference resolved to, `.` for the root itself; absent before step 5. */
      readonly resolved?: string;
    };

/** The resolved path of a reference naming the root itself. */
export const ROOT_RESOLVED = ".";

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const MALFORMED_PERCENT_ESCAPE = /%(?![0-9A-Fa-f]{2})/;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A URL's path as written: what is left once the fragment, then the query, are dropped. */
function urlPathPart(reference: string): string {
  return reference.split("#", 1)[0]!.split("?", 1)[0]!;
}

function countControlCharacters(text: string): number {
  let count = 0;
  for (const character of text) if (holdsControlCharacter(character)) count += 1;
  return count;
}

/**
 * Whether a reference is a file reference at all. Every reference in a bundle field is one. In a
 * URL, one naming a scheme (`https:`, `data:`, `mailto:`), one with an authority (`//host/x`) and
 * one with no path once its query and fragment are dropped (`?v=2`, `#top`, the empty URL) are
 * left exactly as written and never refused.
 */
export function isFileReference(reference: string, context: ReferenceContext): boolean {
  if (context === "path") return true;
  if (SCHEME.test(reference)) return false;
  const pathPart = urlPathPart(reference);
  return pathPart !== "" && !pathPart.startsWith("//");
}

/**
 * Percent-decode one URL segment, strictly: every `%` starts a two-digit escape, and each run of
 * escaped bytes decodes as UTF-8. `null` when the segment is malformed.
 */
function percentDecodeSegment(segment: string): string | null {
  if (MALFORMED_PERCENT_ESCAPE.test(segment)) return null;
  let decoded = "";
  let index = 0;
  while (index < segment.length) {
    if (segment[index] !== "%") {
      decoded += segment[index];
      index += 1;
      continue;
    }
    const bytes: number[] = [];
    while (index < segment.length && segment[index] === "%") {
      bytes.push(Number.parseInt(segment.slice(index + 1, index + 3), 16));
      index += 3;
    }
    try {
      decoded += strictUtf8.decode(Uint8Array.from(bytes));
    } catch {
      return null;
    }
  }
  return decoded;
}

/** Steps 1 to 4: the path a file reference names, decoded and in NFC, or the code refusing it. */
function referencePath(
  reference: string,
  context: ReferenceContext,
): { path: string } | { code: ReferenceRefusalCode } {
  let path: string;
  if (context === "path") {
    if (reference === "") return { code: "reference_not_a_tree_path" };
    if (SCHEME.test(reference) || reference.startsWith("/") || reference.includes("\\")) {
      return { code: "reference_invalid" };
    }
    path = reference;
  } else {
    const pathPart = urlPathPart(reference);
    if (pathPart.startsWith("/") || pathPart.includes("\\")) return { code: "reference_invalid" };
    const segments: string[] = [];
    for (const segment of pathPart.split("/")) {
      const decoded = percentDecodeSegment(segment);
      if (decoded === null) return { code: "reference_invalid" };
      // Decoding never creates a separator or a control character; one written as such is no
      // malformation, and the joined result is then refused as not a tree path.
      const makesControl = countControlCharacters(decoded) > countControlCharacters(segment);
      if (decoded.includes("/") || decoded.includes("\\") || makesControl) {
        return { code: "reference_invalid" };
      }
      segments.push(decoded);
    }
    path = segments.join("/");
  }
  return { path: path.normalize("NFC") };
}

/**
 * Step 5: join the path to the directory of the holding file and normalize it lexically, dropping
 * each `.` and letting each `..` remove the segment before it. `null` when a `..` climbs above the
 * root; an empty list for the root itself.
 */
function lexicalJoin(holder: string, path: string): string[] | null {
  const resolved: string[] = [];
  for (const segment of [...holder.split("/").slice(0, -1), ...path.split("/")]) {
    if (segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) return null;
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved;
}

export interface ResolveFileReferenceInput {
  /** The tree path of the file holding the reference. */
  readonly holder: string;
  /** The reference as written. */
  readonly reference: string;
  readonly context: ReferenceContext;
  /** Whether a tree path names a file of the tree. */
  readonly isMember: (treePath: string) => boolean;
  /** Whether the tree is the one-file tree of a `.mthds` file named alone with no manifest. */
  readonly oneFileTree?: boolean;
}

/**
 * Resolve a file reference by the standard's seven steps; the first step that fails decides the
 * refusal. In the one-file tree of a lone file, a reference that passes the first six steps and
 * names no file of the tree is refused as made from a one-file tree, since the author has to run
 * the method's directory or add a manifest; one refused earlier keeps its refusal.
 */
export function resolveFileReference(input: ResolveFileReferenceInput): BareReferenceResolution {
  const { holder, reference, context, isMember } = input;
  if (!isFileReference(reference, context)) return { kind: "not_a_reference" };
  const named = referencePath(reference, context);
  if ("code" in named) return { kind: "refused", code: named.code, reference };
  const segments = lexicalJoin(holder, named.path);
  if (segments === null) return { kind: "refused", code: "reference_leaves_tree", reference };
  // Step 6: a result naming the root, with no segment or with only a trailing `/` (`../` held by
  // `templates/letter.html`), is the root itself, refused at step 7 with resolved path `.`.
  const namesRoot = segments.length === 0 || (segments.length === 1 && segments[0] === "");
  const joined = namesRoot ? "" : segments.join("/");
  if (!namesRoot && treePathViolation(joined) !== null) {
    return { kind: "refused", code: "reference_not_a_tree_path", reference, resolved: joined };
  }
  if (input.oneFileTree === true && (namesRoot || !isMember(joined))) {
    return { kind: "refused", code: "reference_in_one_file_tree", reference };
  }
  if (namesRoot) {
    return { kind: "refused", code: "reference_not_in_tree", reference, resolved: ROOT_RESOLVED };
  }
  if (!isMember(joined)) {
    return { kind: "refused", code: "reference_not_in_tree", reference, resolved: joined };
  }
  return { kind: "tree_path", treePath: joined };
}
