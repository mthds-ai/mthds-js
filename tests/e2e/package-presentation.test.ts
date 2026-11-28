/**
 * A manifest's result line and examples, end to end: the built `mthds` shows them in
 * `package validate` and `package list`, each example path quoted so that a path holding a comma
 * reads as one path. Every run gets a home and a working directory of its own.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MTHDS = join(__dirname, "../../dist/cli.js");

const MANIFEST = [
  "[package]",
  'name = "reviewer"',
  'address = "github.com/acme/tools"',
  'version = "1.0.0"',
  'description = "The reviewer method"',
  'main_pipe = "run"',
  'result_line = "{{ output.total }} due"',
  'examples = ["examples/a, b.json", "examples/c.json"]',
  "",
  "[exports.tools]",
  'pipes = ["run"]',
  "",
].join("\n");

describe("a manifest's result line and examples (e2e)", () => {
  let root: string;
  let home: string;
  let dir: string;

  function run(...args: string[]): string {
    const result = spawnSync("node", [MTHDS, "--no-logo", ...args], {
      encoding: "utf-8",
      timeout: 15_000,
      cwd: root,
      env: { ...process.env, HOME: home },
    });
    return `${result.stdout}${result.stderr}`;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mthds-presentation-e2e-"));
    home = join(root, "home");
    dir = join(root, "method");
    mkdirSync(home);
    mkdirSync(dir);
    writeFileSync(join(dir, "METHODS.toml"), MANIFEST);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("mthds package validate shows the result line and each example path quoted", () => {
    const output = run("package", "validate", "-C", dir);
    expect(output).toContain("METHODS.toml is valid");
    expect(output).toContain("Result line:   {{ output.total }} due");
    expect(output).toContain('Examples:      "examples/a, b.json", "examples/c.json"');
  });

  it("mthds package list shows the result line and each example path quoted", () => {
    const output = run("package", "list", "-C", dir);
    expect(output).toContain("Result Line: {{ output.total }} due");
    expect(output).toContain('Examples: "examples/a, b.json", "examples/c.json"');
  });
});
