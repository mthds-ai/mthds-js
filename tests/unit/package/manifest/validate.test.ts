import { describe, it, expect } from "vitest";
import { validateManifest, validateSlug } from "../../../../src/package/manifest/validate.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const minimal = `
[package]
address = "github.com/acme/tools"
version = "1.0.0"
description = "Useful tools."
`;

function toml(extra: string): string {
  return `${minimal}\n${extra}`;
}

// ---------------------------------------------------------------------------
// validateManifest — valid manifests
// ---------------------------------------------------------------------------
describe("validateManifest — valid", () => {
  it("accepts minimal valid manifest", () => {
    const r = validateManifest(minimal);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.manifest).toBeDefined();
    expect(r.manifest!.package.address).toBe("github.com/acme/tools");
    expect(r.manifest!.package.version).toBe("1.0.0");
    expect(r.manifest!.package.description).toBe("Useful tools.");
  });

  it("accepts all optional package fields", () => {
    const raw = `
[package]
address       = "github.com/acme/legal-tools"
version       = "0.3.0"
description   = "Legal document analysis methods."
display_name  = "Legal Tools"
authors       = ["ACME <legal@acme.com>", "Bob"]
license       = "MIT"
mthds_version = ">=1.0.0"
`;
    const r = validateManifest(raw);
    expect(r.valid).toBe(true);
    expect(r.manifest!.package.display_name).toBe("Legal Tools");
    expect(r.manifest!.package.authors).toEqual(["ACME <legal@acme.com>", "Bob"]);
    expect(r.manifest!.package.license).toBe("MIT");
    expect(r.manifest!.package.mthds_version).toBe(">=1.0.0");
  });

  it("accepts flat exports with pipes", () => {
    const raw = toml(`
[exports.legal]
pipes = ["classify_document"]
`);
    const r = validateManifest(raw);
    expect(r.valid).toBe(true);
    expect(r.manifest!.exports!["legal"]!.pipes).toEqual(["classify_document"]);
  });

  it("accepts nested hierarchical exports", () => {
    const raw = toml(`
[exports.legal]
pipes = ["classify_document"]

[exports.legal.contracts]
pipes = ["extract_clause", "analyze_nda"]
`);
    const r = validateManifest(raw);
    expect(r.valid).toBe(true);
    const legal = r.manifest!.exports!["legal"]!;
    expect(legal.pipes).toEqual(["classify_document"]);
    const contracts = legal["contracts"] as { pipes: string[] };
    expect(contracts.pipes).toEqual(["extract_clause", "analyze_nda"]);
  });

  it("rejects dependencies section", () => {
    const raw = toml(`
[dependencies]
docproc = { address = "github.com/mthds/document-processing", version = "^1.0.0" }
`);
    const r = validateManifest(raw);
    expect(r.valid).toBe(false);
    expect(r.errors).toContainEqual(
      expect.stringContaining("not supported")
    );
  });

  it("accepts complete example from spec", () => {
    const raw = `
[package]
address       = "github.com/acme/legal-tools"
version       = "0.3.0"
description   = "Legal document analysis methods."
display_name  = "Legal Tools"
authors       = ["ACME <legal@acme.com>"]
license       = "MIT"
mthds_version = ">=1.0.0"

[exports.legal]
pipes = ["classify_document"]

[exports.legal.contracts]
pipes = ["extract_clause", "analyze_nda"]
`;
    const r = validateManifest(raw);
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateManifest — invalid manifests
// ---------------------------------------------------------------------------
describe("validateManifest — invalid", () => {
  it("rejects missing [package] section", () => {
    const r = validateManifest("[exports]\n");
    expect(r.valid).toBe(false);
    expect(r.errors).toContainEqual(
      expect.stringContaining("[package] section is required")
    );
  });

  it("rejects missing address", () => {
    const raw = `
[package]
version = "1.0.0"
description = "Test."
`;
    const r = validateManifest(raw);
    expect(r.valid).toBe(false);
    expect(r.errors).toContainEqual(
      expect.stringContaining("[package.address]")
    );
  });

  it("rejects missing version", () => {
    const raw = `
[package]
address = "github.com/a/b"
description = "Test."
`;
    const r = validateManifest(raw);
    expect(r.valid).toBe(false);
    expect(r.errors).toContainEqual(
      expect.stringContaining("[package.version]")
    );
  });

  it("rejects missing description", () => {
    const raw = `
[package]
address = "github.com/a/b"
version = "1.0.0"
`;
    const r = validateManifest(raw);
    expect(r.valid).toBe(false);
    expect(r.errors).toContainEqual(
      expect.stringContaining("[package.description]")
    );
  });

  it("rejects address without hostname dot", () => {
    const raw = `
[package]
address = "acme/tools"
version = "1.0.0"
description = "Test."
`;
    const r = validateManifest(raw);
    expect(r.valid).toBe(false);
    expect(r.errors).toContainEqual(
      expect.stringContaining("hostname must contain a dot")
    );
  });

  it("rejects invalid semver version", () => {
    const raw = `
