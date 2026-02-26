import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("node:fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// Capture what agentSuccess / agentError receive
let capturedResult: Record<string, unknown> | undefined;
let capturedError: { message: string; errorType: string; extras?: Record<string, unknown> } | undefined;

vi.mock("../../../src/agent/output.js", async () => {
  const actual = await vi.importActual<typeof import("../../../src/agent/output.js")>("../../../src/agent/output.js");
  return {
    ...actual,
    agentSuccess: vi.fn((result: Record<string, unknown>) => {
      capturedResult = result;
    }),
    agentError: vi.fn((message: string, errorType: string, extras?: Record<string, unknown>) => {
      capturedError = { message, errorType, extras };
      throw new Error("agentError called");
    }),
  };
});

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  agentPackageInit,
  agentPackageList,
  agentPackageValidate,
} from "../../../src/agent/commands/package.js";

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);

// ── TOML fixtures ────────────────────────────────────────────────────

const MINIMAL_TOML = `[package]
address = "github.com/acme/tools"
version = "1.0.0"
description = "Useful tools."
mthds_version = ">=1.0.0"
`;

const RICH_TOML = `[package]
name = "my-tools"
address = "github.com/acme/tools"
display_name = "My Awesome Tools"
version = "1.0.0"
description = "Useful tools."
authors = ["Alice", "Bob"]
license = "MIT"
mthds_version = ">=1.0.0"
main_pipe = "extract"

[exports.legal]
pipes = ["extract_clause"]
`;

const NESTED_EXPORTS_TOML = `[package]
address = "github.com/acme/tools"
version = "1.0.0"
description = "Useful tools."
mthds_version = ">=1.0.0"

[exports.legal]
pipes = ["extract_clause"]

[exports.legal.contracts]
pipes = ["summarize"]
`;

const INVALID_TOML_SYNTAX = `[package
address = broken`;

const INVALID_TOML_SEMANTIC = `[package]
address = "not-valid"
version = "1.0.0"
description = "Test"
`;

// ── Setup ────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  capturedResult = undefined;
  capturedError = undefined;
});

// =====================================================================
// Init tests
// =====================================================================

