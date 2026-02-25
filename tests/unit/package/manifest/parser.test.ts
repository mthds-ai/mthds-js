import { describe, it, expect } from "vitest";
import { parseMethodsToml, serializeManifestToToml } from "../../../../src/package/manifest/parser.js";
import { ManifestParseError, ManifestValidationError } from "../../../../src/package/exceptions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MINIMAL_TOML = `
[package]
address = "github.com/acme/tools"
version = "1.0.0"
description = "Useful tools."
`;

function toml(extra: string): string {
  return `${MINIMAL_TOML}\n${extra}`;
}

// ---------------------------------------------------------------------------
// parseMethodsToml — valid manifests
// ---------------------------------------------------------------------------
describe("parseMethodsToml — valid", () => {
  it("parses minimal manifest", () => {
    const manifest = parseMethodsToml(MINIMAL_TOML);
    expect(manifest.address).toBe("github.com/acme/tools");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.description).toBe("Useful tools.");
    expect(manifest.authors).toEqual([]);
    expect(manifest.exports).toEqual({});
  });

  it("parses all optional package fields", () => {
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
    const manifest = parseMethodsToml(raw);
    expect(manifest.displayName).toBe("Legal Tools");
    expect(manifest.authors).toEqual(["ACME <legal@acme.com>", "Bob"]);
    expect(manifest.license).toBe("MIT");
    expect(manifest.mthdsVersion).toBe(">=1.0.0");
  });

  it("parses flat exports", () => {
    const raw = toml(`
[exports.legal]
pipes = ["classify_document"]
`);
    const manifest = parseMethodsToml(raw);
    expect(manifest.exports["legal"]).toEqual({ pipes: ["classify_document"] });
  });

  it("parses nested hierarchical exports into flat dotted keys", () => {
    const raw = toml(`
[exports.legal]
pipes = ["classify_document"]

[exports.legal.contracts]
pipes = ["extract_clause", "analyze_nda"]
`);
    const manifest = parseMethodsToml(raw);
    expect(manifest.exports["legal"]).toEqual({ pipes: ["classify_document"] });
    expect(manifest.exports["legal.contracts"]).toEqual({
      pipes: ["extract_clause", "analyze_nda"],
    });
  });

  it("rejects dependencies section", () => {
    const raw = toml(`
[dependencies]
docproc = { address = "github.com/mthds/document-processing", version = "^1.0.0" }
`);
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
    expect(() => parseMethodsToml(raw)).toThrow(/dependencies/);
  });

  it("parses prerelease version", () => {
    const raw = `
[package]
address = "github.com/acme/tools"
version = "1.0.0-beta.1"
description = "Test."
`;
    const manifest = parseMethodsToml(raw);
    expect(manifest.version).toBe("1.0.0-beta.1");
  });

  it("parses version with build metadata", () => {
    const raw = `
[package]
address = "github.com/acme/tools"
version = "1.0.0+build.42"
description = "Test."
`;
    const manifest = parseMethodsToml(raw);
    expect(manifest.version).toBe("1.0.0+build.42");
  });

  it("parses complete spec example", () => {
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
    const manifest = parseMethodsToml(raw);
    expect(manifest.address).toBe("github.com/acme/legal-tools");
    expect(Object.keys(manifest.exports)).toContain("legal");
    expect(Object.keys(manifest.exports)).toContain("legal.contracts");
  });
});

// ---------------------------------------------------------------------------
// parseMethodsToml — invalid manifests
// ---------------------------------------------------------------------------
describe("parseMethodsToml — invalid", () => {
  it("throws ManifestParseError for invalid TOML syntax", () => {
    expect(() => parseMethodsToml("this is [[ not valid toml")).toThrow(ManifestParseError);
  });

  it("throws ManifestValidationError for missing [package]", () => {
    expect(() => parseMethodsToml("[exports.legal]\npipes = []\n")).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError for missing address", () => {
    const raw = `
[package]
version = "1.0.0"
description = "Test."
`;
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError for invalid address", () => {
    const raw = `
[package]
address = "no-dot/repo"
version = "1.0.0"
description = "Test."
`;
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError for missing version", () => {
    const raw = `
[package]
address = "github.com/a/b"
description = "Test."
`;
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError for invalid semver version", () => {
    const raw = `
[package]
address = "github.com/a/b"
version = "not-semver"
description = "Test."
`;
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError for missing description", () => {
    const raw = `
[package]
address = "github.com/a/b"
version = "1.0.0"
`;
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError for empty description", () => {
    const raw = `
[package]
address = "github.com/a/b"
version = "1.0.0"
description = "  "
`;
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError for display_name over 128 chars", () => {
    const longName = "A".repeat(129);
    const raw = `
[package]
address = "github.com/a/b"
version = "1.0.0"
description = "Test."
display_name = "${longName}"
`;
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError for non-array authors", () => {
    const raw = `
[package]
address = "github.com/a/b"
version = "1.0.0"
description = "Test."
authors = "single-string"
`;
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError for non-string license", () => {
    const raw = `
