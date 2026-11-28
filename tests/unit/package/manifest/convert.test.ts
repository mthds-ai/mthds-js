import { describe, expect, it } from "vitest";

import {
  legacyToParsedManifest,
  parsedManifestToLegacy,
} from "../../../../src/package/manifest/convert.js";
import type { ParsedManifest } from "../../../../src/package/manifest/schema.js";

const BASE: ParsedManifest = {
  name: "tools",
  address: "github.com/acme/tools",
  version: "1.0.0",
  description: "Useful tools.",
  authors: [],
  exports: {},
};

describe("the bridge between the flat and the nested manifest", () => {
  it.each([
    ["a list", ["legal", "customer-support"]],
    ["a repeated entry", ["legal", "legal"]],
    ["an empty array", []],
  ])("carries categories both ways: %s", (_topic, categories) => {
    const legacy = parsedManifestToLegacy({ ...BASE, categories });
    expect(legacy.package.categories).toEqual(categories);
    expect(legacyToParsedManifest(legacy).categories).toEqual(categories);
  });

  it("leaves categories out both ways when the manifest declares none", () => {
    const legacy = parsedManifestToLegacy(BASE);
    expect(legacy.package).not.toHaveProperty("categories");
    expect(legacyToParsedManifest(legacy)).not.toHaveProperty("categories");
  });
});

describe("the bridge carries the result line and the examples", () => {
  it("carries both both ways, an empty examples array included", () => {
    for (const examples of [["examples/a.json", "examples/b.json"], []]) {
      const parsed: ParsedManifest = {
        ...BASE,
        mainPipe: "do_thing",
        resultLine: "{{ output.total }} due",
        examples,
      };
      const legacy = parsedManifestToLegacy(parsed);
      expect(legacy.package.result_line).toBe("{{ output.total }} due");
      expect(legacy.package.examples).toEqual(examples);
      expect(legacyToParsedManifest(legacy)).toEqual(parsed);
    }
  });

  it("leaves both out both ways when the manifest declares neither", () => {
    const legacy = parsedManifestToLegacy(BASE);
    expect(legacy.package).not.toHaveProperty("result_line");
    expect(legacy.package).not.toHaveProperty("examples");
    expect(legacyToParsedManifest(legacy)).not.toHaveProperty("resultLine");
    expect(legacyToParsedManifest(legacy)).not.toHaveProperty("examples");
  });
});
