import { describe, it, expect } from "vitest";
import { parseAddress } from "../../../../src/installer/resolver/address.js";

describe("parseAddress", () => {
  it("parses org/repo", () => {
    const r = parseAddress("pipelex/cookbook");
    expect(r.org).toBe("pipelex");
    expect(r.repo).toBe("cookbook");
    expect(r.subpath).toBeNull();
  });

  it("parses org/repo/sub/path", () => {
    const r = parseAddress("acme/monorepo/packages/legal");
    expect(r.org).toBe("acme");
    expect(r.repo).toBe("monorepo");
    expect(r.subpath).toBe("packages/legal");
  });

  it("strips github.com/ prefix", () => {
    const r = parseAddress("github.com/pipelex/cookbook");
    expect(r.org).toBe("pipelex");
    expect(r.repo).toBe("cookbook");
    expect(r.subpath).toBeNull();
  });

  it("strips trailing slash", () => {
    const r = parseAddress("pipelex/cookbook/");
    expect(r.org).toBe("pipelex");
    expect(r.repo).toBe("cookbook");
    expect(r.subpath).toBeNull();
  });

  it("rejects single segment", () => {
    expect(() => parseAddress("justorg")).toThrow("at least org/repo");
  });

  it("rejects invalid characters", () => {
    expect(() => parseAddress("org/repo with space")).toThrow(
      "Invalid address segment"
    );
  });

  it("rejects empty string", () => {
    expect(() => parseAddress("")).toThrow("at least org/repo");
  });
});
