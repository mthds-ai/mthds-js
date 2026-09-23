import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MTHDS_JS_VERSION } from "../../src/version.js";

describe("MTHDS_JS_VERSION", () => {
  // The constant is what the User-Agent reports; it must never drift from the
  // manifest the package is published with.
  it("equals package.json's version", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as {
      version: string;
    };
    expect(MTHDS_JS_VERSION).toBe(pkg.version);
  });
});
