import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CASE_FOLDING_UNICODE_VERSION,
  caseFold,
  compareUtf8,
  fullCaseFold,
  pathCollisions,
  treeDigest,
  treeListing,
  treePathViolation,
} from "../../../src/method-tree/index.js";

describe("case folding", () => {
  it("is generated from a Unicode version the standard allows, 14.0 or later", () => {
    const [major] = CASE_FOLDING_UNICODE_VERSION.split(".").map(Number);
    expect(major).toBeGreaterThanOrEqual(14);
  });

  it("is full folding, which reaches further than lowercase", () => {
    expect(fullCaseFold("STRASSE")).toBe(fullCaseFold("stra\u00dfe"));
    expect(caseFold("\u1e9e.txt")).toBe(caseFold("\u00df.txt"));
    expect(caseFold("\u03bb\u03bf\u03b3\u03bf\u03c2")).toBe(
      caseFold("\u03bb\u03bf\u03b3\u03bf\u03c3"),
    );
    expect(caseFold("\u017fample")).toBe(caseFold("sample"));
    expect("\u00df".toLowerCase()).not.toBe("ss");
  });

  it("applies no Turkic tailoring", () => {
    expect(fullCaseFold("I")).toBe("i");
    expect(fullCaseFold("\u0130")).toBe("i\u0307");
  });

  it("normalizes to NFC before and after folding", () => {
    expect(caseFold("CAFE\u0301")).toBe("caf\u00e9");
  });

  it("is what the committed table's source generates", () => {
    const script = fileURLToPath(new URL("../../../scripts/gen-case-folding.mjs", import.meta.url));
    expect(() => execFileSync("node", [script, "--check"], { stdio: "pipe" })).not.toThrow();
  });
});

describe("pathCollisions", () => {
  it("names every path equal to another once folded, sorted byte for byte", () => {
    expect(pathCollisions(["readme.md", "README.md", "other.txt"])).toEqual([
      "README.md",
      "readme.md",
    ]);
  });

  it("names a path colliding with a directory of another, and the paths under it", () => {
    expect(pathCollisions(["Templates", "templates/a.html", "templates/b.html"])).toEqual([
      "Templates",
      "templates/a.html",
      "templates/b.html",
    ]);
  });

  it("lets directories differing in case hold different files", () => {
    expect(pathCollisions(["Docs/a.md", "docs/b.md"])).toEqual([]);
  });
});

describe("tree paths", () => {
  it("are compared byte for byte on UTF-8, not on UTF-16 code units", () => {
    const astral = "\u{1f600}";
    const privateUse = "\ue000";
    expect(astral < privateUse).toBe(true);
    expect(compareUtf8(astral, privateUse)).toBeGreaterThan(0);
  });

  it("refuse what the standard refuses", () => {
    expect(treePathViolation("a/b.txt")).toBeNull();
    expect(treePathViolation("")).not.toBeNull();
    expect(treePathViolation("a\\b")).not.toBeNull();
    expect(treePathViolation("cafe\u0301")).not.toBeNull();
    expect(treePathViolation("\ud800")).not.toBeNull();
    expect(treePathViolation("a".repeat(256))).not.toBeNull();
    expect(treePathViolation(Array(205).fill("abcd").join("/"))).toBeNull();
    expect(treePathViolation(Array(206).fill("abcd").join("/"))).not.toBeNull();
  });
});

describe("the tree digest", () => {
  it("is the standard's greetings example", () => {
    const files = [
      {
        path: "templates/card.html",
        sha256: "3e9b68b71cc667168399f0bccfb64b2d16314cdc0ed78fac4819aba0dda121a0",
      },
      {
        path: "README.md",
        sha256: "af12591480ada38cf107d1a76bc5e2e111ad4c7ec5f3a2a63d058f5f5ab6b91c",
      },
      {
        path: "main.mthds",
        sha256: "45b0d6a4796412598db6d328978990fc44563e59057d6e3bfc8419ae3ed3981f",
      },
      {
        path: "funcs/text_utils.py",
        sha256: "d78fff51f2aea9cb634456d3c83925ae047d967798f28e8a4b3e7b232a1dc097",
      },
    ];
    expect(treeListing(files).split("\n")[0]).toBe(
      "af12591480ada38cf107d1a76bc5e2e111ad4c7ec5f3a2a63d058f5f5ab6b91c  README.md",
    );
    expect(treeDigest(files)).toBe(
      "sha256:801fca61b41566e46d3fb1923e323590da7a539fd3e7af7455e7cba3934d4674",
    );
  });
});
