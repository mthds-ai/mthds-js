import { describe, it, expect } from "vitest";

import {
  describeUnusableMethod,
  findSkippedMethod,
  skippedMethodReports,
} from "../../../../src/installer/resolver/skipped.js";
import type { ResolvedRepo } from "../../../../src/package/manifest/types.js";

const INCOMPATIBLE =
  '[package.mthds_version] "^1.0.0" is not satisfied by the MTHDS standard version this implementation implements (2.0.0).';

function repo(overrides: Partial<ResolvedRepo> = {}): ResolvedRepo {
  return {
    methods: [
      {
        name: "new_tool",
        manifest: {
          package: {
            name: "new_tool",
            address: "github.com/acme/tools",
            version: "1.0.0",
            description: "A new tool",
          },
        },
        rawManifest: "",
        files: [],
      },
    ],
    skipped: [{ dirName: "legacy_tool", errors: [INCOMPATIBLE] }],
    source: "local",
    repoName: "tools",
    isPublic: false,
    ...overrides,
  };
}

describe("findSkippedMethod", () => {
  it("matches a refused method by the directory name --method takes", () => {
    expect(findSkippedMethod(repo(), "legacy_tool")?.errors).toEqual([INCOMPATIBLE]);
  });

  it("returns undefined for a name in neither list", () => {
    expect(findSkippedMethod(repo(), "typo_tool")).toBeUndefined();
  });
});

describe("describeUnusableMethod", () => {
  it("gives the reason the resolver produced, not 'not found'", () => {
    const message = describeUnusableMethod(repo(), "legacy_tool");

    expect(message).toContain('Method "legacy_tool" was found but skipped');
    expect(message).toContain(INCOMPATIBLE);
    expect(message).not.toContain("not found");
  });

  it("lists every reason when a manifest failed several checks", () => {
    const resolved = repo({
      skipped: [
        { dirName: "legacy_tool", errors: [INCOMPATIBLE, "[exports] section is required."] },
      ],
    });

    const message = describeUnusableMethod(resolved, "legacy_tool");

    expect(message).toContain(INCOMPATIBLE);
    expect(message).toContain("[exports] section is required.");
  });

  it("still says 'not found' for a name that is genuinely absent", () => {
    const message = describeUnusableMethod(repo(), "typo_tool");

    expect(message).toBe('Method "typo_tool" not found. Available methods: new_tool');
  });

  it("says '(none)' rather than an empty list when nothing survived", () => {
    const message = describeUnusableMethod(repo({ methods: [] }), "typo_tool");

    expect(message).toBe('Method "typo_tool" not found. Available methods: (none)');
  });
});

describe("skippedMethodReports", () => {
  it("reports each refused method under the name --method would take", () => {
    expect(skippedMethodReports(repo())).toEqual([{ name: "legacy_tool", errors: [INCOMPATIBLE] }]);
  });

  it("is an empty array — not absent — when nothing was refused", () => {
    expect(skippedMethodReports(repo({ skipped: [] }))).toEqual([]);
  });

  it("copies the errors, so a consumer cannot mutate the resolver's list", () => {
    const resolved = repo();
    skippedMethodReports(resolved)[0]!.errors.push("injected");

    expect(resolved.skipped[0]!.errors).toEqual([INCOMPATIBLE]);
  });
});
