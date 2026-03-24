import { describe, expect, it } from "vitest";
import { resolveFileOrInline } from "../../../../src/agent/commands/runner-commands.js";

describe("runner commands", () => {
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
