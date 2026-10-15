/**
 * Locating a `PipeFunc`'s function in its tree (mthds/docs/spec/method-tree.md, "Python Modules"):
 * `function_name` is a Python import path from the root of the tree, `funcs.text_utils.shout`
 * naming the function `shout` of the module `funcs/text_utils.py` or `funcs/text_utils/__init__.py`.
 */

export type FunctionNameRefusalCode =
  | "function_name_without_module"
  | "function_name_invalid_segment"
  | "module_not_in_tree"
  | "module_ambiguous";

export type FunctionLocation =
  | { readonly kind: "located"; readonly module: string; readonly function: string }
  | {
      readonly kind: "refused";
      readonly code: FunctionNameRefusalCode;
      /** The function name, or both module files for `module_ambiguous`. */
      readonly names: readonly string[];
    };

/** Python's hard keywords, which no segment may be (`keyword.kwlist`). */
const PYTHON_KEYWORDS: ReadonlySet<string> = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "while",
  "with",
  "yield",
]);

/** Python's `str.isidentifier()`: an `XID_Start` character or `_`, then `XID_Continue` ones. */
const PYTHON_IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u;

/**
 * Whether a segment of a function name is acceptable: a Python identifier, not a keyword, and left
 * unchanged by NFKC. Python reads identifiers in NFKC, so a segment NFKC changes, such as one
 * holding the ligature `ﬁ` or a fullwidth letter, would import a module of another name; it is
 * refused rather than mapped.
 */
function isValidSegment(segment: string): boolean {
  return (
    PYTHON_IDENTIFIER.test(segment) &&
    !PYTHON_KEYWORDS.has(segment) &&
    segment.normalize("NFKC") === segment
  );
}

/**
 * Split a function name at its last dot and find its module among the tree's files. The name is
 * normalized to NFC first, as tree paths are.
 */
export function locateFunction(
  functionName: string,
  isMember: (treePath: string) => boolean,
): FunctionLocation {
  const name = functionName.normalize("NFC");
  if (!name.includes(".")) {
    return { kind: "refused", code: "function_name_without_module", names: [functionName] };
  }
  const segments = name.split(".");
  if (!segments.every(isValidSegment)) {
    return { kind: "refused", code: "function_name_invalid_segment", names: [functionName] };
  }
  const modulePath = segments.slice(0, -1).join("/");
  const held = [`${modulePath}.py`, `${modulePath}/__init__.py`].filter(isMember);
  if (held.length === 0) {
    return { kind: "refused", code: "module_not_in_tree", names: [functionName] };
  }
  if (held.length > 1) return { kind: "refused", code: "module_ambiguous", names: held };
  return { kind: "located", module: held[0]!, function: segments[segments.length - 1]! };
}