[package]
address = "github.com/a/b"
version = "not-semver"
description = "Test."
`;
    const r = validateManifest(raw);
    expect(r.valid).toBe(false);
    expect(r.errors).toContainEqual(
      expect.stringContaining("valid semver")
    );
  });

  it("rejects empty description", () => {
    const raw = `
[package]
address = "github.com/a/b"
version = "1.0.0"
description = ""
`;
    const r = validateManifest(raw);
    expect(r.valid).toBe(false);
    expect(r.errors).toContainEqual(
      expect.stringContaining("[package.description]")
    );
  });

  it("rejects display_name over 128 chars", () => {
    const longName = "A".repeat(129);
    const raw = `
[package]
address = "github.com/a/b"
version = "1.0.0"
description = "Test."
display_name = "${longName}"
`;
    const r = validateManifest(raw);
    expect(r.valid).toBe(false);
    expect(r.errors).toContainEqual(
      expect.stringContaining("at most 128 characters")
    );
  });

  it("rejects authors that is not an array", () => {
    const raw = `
[package]
address = "github.com/a/b"
version = "1.0.0"
description = "Test."
authors = "single-string"
`;
    const r = validateManifest(raw);
    expect(r.valid).toBe(false);
    expect(r.errors).toContainEqual(
      expect.stringContaining("[package.authors] must be an array")
    );
  });

  it("rejects license that is not a string", () => {
    const raw = `
[package]
address = "github.com/a/b"
version = "1.0.0"
description = "Test."
license = 42
`;
    const r = validateManifest(raw);
    expect(r.valid).toBe(false);
    expect(r.errors).toContainEqual(
      expect.stringContaining("[package.license] must be a string")
    );
  });

  it("rejects reserved export prefix (native)", () => {
    const raw = toml(`
[exports.native]
pipes = ["do_thing"]
`);
    const r = validateManifest(raw);
    expect(r.valid).toBe(false);
    expect(r.errors).toContainEqual(
      expect.stringContaining('reserved prefix "native"')
    );
  });

  it("rejects reserved export prefix (mthds)", () => {
    const raw = toml(`
[exports.mthds]
pipes = ["do_thing"]
`);
    const r = validateManifest(raw);
    expect(r.valid).toBe(false);
    expect(r.errors).toContainEqual(
      expect.stringContaining('reserved prefix "mthds"')
    );
  });

  it("rejects reserved export prefix (pipelex)", () => {
    const raw = toml(`
[exports.pipelex]
pipes = ["do_thing"]
`);
    const r = validateManifest(raw);
    expect(r.valid).toBe(false);
    expect(r.errors).toContainEqual(
      expect.stringContaining('reserved prefix "pipelex"')
    );
  });

  it("rejects non-snake_case pipe name in exports", () => {
    const raw = toml(`
[exports.legal]
pipes = ["BadName"]
`);
    const r = validateManifest(raw);
    expect(r.valid).toBe(false);
    expect(r.errors).toContainEqual(
      expect.stringContaining('"BadName" must be snake_case')
    );
  });

  it("rejects any dependencies section with generic error", () => {
    const raw = toml(`
[dependencies]
dep = { address = "github.com/a/b", version = "1.0.0" }
`);
    const r = validateManifest(raw);
    expect(r.valid).toBe(false);
    expect(r.errors).toContainEqual(
      expect.stringContaining("not supported")
    );
  });

  it("rejects malformed TOML", () => {
    const r = validateManifest("this is [[ not valid toml");
    expect(r.valid).toBe(false);
    expect(r.errors).toContainEqual(
      expect.stringContaining("TOML parse error")
    );
  });

  it("collects multiple errors at once", () => {
    const raw = `
[package]
address = "no-dot"
version = "bad"
description = ""
`;
    const r = validateManifest(raw);
    expect(r.valid).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// validateSlug
// ---------------------------------------------------------------------------
describe("validateSlug", () => {
  it("accepts valid slugs", () => {
    expect(validateSlug("my-method").valid).toBe(true);
    expect(validateSlug("tool123").valid).toBe(true);
    expect(validateSlug("a").valid).toBe(true);
    expect(validateSlug("legal-tools").valid).toBe(true);
  });

  it("rejects slug starting with digit", () => {
    const r = validateSlug("1tool");
    expect(r.valid).toBe(false);
    expect(r.error).toBeDefined();
  });

  it("rejects uppercase slug", () => {
    const r = validateSlug("MyMethod");
    expect(r.valid).toBe(false);
    expect(r.error).toBeDefined();
  });

  it("rejects special characters", () => {
    const r = validateSlug("my_method");
    expect(r.valid).toBe(false);
    expect(r.error).toBeDefined();
  });

  it("rejects empty slug", () => {
    const r = validateSlug("");
    expect(r.valid).toBe(false);
    expect(r.error).toContain("empty");
  });

  it("rejects slug over 64 chars", () => {
    const r = validateSlug("a".repeat(65));
    expect(r.valid).toBe(false);
    expect(r.error).toContain("64");
  });
});
