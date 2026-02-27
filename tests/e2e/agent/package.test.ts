import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_PATH = join(__dirname, "../../../dist/agent-cli.js");

function runAgent(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("node", [CLI_PATH, ...args], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function parseJson(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

describe("mthds-agent package (e2e)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mthds-e2e-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // =================================================================
  // Init — happy paths
  // =================================================================

  describe("init", () => {
    it("creates METHODS.toml with minimal required fields", () => {
      const { stdout, status } = runAgent(
        "package", "init", "-C", tmpDir,
        "--address", "github.com/test/pkg",
        "--version", "0.1.0",
        "--description", "Test package",
      );

      expect(status).toBe(0);

      const result = parseJson(stdout);
      expect(result.success).toBe(true);
      expect(result.path).toContain("METHODS.toml");

      const manifest = result.manifest as Record<string, unknown>;
      expect(manifest.address).toBe("github.com/test/pkg");
      expect(manifest.version).toBe("0.1.0");
      expect(manifest.description).toBe("Test package");
      expect(manifest.authors).toEqual([]);
      expect(manifest.exports).toEqual({});
      expect(manifest.mthds_version).toBeDefined();

      // Optional scalars absent
      expect("name" in manifest).toBe(false);
      expect("display_name" in manifest).toBe(false);
      expect("license" in manifest).toBe(false);
      expect("main_pipe" in manifest).toBe(false);

      // File actually written to disk
      const content = readFileSync(join(tmpDir, "METHODS.toml"), "utf-8");
      expect(content).toContain("github.com/test/pkg");
    });

    it("creates METHODS.toml with all optional fields", () => {
      const { stdout, status } = runAgent(
        "package", "init", "-C", tmpDir,
        "--address", "github.com/acme/full",
        "--version", "2.0.0",
        "--description", "Full package",
        "--name", "my-tool",
        "--display-name", "My Tool",
        "--authors", "Alice,Bob",
        "--license", "MIT",
        "--main-pipe", "run_it",
      );

      expect(status).toBe(0);

      const manifest = (parseJson(stdout).manifest) as Record<string, unknown>;
      expect(manifest.name).toBe("my-tool");
      expect(manifest.display_name).toBe("My Tool");
      expect(manifest.authors).toEqual(["Alice", "Bob"]);
      expect(manifest.license).toBe("MIT");
      expect(manifest.main_pipe).toBe("run_it");
    });

    it("--force overwrites existing file", () => {
      // First init
      runAgent(
        "package", "init", "-C", tmpDir,
        "--address", "github.com/test/first",
        "--version", "1.0.0",
        "--description", "First",
      );

      // Overwrite with --force
      const { stdout, status } = runAgent(
        "package", "init", "-C", tmpDir,
        "--address", "github.com/test/second",
        "--version", "2.0.0",
        "--description", "Second",
        "--force",
      );

      expect(status).toBe(0);
      const manifest = (parseJson(stdout).manifest) as Record<string, unknown>;
      expect(manifest.address).toBe("github.com/test/second");

      // File on disk reflects the overwrite
      const content = readFileSync(join(tmpDir, "METHODS.toml"), "utf-8");
      expect(content).toContain("github.com/test/second");
      expect(content).not.toContain("github.com/test/first");
    });

    it("errors without --force when file exists", () => {
      // First init
      runAgent(
        "package", "init", "-C", tmpDir,
        "--address", "github.com/test/first",
        "--version", "1.0.0",
        "--description", "First",
      );

      // Second init without --force
      const { stderr, status } = runAgent(
        "package", "init", "-C", tmpDir,
        "--address", "github.com/test/second",
        "--version", "2.0.0",
        "--description", "Second",
      );

      expect(status).toBe(1);
      const errJson = parseJson(stderr);
      expect(errJson.error).toBe(true);
      expect(errJson.message).toContain("already exists");
      expect(errJson.hint).toContain("--force");
    });
  });

  // =================================================================
  // Init — validation errors
  // =================================================================

  describe("init validation errors", () => {
    it("rejects invalid address with hint", () => {
      const { stderr, status } = runAgent(
        "package", "init", "-C", tmpDir,
        "--address", "bad",
        "--version", "1.0.0",
        "--description", "Test",
      );

      expect(status).toBe(1);
      const errJson = parseJson(stderr);
      expect(errJson.error).toBe(true);
      expect(errJson.error_type).toBe("PackageError");
      expect(errJson.message).toContain("Invalid package address");
      expect(errJson.hint).toBeDefined();
      expect(errJson.error_domain).toBe("package");
    });

    it("rejects invalid version with hint", () => {
      const { stderr, status } = runAgent(
        "package", "init", "-C", tmpDir,
        "--address", "github.com/test/pkg",
        "--version", "not-semver",
        "--description", "Test",
      );

      expect(status).toBe(1);
      const errJson = parseJson(stderr);
      expect(errJson.message).toContain("Invalid version");
      expect(errJson.hint).toContain("semver");
    });

    it("rejects invalid name with hint", () => {
      const { stderr, status } = runAgent(
        "package", "init", "-C", tmpDir,
        "--address", "github.com/test/pkg",
        "--version", "1.0.0",
        "--description", "Test",
        "--name", "INVALID!",
      );

      expect(status).toBe(1);
      const errJson = parseJson(stderr);
      expect(errJson.message).toContain("Invalid method name");
      expect(errJson.hint).toContain("--name");
    });

    it("rejects invalid main-pipe with hint", () => {
      const { stderr, status } = runAgent(
        "package", "init", "-C", tmpDir,
        "--address", "github.com/test/pkg",
        "--version", "1.0.0",
        "--description", "Test",
        "--main-pipe", "Not-Valid",
      );

      expect(status).toBe(1);
      const errJson = parseJson(stderr);
      expect(errJson.message).toContain("Invalid main_pipe");
      expect(errJson.hint).toContain("snake_case");
    });
  });

  // =================================================================
  // Round-trip: init → list → validate
  // =================================================================

  describe("round-trip", () => {
    it("init → list → validate preserves all data", () => {
      // Init with all fields
      const initResult = runAgent(
        "package", "init", "-C", tmpDir,
        "--address", "github.com/acme/round-trip",
        "--version", "2.0.0",
        "--description", "Round-trip test",
        "--name", "round-trip",
        "--display-name", "Round Trip Test",
        "--main-pipe", "run_it",
        "--authors", "Alice,Bob",
        "--license", "MIT",
      );
      expect(initResult.status).toBe(0);
      const initManifest = (parseJson(initResult.stdout).manifest) as Record<string, unknown>;

      // List — should return identical manifest
      const listResult = runAgent("package", "list", "-C", tmpDir);
      expect(listResult.status).toBe(0);

      const listJson = parseJson(listResult.stdout);
      expect(listJson.success).toBe(true);
      expect(listJson.path).toContain("METHODS.toml");
      expect(listJson.manifest).toEqual(initManifest);

      // Validate — should return identical manifest with valid: true
      const valResult = runAgent("package", "validate", "-C", tmpDir);
      expect(valResult.status).toBe(0);

      const valJson = parseJson(valResult.stdout);
      expect(valJson.success).toBe(true);
      expect(valJson.valid).toBe(true);
      expect(valJson.path).toContain("METHODS.toml");
      expect(valJson.manifest).toEqual(initManifest);
    });
  });

  // =================================================================
  // List — error paths
  // =================================================================

  describe("list errors", () => {
    it("errors when METHODS.toml is missing with hint", () => {
      const { stderr, status } = runAgent("package", "list", "-C", tmpDir);

      expect(status).toBe(1);
      const errJson = parseJson(stderr);
      expect(errJson.error).toBe(true);
      expect(errJson.message).toContain("No METHODS.toml found");
      expect(errJson.hint).toContain("mthds-agent package init");
      expect(errJson.error_domain).toBe("package");
    });

    it("errors on corrupt TOML syntax with hint", () => {
      writeFileSync(join(tmpDir, "METHODS.toml"), "[package\nbroken = true", "utf-8");

      const { stderr, status } = runAgent("package", "list", "-C", tmpDir);

      expect(status).toBe(1);
      const errJson = parseJson(stderr);
      expect(errJson.message).toContain("TOML syntax error");
      expect(errJson.hint).toContain("Fix the TOML syntax");
    });

    it("errors on semantically invalid TOML with hint", () => {
      writeFileSync(join(tmpDir, "METHODS.toml"), `[package]
address = "not-valid"
version = "1.0.0"
description = "Test"
`, "utf-8");

      const { stderr, status } = runAgent("package", "list", "-C", tmpDir);

      expect(status).toBe(1);
      const errJson = parseJson(stderr);
      expect(errJson.message).toContain("Validation error");
      expect(errJson.hint).toContain("Fix the validation errors");
    });
  });

  // =================================================================
  // Validate — error paths
  // =================================================================

  describe("validate errors", () => {
    it("errors when METHODS.toml is missing", () => {
      const { stderr, status } = runAgent("package", "validate", "-C", tmpDir);

      expect(status).toBe(1);
      const errJson = parseJson(stderr);
      expect(errJson.error).toBe(true);
      expect(errJson.message).toContain("No METHODS.toml found");
    });

    it("errors on corrupt TOML with hint", () => {
      writeFileSync(join(tmpDir, "METHODS.toml"), "[package\nbroken = true", "utf-8");

      const { stderr, status } = runAgent("package", "validate", "-C", tmpDir);

      expect(status).toBe(1);
      const errJson = parseJson(stderr);
      expect(errJson.message).toContain("TOML syntax error");
      expect(errJson.hint).toContain("Fix the TOML syntax");
    });

    it("errors on semantically invalid TOML with hint", () => {
      writeFileSync(join(tmpDir, "METHODS.toml"), `[package]
address = "not-valid"
version = "1.0.0"
description = "Test"
`, "utf-8");

      const { stderr, status } = runAgent("package", "validate", "-C", tmpDir);

      expect(status).toBe(1);
      const errJson = parseJson(stderr);
      expect(errJson.message).toContain("Validation error");
      expect(errJson.hint).toContain("Fix the validation errors");
    });
  });

  // =================================================================
  // Iterative workflow: init → corrupt → validate error → fix → OK
  // =================================================================

  describe("iterative workflow", () => {
    it("agent can iterate: init → corrupt → validate error → fix → validate success", () => {
      // Step 1: init a valid package
      const initResult = runAgent(
        "package", "init", "-C", tmpDir,
        "--address", "github.com/test/iterate",
        "--version", "1.0.0",
        "--description", "Iterate test",
      );
      expect(initResult.status).toBe(0);

      // Step 2: manually corrupt the file (simulate agent editing)
      const filePath = join(tmpDir, "METHODS.toml");
      writeFileSync(filePath, `[package]
address = "not-valid"
version = "1.0.0"
description = "Iterate test"
`, "utf-8");

      // Step 3: validate catches the error with actionable details
      const valBadResult = runAgent("package", "validate", "-C", tmpDir);
      expect(valBadResult.status).toBe(1);

      const errJson = parseJson(valBadResult.stderr);
      expect(errJson.error).toBe(true);
      expect(errJson.message).toContain("Invalid package address");
      expect(errJson.hint).toBeDefined();

      // Step 4: fix the file
      writeFileSync(filePath, `[package]
address = "github.com/test/iterate"
version = "1.0.0"
description = "Iterate test"
mthds_version = ">=1.0.0"
`, "utf-8");

      // Step 5: validate succeeds
      const valGoodResult = runAgent("package", "validate", "-C", tmpDir);
      expect(valGoodResult.status).toBe(0);

      const successJson = parseJson(valGoodResult.stdout);
      expect(successJson.success).toBe(true);
      expect(successJson.valid).toBe(true);
    });
  });

  // =================================================================
  // JSON output is always valid parseable JSON
  // =================================================================

  describe("output format", () => {
    it("success output is valid JSON on stdout, nothing on stderr", () => {
      const { stdout, stderr, status } = runAgent(
        "package", "init", "-C", tmpDir,
        "--address", "github.com/test/json",
        "--version", "1.0.0",
        "--description", "JSON test",
      );

      expect(status).toBe(0);
      expect(() => JSON.parse(stdout)).not.toThrow();
      // stderr may have warnings but should not have JSON errors
      if (stderr.trim()) {
        expect(() => JSON.parse(stderr)).toThrow(); // not JSON = not an error payload
      }
    });

    it("error output is valid JSON on stderr", () => {
      const { stderr, status } = runAgent(
        "package", "init", "-C", tmpDir,
        "--address", "bad",
        "--version", "1.0.0",
        "--description", "Test",
      );

      expect(status).toBe(1);
      expect(() => JSON.parse(stderr)).not.toThrow();

      const errJson = parseJson(stderr);
      // All error payloads must have these fields
      expect(errJson.error).toBe(true);
      expect(typeof errJson.error_type).toBe("string");
      expect(typeof errJson.message).toBe("string");
    });
  });
});