describe("agentPackageInit", () => {
  const baseOpts = {
    address: "github.com/acme/tools",
    version: "1.0.0",
    description: "Useful tools.",
    force: true,
  };

  // ── Happy path ────────────────────────────────────────────────────

  it("creates METHODS.toml on happy path", async () => {
    mockedExistsSync.mockReturnValue(false);

    await agentPackageInit(baseOpts);

    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    expect(capturedResult).toBeDefined();
    expect(capturedResult!.success).toBe(true);
    expect(capturedResult!.path).toBeDefined();
    expect((capturedResult!.manifest as Record<string, unknown>).address).toBe("github.com/acme/tools");
  });

  it("minimal init JSON has exactly the expected keys", async () => {
    mockedExistsSync.mockReturnValue(false);

    await agentPackageInit(baseOpts);

    // Top-level keys
    expect(Object.keys(capturedResult!)).toEqual(
      expect.arrayContaining(["success", "path", "manifest"]),
    );

    // Manifest keys — minimal init should include required + always-present fields
    const manifest = capturedResult!.manifest as Record<string, unknown>;
    const keys = Object.keys(manifest);
    expect(keys).toContain("address");
    expect(keys).toContain("version");
    expect(keys).toContain("description");
    expect(keys).toContain("authors");
    expect(keys).toContain("exports");
    expect(keys).toContain("mthds_version");  // always set by init

    // Optional fields NOT provided should NOT appear
    expect(keys).not.toContain("name");
    expect(keys).not.toContain("display_name");
    expect(keys).not.toContain("license");
    expect(keys).not.toContain("main_pipe");
  });

  it("always includes authors: [] and exports: {} in minimal JSON output", async () => {
    mockedExistsSync.mockReturnValue(false);

    await agentPackageInit(baseOpts);

    const manifest = capturedResult!.manifest as Record<string, unknown>;
    expect(manifest.authors).toEqual([]);
    expect(manifest.exports).toEqual({});
  });

  it("always includes mthds_version in init output", async () => {
    mockedExistsSync.mockReturnValue(false);

    await agentPackageInit(baseOpts);

    const manifest = capturedResult!.manifest as Record<string, unknown>;
    expect(manifest.mthds_version).toMatch(/^>=\d+\.\d+\.\d+$/);
  });

  // ── Optional fields ───────────────────────────────────────────────

  it("includes all optional fields when provided", async () => {
    mockedExistsSync.mockReturnValue(false);

    await agentPackageInit({
      ...baseOpts,
      name: "tools",
      displayName: "Acme Tools",
      authors: "Alice, Bob",
      license: "MIT",
      mainPipe: "extract",
    });

    const manifest = capturedResult!.manifest as Record<string, unknown>;
    expect(manifest.name).toBe("tools");
    expect(manifest.display_name).toBe("Acme Tools");
    expect(manifest.authors).toEqual(["Alice", "Bob"]);
    expect(manifest.license).toBe("MIT");
    expect(manifest.main_pipe).toBe("extract");
    expect(manifest.mthds_version).toBeDefined();
  });

  it("trims displayName whitespace", async () => {
    mockedExistsSync.mockReturnValue(false);

    await agentPackageInit({
      ...baseOpts,
      displayName: "  Padded Name  ",
    });

    const manifest = capturedResult!.manifest as Record<string, unknown>;
    expect(manifest.display_name).toBe("Padded Name");
  });

  it("handles single author", async () => {
    mockedExistsSync.mockReturnValue(false);

    await agentPackageInit({ ...baseOpts, authors: "Alice" });

    const manifest = capturedResult!.manifest as Record<string, unknown>;
    expect(manifest.authors).toEqual(["Alice"]);
  });

  it("filters empty entries from authors string", async () => {
    mockedExistsSync.mockReturnValue(false);

    await agentPackageInit({ ...baseOpts, authors: "Alice,,, Bob, " });

    const manifest = capturedResult!.manifest as Record<string, unknown>;
    expect(manifest.authors).toEqual(["Alice", "Bob"]);
  });

  it("produces empty authors from empty string", async () => {
    mockedExistsSync.mockReturnValue(false);

    await agentPackageInit({ ...baseOpts, authors: "" });

    const manifest = capturedResult!.manifest as Record<string, unknown>;
    expect(manifest.authors).toEqual([]);
  });

  // ── Directory option ──────────────────────────────────────────────

  it("resolves manifest path with directory option", async () => {
    mockedExistsSync.mockReturnValue(false);

    await agentPackageInit({ ...baseOpts, directory: "/tmp/my-project" });

    expect(capturedResult!.path).toMatch(/^\/tmp\/my-project/);
    expect((capturedResult!.path as string)).toContain("METHODS.toml");
  });

  // ── Overwrite / force ─────────────────────────────────────────────

  it("overwrites when file exists with --force", async () => {
    mockedExistsSync.mockReturnValue(true);

    await agentPackageInit({ ...baseOpts, force: true });

    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    expect(capturedResult!.success).toBe(true);
  });

  it("errors when file exists without --force, with actionable hint", async () => {
    mockedExistsSync.mockReturnValue(true);

    await expect(
      agentPackageInit({ ...baseOpts, force: false }),
    ).rejects.toThrow("agentError called");

    expect(capturedError!.message).toContain("already exists");
    expect(capturedError!.extras?.hint).toContain("--force");
  });

  // ── TOML write verification ───────────────────────────────────────

  it("writes valid TOML that can be re-parsed", async () => {
    mockedExistsSync.mockReturnValue(false);

    await agentPackageInit(baseOpts);

    // Capture what was written to the file
    const writeCall = mockedWriteFileSync.mock.calls[0];
    expect(writeCall).toBeDefined();
    const tomlContent = writeCall![1] as string;

    // Verify it's valid TOML by reading it back through list
    vi.clearAllMocks();
    capturedResult = undefined;
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(tomlContent);

    await agentPackageList({});

    expect(capturedResult!.success).toBe(true);
    const manifest = capturedResult!.manifest as Record<string, unknown>;
    expect(manifest.address).toBe("github.com/acme/tools");
  });

  // ── Validation errors with specific hints ─────────────────────────

  it("errors on invalid address with actionable hint", async () => {
    await expect(
      agentPackageInit({ ...baseOpts, address: "not-valid" }),
    ).rejects.toThrow("agentError called");

    expect(capturedError!.errorType).toBe("PackageError");
    expect(capturedError!.message).toContain("Invalid package address");
    expect(capturedError!.extras?.hint).toContain("hostname/path format");
    expect(capturedError!.extras?.error_domain).toBe("package");
  });

  it("errors on invalid version with actionable hint", async () => {
    await expect(
      agentPackageInit({ ...baseOpts, version: "abc" }),
    ).rejects.toThrow("agentError called");

    expect(capturedError!.message).toContain("Invalid version");
    expect(capturedError!.extras?.hint).toContain("semver");
  });

  it("errors on empty description with actionable hint", async () => {
    await expect(
      agentPackageInit({ ...baseOpts, description: "  " }),
    ).rejects.toThrow("agentError called");

    expect(capturedError!.message).toContain("Description is required");
    expect(capturedError!.extras?.hint).toContain("--description");
  });

  it("errors on invalid name with actionable hint", async () => {
    await expect(
      agentPackageInit({ ...baseOpts, name: "INVALID NAME!" }),
    ).rejects.toThrow("agentError called");

    expect(capturedError!.message).toContain("Invalid method name");
    expect(capturedError!.extras?.hint).toContain("--name");
  });

  it("errors on empty displayName with actionable hint", async () => {
    await expect(
      agentPackageInit({ ...baseOpts, displayName: "   " }),
    ).rejects.toThrow("agentError called");

    expect(capturedError!.message).toContain("Display name must not be empty");
    expect(capturedError!.extras?.hint).toContain("--display-name");
  });

  it("errors on displayName exceeding 128 chars with hint", async () => {
    await expect(
      agentPackageInit({ ...baseOpts, displayName: "x".repeat(129) }),
    ).rejects.toThrow("agentError called");

    expect(capturedError!.message).toContain("must not exceed 128 characters");
    expect(capturedError!.extras?.hint).toContain("128 characters");
  });

  it("accepts displayName at exactly 128 chars", async () => {
    mockedExistsSync.mockReturnValue(false);

    await agentPackageInit({ ...baseOpts, displayName: "x".repeat(128) });

    const manifest = capturedResult!.manifest as Record<string, unknown>;
    expect(manifest.display_name).toBe("x".repeat(128));
  });

  it("errors on invalid mainPipe with actionable hint", async () => {
    await expect(
      agentPackageInit({ ...baseOpts, mainPipe: "Not-Valid" }),
    ).rejects.toThrow("agentError called");

    expect(capturedError!.message).toContain("Invalid main_pipe");
    expect(capturedError!.extras?.hint).toContain("snake_case");
  });

  // ── IO error ──────────────────────────────────────────────────────

  it("reports IO error on write failure with io domain", async () => {
    mockedExistsSync.mockReturnValue(false);
    mockedWriteFileSync.mockImplementationOnce(() => {
      throw new Error("EACCES: permission denied");
    });

    await expect(agentPackageInit(baseOpts)).rejects.toThrow("agentError called");

    expect(capturedError!.message).toContain("Failed to write");
    expect(capturedError!.message).toContain("EACCES");
    expect(capturedError!.extras?.error_domain).toBe("io");
  });
});

