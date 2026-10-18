import { describe, expect, it } from "vitest";
import {
  describeTreeFiles,
  installedMethodFiles,
  resolvedMethodTree,
} from "../../../src/installer/methods/method-files.js";
import { sha256Hex, treeDigest } from "../../../src/method-tree/digest.js";
import type { MethodsFile, ResolvedMethod } from "../../../src/package/manifest/types.js";

const MANIFEST = "[package]\nname = 'demo'\n";
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function method(files: MethodsFile[]): ResolvedMethod {
  return {
    name: "demo",
    manifest: {} as ResolvedMethod["manifest"],
    rawManifest: MANIFEST,
    files,
  };
}

describe("resolvedMethodTree", () => {
  it("validates a method as its whole tree, its bytes kept and its digest computed as a lister computes it", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
    const tree = resolvedMethodTree(
      method([
        { path: "METHODS.toml", bytes: encode(MANIFEST) },
        { path: "bundle.mthds", bytes: encode("domain = 'demo'") },
        { path: "funcs/f.py", bytes: encode("def f(): ...\n") },
        { path: "images/logo.png", bytes: png },
      ]),
    );
    expect(tree.files.map((file) => file.path)).toEqual([
      "METHODS.toml",
      "bundle.mthds",
      "funcs/f.py",
      "images/logo.png",
    ]);
    const logo = tree.files.find((file) => file.path === "images/logo.png")!;
    expect(logo).toEqual({ path: "images/logo.png", size: png.length, sha256: sha256Hex(png) });
    expect(tree.digest).toBe(treeDigest(tree.files));
    expect([...(await tree.readFile("images/logo.png"))]).toEqual([...png]);
    await expect(tree.readFile("missing.txt")).rejects.toThrow(/not a file/);
  });

  it("adds the manifest the resolver read when the tree leaves it out, as the install writes it", () => {
    const files = installedMethodFiles(method([{ path: "bundle.mthds", bytes: encode("x") }]));
    expect(files.map((file) => file.path)).toEqual(["METHODS.toml", "bundle.mthds"]);
    expect(new TextDecoder().decode(files[0]!.bytes)).toBe(MANIFEST);
  });
});

describe("describeTreeFiles", () => {
  it("counts the tree's files and its bundles", () => {
    expect(
      describeTreeFiles(
        method([
          { path: "METHODS.toml", bytes: encode(MANIFEST) },
          { path: "bundle.mthds", bytes: encode("x") },
          { path: "funcs/f.py", bytes: encode("y") },
        ]),
      ),
    ).toBe("3 files, 1 .mthds bundle");
  });
});