[package]
address = "github.com/a/b"
version = "1.0.0"
description = "Test."
license = 42
`;
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError for reserved export domain (native)", () => {
    const raw = toml(`
[exports.native]
pipes = ["do_thing"]
`);
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
    expect(() => parseMethodsToml(raw)).toThrow(/reserved/);
  });

  it("throws ManifestValidationError for reserved export domain (mthds)", () => {
    const raw = toml(`
[exports.mthds]
pipes = ["do_thing"]
`);
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError for reserved export domain (pipelex)", () => {
    const raw = toml(`
[exports.pipelex]
pipes = ["do_thing"]
`);
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
  });

  it("throws ManifestValidationError for non-snake_case pipe name", () => {
    const raw = toml(`
[exports.legal]
pipes = ["BadName"]
`);
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
    expect(() => parseMethodsToml(raw)).toThrow(/snake_case/);
  });

  it("throws ManifestValidationError for any dependencies section", () => {
    const raw = toml(`
[dependencies]
dep = { address = "github.com/a/b", version = "1.0.0" }
`);
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
    expect(() => parseMethodsToml(raw)).toThrow(/dependencies/);
  });

  it("throws ManifestValidationError for unknown top-level section", () => {
    const raw = `
[package]
address = "github.com/a/b"
version = "1.0.0"
description = "Test."

[unknown_section]
foo = "bar"
`;
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
    expect(() => parseMethodsToml(raw)).toThrow(/Unknown sections/);
  });

  it("throws ManifestValidationError for unknown keys in [package] (e.g. typo 'licence')", () => {
    const raw = `
[package]
address = "github.com/a/b"
version = "1.0.0"
description = "Test."
licence = "MIT"
`;
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
    expect(() => parseMethodsToml(raw)).toThrow(/Unknown keys in \[package\]/);
    expect(() => parseMethodsToml(raw)).toThrow(/licence/);
  });

  it("throws ManifestValidationError for multiple unknown keys in [package]", () => {
    const raw = `
[package]
address = "github.com/a/b"
version = "1.0.0"
description = "Test."
licence = "MIT"
homepage = "https://example.com"
`;
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
    expect(() => parseMethodsToml(raw)).toThrow(/homepage/);
    expect(() => parseMethodsToml(raw)).toThrow(/licence/);
  });

  it("throws ManifestValidationError for dependencies even with extra keys", () => {
    const raw = toml(`
[dependencies.dep]
address = "github.com/a/b"
version = "^1.0.0"
branch = "main"
`);
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
    expect(() => parseMethodsToml(raw)).toThrow(/dependencies/);
  });

  it("throws ManifestValidationError for invalid domain path in exports", () => {
    const raw = toml(`
[exports.INVALID]
pipes = ["some_pipe"]
`);
    expect(() => parseMethodsToml(raw)).toThrow(ManifestValidationError);
  });
});

// ---------------------------------------------------------------------------
// serializeManifestToToml
// ---------------------------------------------------------------------------
describe("serializeManifestToToml", () => {
  it("serializes minimal manifest", () => {
    const manifest = parseMethodsToml(MINIMAL_TOML);
    const output = serializeManifestToToml(manifest);
    expect(output).toContain("github.com/acme/tools");
    expect(output).toContain("1.0.0");
    expect(output).toContain("Useful tools.");
  });

  it("serializes name and main_pipe when present", () => {
    const raw = `
[package]
address = "github.com/acme/tools"
version = "1.0.0"
description = "Useful tools."
name = "acme-tools"
main_pipe = "classify_document"
`;
    const manifest = parseMethodsToml(raw);
    const output = serializeManifestToToml(manifest);
    expect(output).toContain('name = "acme-tools"');
    expect(output).toContain('main_pipe = "classify_document"');
  });

  it("serializes exports as nested TOML tables", () => {
    const raw = toml(`
[exports.legal.contracts]
pipes = ["extract_clause"]
`);
    const manifest = parseMethodsToml(raw);
    const output = serializeManifestToToml(manifest);
    expect(output).toContain("exports");
    expect(output).toContain("extract_clause");
  });

  it("round-trips: parse -> serialize -> parse produces same data", () => {
    const raw = `
[package]
address       = "github.com/acme/legal-tools"
version       = "0.3.0"
description   = "Legal document analysis methods."
display_name  = "Legal Tools"
authors       = ["ACME <legal@acme.com>"]
license       = "MIT"
name          = "legal-tools"
main_pipe     = "classify_document"

[exports.legal]
pipes = ["classify_document"]

[exports.legal.contracts]
pipes = ["extract_clause", "analyze_nda"]
`;
    const first = parseMethodsToml(raw);
    const serialized = serializeManifestToToml(first);
    const second = parseMethodsToml(serialized);

    expect(second.address).toBe(first.address);
    expect(second.version).toBe(first.version);
    expect(second.description).toBe(first.description);
    expect(second.displayName).toBe(first.displayName);
    expect(second.authors).toEqual(first.authors);
    expect(second.license).toBe(first.license);
    expect(second.name).toBe(first.name);
    expect(second.mainPipe).toBe(first.mainPipe);
    expect(second.exports).toEqual(first.exports);
  });
});
