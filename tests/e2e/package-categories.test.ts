/**
 * A manifest's categories, end to end: the built `mthds` and `mthds-agent` read a method declaring
 * them, show them, publish it, install it with the key as the author wrote it, and refuse a method
 * holding an entry that breaks the standard's slug pattern. A local publish registers nothing, so
 * neither the hub nor GitHub is reached, and every run gets a home and a working directory of its own.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MTHDS = join(__dirname, "../../dist/cli.js");
const MTHDS_AGENT = join(__dirname, "../../dist/agent-cli.js");

const CATEGORIES = 'categories = ["legal", "no-catalog-knows-this", "legal"]';

function manifest(name: string, categoriesLine: string): string {
  return [
    "[package]",
    `name = "${name}"`,
    'address = "github.com/acme/tools"',
    'version = "1.0.0"',
    `description = "The ${name} method"`,
    categoriesLine,
    "",
    "[exports.tools]",
    'pipes = ["run"]',
    "",
  ].join("\n");
}

function writeMethod(repo: string, name: string, categoriesLine: string): string {
  const dir = join(repo, "methods", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "METHODS.toml"), manifest(name, categoriesLine));
  writeFileSync(join(dir, "main.mthds"), 'domain = "tools"\n');
  return dir;
}

describe("a manifest's categories (e2e)", () => {
  let root: string;
  let home: string;
  let cwd: string;
  let repo: string;

  function run(
    cli: string,
    ...args: string[]
  ): { output: string; stdout: string; status: number | null } {
    const result = spawnSync("node", [cli, ...args], {
      encoding: "utf-8",
      timeout: 15_000,
      cwd,
      env: { ...process.env, HOME: home },
    });
    return {
      output: `${result.stdout}${result.stderr}`,
      stdout: result.stdout,
      status: result.status,
    };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mthds-categories-e2e-"));
    home = join(root, "home");
    cwd = join(root, "cwd");
    repo = join(root, "repo");
    mkdirSync(home);
    mkdirSync(cwd);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("mthds package validate accepts them and shows them", () => {
    const dir = writeMethod(repo, "tagged", CATEGORIES);
    const { output, status } = run(MTHDS, "--no-logo", "package", "validate", "-C", dir);
    expect(status).toBe(0);
    expect(output).toContain("METHODS.toml is valid");
    expect(output).toContain("Categories:    legal, no-catalog-knows-this, legal");
  });

  it("mthds package list shows them", () => {
    const dir = writeMethod(repo, "tagged", CATEGORIES);
    const { output } = run(MTHDS, "--no-logo", "package", "list", "-C", dir);
    expect(output).toContain("Categories: legal, no-catalog-knows-this, legal");
  });

  it.each(["validate", "list"])("mthds package %s shows no line for an empty array", (command) => {
    const dir = writeMethod(repo, "untagged", "categories = []");
    const { output } = run(MTHDS, "--no-logo", "package", command, "-C", dir);
    expect(output).toContain("github.com/acme/tools");
    expect(output).not.toContain("Categories:");
  });

  it("mthds package validate refuses an entry that breaks the pattern, naming it", () => {
    const dir = writeMethod(repo, "tagged", 'categories = ["Legal"]');
    const { output, status } = run(MTHDS, "--no-logo", "package", "validate", "-C", dir);
    expect(status).toBe(1);
    expect(output).toContain('"Legal"');
  });

  it("mthds-agent package validate answers them as written", () => {
    const dir = writeMethod(repo, "tagged", CATEGORIES);
    const { stdout, status } = run(MTHDS_AGENT, "package", "validate", "-C", dir);
    expect(status).toBe(0);
    const result = JSON.parse(stdout) as { manifest: Record<string, unknown> };
    expect(result.manifest.categories).toEqual(["legal", "no-catalog-knows-this", "legal"]);
  });

  it("mthds-agent publish takes a method declaring them and names one breaking the pattern", () => {
    writeMethod(repo, "tagged", CATEGORIES);
    writeMethod(repo, "mistyped", 'categories = ["customer_support"]');
    const { stdout, status } = run(MTHDS_AGENT, "publish", "--local", repo);
    expect(status).toBe(0);
    const result = JSON.parse(stdout) as {
      published_methods: string[];
      skipped_methods: { name: string; errors: string[] }[];
    };
    expect(result.published_methods).toEqual(["tagged"]);
    expect(result.skipped_methods.map((skipped) => skipped.name)).toEqual(["mistyped"]);
    expect(result.skipped_methods[0]!.errors.join(" ")).toContain('"customer_support"');
  });

  it("mthds-agent install leaves them in the manifest as the author wrote them", () => {
    writeMethod(repo, "tagged", CATEGORIES);
    const { status } = run(
      MTHDS_AGENT,
      "install",
      "--local",
      repo,
      "--location",
      "local",
      "--no-runner",
    );
    expect(status).toBe(0);
    const installed = readFileSync(
      join(cwd, ".mthds", "methods", "tagged", "METHODS.toml"),
      "utf-8",
    );
    expect(installed).toBe(manifest("tagged", CATEGORIES));
  });
});
