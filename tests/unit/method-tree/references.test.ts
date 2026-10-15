import { describe, expect, it } from "vitest";
import {
  locateFunction,
  resolveFileReference,
  type BareReferenceResolution,
  type ReferenceContext,
} from "../../../src/method-tree/index.js";

const MEMBERS = new Set(["main.mthds", "templates/letter.html", "shared/logo.png", "caf\u00e9.py"]);

function resolve(
  holder: string,
  reference: string,
  context: ReferenceContext,
  oneFileTree = false,
): BareReferenceResolution {
  return resolveFileReference({
    holder,
    reference,
    context,
    isMember: (path) => MEMBERS.has(path),
    oneFileTree,
  });
}

describe("resolveFileReference", () => {
  it("resolves the standard's example", () => {
    expect(resolve("templates/letter.html", "../shared/logo.png", "path")).toEqual({
      kind: "tree_path",
      treePath: "shared/logo.png",
    });
  });

  it("refuses a reference naming the root with a trailing slash as not in the tree, resolved '.'", () => {
    for (const [holder, reference] of [
      ["templates/letter.html", "../"],
      ["main.mthds", "./"],
      ["main.mthds", "templates/../"],
      ["templates/letter.html", "../"],
    ] as const) {
      for (const context of ["path", "url"] as const) {
        expect(resolve(holder, reference, context)).toEqual({
          kind: "refused",
          code: "reference_not_in_tree",
          reference,
          resolved: ".",
        });
      }
    }
  });

  it("refuses a reference naming the root from a one-file tree as made from a one-file tree", () => {
    expect(resolve("main.mthds", "./", "path", true)).toEqual({
      kind: "refused",
      code: "reference_in_one_file_tree",
      reference: "./",
    });
  });

  it("refuses a result with an empty segment as not a tree path", () => {
    expect(resolve("main.mthds", "templates/", "path")).toEqual({
      kind: "refused",
      code: "reference_not_a_tree_path",
      reference: "templates/",
      resolved: "templates/",
    });
    expect(resolve("templates/letter.html", "..//", "path")).toMatchObject({
      code: "reference_not_a_tree_path",
      resolved: "/",
    });
  });

  it("percent-decodes a URL segment by segment, strictly", () => {
    expect(resolve("main.mthds", "caf%C3%A9.py", "url")).toEqual({
      kind: "tree_path",
      treePath: "caf\u00e9.py",
    });
    for (const reference of ["a%2Fb", "a%5Cb", "caf%E9.py", "a%00b", "100%.png", "a%4"]) {
      expect(resolve("main.mthds", reference, "url")).toMatchObject({
        code: "reference_invalid",
      });
    }
  });

  it("keeps a byte order mark that a URL escapes", () => {
    expect(resolve("main.mthds", "%EF%BB%BFa.txt", "url")).toMatchObject({
      code: "reference_not_in_tree",
      resolved: "\ufeffa.txt",
    });
  });

  it("leaves a URL with a scheme, an authority or no path alone", () => {
    for (const reference of ["https://example.com/a.png", "//host/a.png", "#top", "?v=2", ""]) {
      expect(resolve("main.mthds", reference, "url")).toEqual({ kind: "not_a_reference" });
    }
  });

  it("normalizes a reference to NFC", () => {
    expect(resolve("main.mthds", "cafe\u0301.py", "path")).toEqual({
      kind: "tree_path",
      treePath: "caf\u00e9.py",
    });
  });
});

describe("locateFunction", () => {
  const members = new Set([
    "funcs/text.py",
    "caf\u00e9.py",
    "\ufb01le.py",
    "\uff46uncs.py",
    "tools.py",
    "tools/__init__.py",
  ]);
  const locate = (name: string) => locateFunction(name, (path) => members.has(path));

  it("normalizes the name to NFC first", () => {
    expect(locate("cafe\u0301.run")).toEqual({
      kind: "located",
      module: "caf\u00e9.py",
      function: "run",
    });
  });

  it("refuses a segment NFKC would change, even when the tree holds that spelling", () => {
    expect(locate("\ufb01le.run")).toEqual({
      kind: "refused",
      code: "function_name_invalid_segment",
      names: ["\ufb01le.run"],
    });
    expect(locate("\uff46uncs.run")).toMatchObject({ code: "function_name_invalid_segment" });
  });

  it("refuses keywords and non-identifiers, and names both modules when ambiguous", () => {
    expect(locate("class.run")).toMatchObject({ code: "function_name_invalid_segment" });
    expect(locate("my-funcs.run")).toMatchObject({ code: "function_name_invalid_segment" });
    expect(locate("run")).toMatchObject({ code: "function_name_without_module" });
    expect(locate("tools.run")).toEqual({
      kind: "refused",
      code: "module_ambiguous",
      names: ["tools.py", "tools/__init__.py"],
    });
    expect(locate("funcs.text.shout")).toEqual({
      kind: "located",
      module: "funcs/text.py",
      function: "shout",
    });
  });
});