// =====================================================================
// List tests
// =====================================================================

describe("agentPackageList", () => {
  // ── Happy path ────────────────────────────────────────────────────

  it("returns manifest on happy path with correct top-level keys", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(MINIMAL_TOML);

    await agentPackageList({});

    expect(capturedResult).toBeDefined();
    expect(capturedResult!.success).toBe(true);
    expect(capturedResult!.path).toBeDefined();
    expect(capturedResult!.manifest).toBeDefined();

    const manifest = capturedResult!.manifest as Record<string, unknown>;
    expect(manifest.address).toBe("github.com/acme/tools");
    expect(manifest.version).toBe("1.0.0");
  });

  it("always includes authors and exports in minimal TOML output", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(MINIMAL_TOML);

    await agentPackageList({});

    const manifest = capturedResult!.manifest as Record<string, unknown>;
    expect(manifest.authors).toEqual([]);
    expect(manifest.exports).toEqual({});
  });

  it("minimal TOML omits optional scalar fields from JSON", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(MINIMAL_TOML);

    await agentPackageList({});

    const manifest = capturedResult!.manifest as Record<string, unknown>;
    expect("name" in manifest).toBe(false);
    expect("display_name" in manifest).toBe(false);
    expect("license" in manifest).toBe(false);
    expect("main_pipe" in manifest).toBe(false);
  });

  it("includes path ending with METHODS.toml", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(MINIMAL_TOML);

    await agentPackageList({});

    expect(typeof capturedResult!.path).toBe("string");
    expect((capturedResult!.path as string)).toMatch(/METHODS\.toml$/);
  });

  it("resolves path with directory option", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(MINIMAL_TOML);

    await agentPackageList({ directory: "/tmp/custom-dir" });

    expect((capturedResult!.path as string)).toMatch(/^\/tmp\/custom-dir/);
  });

  // ── Rich TOML ─────────────────────────────────────────────────────

  it("returns all fields from rich manifest", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(RICH_TOML);

    await agentPackageList({});

    const manifest = capturedResult!.manifest as Record<string, unknown>;
    expect(manifest.name).toBe("my-tools");
    expect(manifest.display_name).toBe("My Awesome Tools");
    expect(manifest.authors).toEqual(["Alice", "Bob"]);
    expect(manifest.license).toBe("MIT");
    expect(manifest.main_pipe).toBe("extract");
    expect(manifest.mthds_version).toBe(">=1.0.0");
    expect(manifest.exports).toEqual({ legal: { pipes: ["extract_clause"] } });
  });

  it("handles nested exports (dotted domain paths)", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(NESTED_EXPORTS_TOML);

    await agentPackageList({});

    const manifest = capturedResult!.manifest as Record<string, unknown>;
    const exports = manifest.exports as Record<string, { pipes: string[] }>;
    expect(exports["legal"]).toEqual({ pipes: ["extract_clause"] });
    expect(exports["legal.contracts"]).toEqual({ pipes: ["summarize"] });
  });

  // ── Error paths ───────────────────────────────────────────────────

  it("errors on missing file with actionable hint", async () => {
    mockedExistsSync.mockReturnValue(false);

    await expect(agentPackageList({})).rejects.toThrow("agentError called");

    expect(capturedError!.message).toContain("No METHODS.toml found");
    expect(capturedError!.extras?.hint).toContain("mthds-agent package init");
    expect(capturedError!.extras?.error_domain).toBe("package");
  });

  it("errors on TOML syntax error with hint", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(INVALID_TOML_SYNTAX);

    await expect(agentPackageList({})).rejects.toThrow("agentError called");

    expect(capturedError!.message).toContain("TOML syntax error");
    expect(capturedError!.extras?.hint).toContain("Fix the TOML syntax");
    expect(capturedError!.extras?.error_domain).toBe("package");
  });

  it("errors on semantic validation failure with hint", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(INVALID_TOML_SEMANTIC);

    await expect(agentPackageList({})).rejects.toThrow("agentError called");

    expect(capturedError!.message).toContain("Validation error");
    expect(capturedError!.extras?.hint).toContain("Fix the validation errors");
    expect(capturedError!.extras?.error_domain).toBe("package");
  });
});

