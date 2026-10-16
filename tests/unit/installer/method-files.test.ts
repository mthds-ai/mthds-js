import { describe, expect, it } from "vitest";
import { resolvedMethodFiles } from "../../../src/installer/methods/method-files.js";
import type { ResolvedMethod } from "../../../src/package/manifest/types.js";

function method(files: { relativePath: string; content: string }[]): ResolvedMethod {
  return {
    name: "demo",
    manifest: {} as ResolvedMethod["manifest"],
    rawManifest: "[package]\nname = 'demo'\n",
    files,
  };
}

describe("resolvedMethodFiles", () => {
  it("validates a method as its manifest at the root and its bundles under their tree paths", () => {
    const files = resolvedMethodFiles(
      method([
        { relativePath: "bundle.mthds", content: "domain = 'demo'" },
        { relativePath: "steps/step.mthds", content: "domain = 'demo'" },
      ]),
    );
    expect(files).toEqual({
      "METHODS.toml": "[package]\nname = 'demo'\n",
      "bundle.mthds": "domain = 'demo'",
      "steps/step.mthds": "domain = 'demo'",
    });
  });

  it("leaves out a path the membership rule could never admit", () => {
    const files = resolvedMethodFiles(
      method([
        { relativePath: "bundle.mthds", content: "domain = 'demo'" },
        { relativePath: ".venv/lib/x.mthds", content: "domain = 'venv'" },
        { relativePath: "node_modules/y.mthds", content: "domain = 'deps'" },
      ]),
    );
    expect(Object.keys(files)).toEqual(["METHODS.toml", "bundle.mthds"]);
  });
});
