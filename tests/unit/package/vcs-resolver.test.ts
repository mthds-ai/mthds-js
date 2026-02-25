import { describe, it, expect, vi, beforeEach } from "vitest";
import { addressToCloneUrl, resolveVersionFromTags } from "../../../src/package/vcs-resolver.js";
import { VersionResolutionError } from "../../../src/package/exceptions.js";
import { parseVersion } from "../../../src/package/semver.js";
import type { SemVer } from "semver";

// We test listRemoteVersionTags and cloneAtVersion only at the unit level for
// the synchronous parts; the async subprocess parts are covered by integration tests.

describe("addressToCloneUrl", () => {
  it("prepends https:// and appends .git", () => {
    expect(addressToCloneUrl("github.com/org/repo")).toBe("https://github.com/org/repo.git");
  });

  it("does not double-append .git", () => {
    expect(addressToCloneUrl("github.com/org/repo.git")).toBe("https://github.com/org/repo.git");
  });

  it("works with different hosts", () => {
    expect(addressToCloneUrl("gitlab.com/group/project")).toBe(
      "https://gitlab.com/group/project.git",
    );
  });
});

describe("resolveVersionFromTags", () => {
  function makeTags(...versions: string[]): Array<[SemVer, string]> {
    return versions.map((ver) => [parseVersion(ver), `v${ver}`]);
  }

  it("selects minimum version matching constraint (MVS)", () => {
    const tags = makeTags("1.0.0", "1.5.0", "2.0.0");
    const [selected, tag] = resolveVersionFromTags(tags, "^1.0.0");
    expect(selected.version).toBe("1.0.0");
    expect(tag).toBe("v1.0.0");
  });

  it("skips non-matching versions", () => {
    const tags = makeTags("0.9.0", "1.5.0", "2.0.0");
    const [selected] = resolveVersionFromTags(tags, "^1.0.0");
    expect(selected.version).toBe("1.5.0");
  });

  it("handles tilde constraint", () => {
    const tags = makeTags("1.0.0", "1.0.5", "1.1.0", "2.0.0");
    const [selected] = resolveVersionFromTags(tags, "~1.0.0");
    expect(selected.version).toBe("1.0.0");
  });

  it("handles exact version constraint", () => {
    const tags = makeTags("1.0.0", "1.5.0", "2.0.0");
    const [selected] = resolveVersionFromTags(tags, "1.5.0");
    expect(selected.version).toBe("1.5.0");
  });

  it("handles >=constraint", () => {
    const tags = makeTags("1.0.0", "1.5.0", "2.0.0");
    const [selected] = resolveVersionFromTags(tags, ">=1.5.0");
    expect(selected.version).toBe("1.5.0");
  });

  it("throws VersionResolutionError when no tags available", () => {
    expect(() => resolveVersionFromTags([], "^1.0.0")).toThrow(VersionResolutionError);
  });

  it("throws VersionResolutionError when no version matches", () => {
    const tags = makeTags("0.1.0", "0.2.0");
    expect(() => resolveVersionFromTags(tags, "^1.0.0")).toThrow(VersionResolutionError);
    expect(() => resolveVersionFromTags(tags, "^1.0.0")).toThrow(/No version satisfying/);
  });

  it("throws VersionResolutionError for invalid constraint", () => {
    const tags = makeTags("1.0.0");
    expect(() => resolveVersionFromTags(tags, "not-valid!!!")).toThrow(VersionResolutionError);
  });

  it("handles unsorted input versions", () => {
    const tags = makeTags("2.0.0", "1.0.0", "1.5.0");
    const [selected] = resolveVersionFromTags(tags, "^1.0.0");
    expect(selected.version).toBe("1.0.0");
  });

  it("selects among many versions", () => {
    const tags = makeTags("0.1.0", "0.2.0", "1.0.0", "1.1.0", "1.2.0", "2.0.0", "3.0.0");
    const [selected] = resolveVersionFromTags(tags, ">=2.0.0");
    expect(selected.version).toBe("2.0.0");
  });
});
