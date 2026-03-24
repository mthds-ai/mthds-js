import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";

/**
 * Exercises the file-or-inline resolution logic used by the assemble command
 * for --concepts / --pipes arguments. The helper is inlined in pipelex.ts;
 * we replicate its branching here to verify the ENOENT-vs-other-error contract.
 */
function resolveFileOrInline(value: string): string {
  try {
    return readFileSync(value, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return value; // treat as inline TOML
    }
    throw err;
  }
}

describe("pipelex commands", () => {
  it("resolveFileOrInline returns inline TOML when path does not exist", () => {
    const inline = '[concept.Greeting]\ndescription = "A greeting"';
    expect(resolveFileOrInline(inline)).toBe(inline);
  });

  it("resolveFileOrInline reads file contents when path exists", () => {
    // package.json always exists at the repo root
    const content = resolveFileOrInline("package.json");
    expect(content).toContain('"name"');
  });
});