// =====================================================================
// Validate tests
// =====================================================================

describe("agentPackageValidate", () => {
  // ── Happy path ────────────────────────────────────────────────────

  it("returns valid: true on happy path", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(MINIMAL_TOML);

    await agentPackageValidate({});

    expect(capturedResult).toBeDefined();
    expect(capturedResult!.success).toBe(true);
    expect(capturedResult!.valid).toBe(true);
    expect(capturedResult!.path).toBeDefined();
    expect(capturedResult!.manifest).toBeDefined();
  });

  it("always includes authors and exports in minimal TOML output", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(MINIMAL_TOML);

    await agentPackageValidate({});

    const manifest = capturedResult!.manifest as Record<string, unknown>;
    expect(manifest.authors).toEqual([]);
    expect(manifest.exports).toEqual({});
  });

  it("includes path ending with METHODS.toml", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(MINIMAL_TOML);

    await agentPackageValidate({});

    expect((capturedResult!.path as string)).toMatch(/METHODS\.toml$/);
  });

  it("resolves path with directory option", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(MINIMAL_TOML);

    await agentPackageValidate({ directory: "/tmp/validate-dir" });

    expect((capturedResult!.path as string)).toMatch(/^\/tmp\/validate-dir/);
  });

  it("returns all fields from rich manifest", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(RICH_TOML);

    await agentPackageValidate({});

    expect(capturedResult!.valid).toBe(true);
    const manifest = capturedResult!.manifest as Record<string, unknown>;
    expect(manifest.name).toBe("my-tools");
    expect(manifest.display_name).toBe("My Awesome Tools");
    expect(manifest.authors).toEqual(["Alice", "Bob"]);
    expect(manifest.license).toBe("MIT");
    expect(manifest.main_pipe).toBe("extract");
    expect(manifest.exports).toEqual({ legal: { pipes: ["extract_clause"] } });
  });

  // ── Error paths ───────────────────────────────────────────────────

  it("errors on missing file with actionable hint", async () => {
    mockedExistsSync.mockReturnValue(false);

    await expect(agentPackageValidate({})).rejects.toThrow("agentError called");

    expect(capturedError!.message).toContain("No METHODS.toml found");
    expect(capturedError!.extras?.hint).toContain("mthds-agent package init");
  });

  it("errors on TOML syntax error with hint", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(INVALID_TOML_SYNTAX);

    await expect(agentPackageValidate({})).rejects.toThrow("agentError called");

    expect(capturedError!.message).toContain("TOML syntax error");
    expect(capturedError!.extras?.hint).toContain("Fix the TOML syntax");
  });

  it("errors on semantic validation failure with hint", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(INVALID_TOML_SEMANTIC);

    await expect(agentPackageValidate({})).rejects.toThrow("agentError called");

    expect(capturedError!.message).toContain("Validation error");
    expect(capturedError!.extras?.hint).toContain("Fix the validation errors");
  });
});

// =====================================================================
// manifestToJson shape consistency across commands
// =====================================================================

describe("manifestToJson consistency", () => {
  it("init and list produce identical manifest JSON for same data", async () => {
    mockedExistsSync.mockReturnValue(false);

    await agentPackageInit({
      address: "github.com/acme/tools",
      version: "1.0.0",
      description: "Useful tools.",
      force: true,
    });

    const initManifest = capturedResult!.manifest;

    // Now feed the written TOML into list
    const writtenToml = mockedWriteFileSync.mock.calls[0]![1] as string;
    vi.clearAllMocks();
    capturedResult = undefined;
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(writtenToml);

    await agentPackageList({});

    const listManifest = capturedResult!.manifest;

    // Same shape and values
    expect(listManifest).toEqual(initManifest);
  });

  it("list and validate produce identical manifest JSON for same file", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(RICH_TOML);

    await agentPackageList({});
    const listManifest = capturedResult!.manifest;

    vi.clearAllMocks();
    capturedResult = undefined;
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(RICH_TOML);

    await agentPackageValidate({});
    const valManifest = capturedResult!.manifest;

    expect(valManifest).toEqual(listManifest);
  });
});
