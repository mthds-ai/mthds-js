/**
 * The refused methods, end to end.
 *
 * A repository whose methods target different versions of the standard is the
 * case the agent CLI used to answer dishonestly: it built its envelope from the
 * methods that survived and never read the skip list, so a half publish and a
 * whole one were the same JSON. These run the built CLI against a repository
 * holding one method this build can honour and one it cannot.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { MTHDS_STANDARD_VERSION } from "../../../src/package/manifest/schema.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_PATH = join(__dirname, "../../../dist/agent-cli.js");

/** A constraint the current standard cannot satisfy, whatever it is cut to next. */
const FOREIGN_CONSTRAINT = `<${MTHDS_STANDARD_VERSION}`;

interface Sandbox {
  readonly cwd: string;
  readonly home: string;
}

/**
 * `install --location local` writes under `process.cwd()` and its shims under
 * `homedir()`, so that run gets a scratch cwd and a scratch HOME. A test that
 * drops a shim in the developer's real `~/.mthds/bin` is a test that changed
 * the machine it ran on.
 */
function runAgent(
  args: string[],
  sandbox?: Sandbox,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("node", [CLI_PATH, ...args], {
    encoding: "utf-8",
    timeout: 10_000,
    cwd: sandbox?.cwd,
    env: sandbox ? { ...process.env, HOME: sandbox.home } : process.env,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function parseJson(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

function writeMethod(repoDir: string, name: string, constraint: string): void {
  const dir = join(repoDir, "methods", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "METHODS.toml"),
    [
      "[package]",
      `name = "${name}"`,
      'address = "github.com/acme/tools"',
      'version = "1.0.0"',
      `description = "The ${name} method"`,
      `mthds_version = "${constraint}"`,
      "",
      "[exports.tools]",
      'pipes = ["run"]',
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "main.mthds"), 'domain = "tools"\n');
}

interface SkipReport {
  name: string;
  errors: string[];
}

function skippedNames(result: Record<string, unknown>): string[] {
  return (result.skipped_methods as SkipReport[]).map((entry) => entry.name);
}

describe("mthds-agent and the methods it refuses (e2e)", () => {
  let repoDir: string;
  let scratch: string[];

  function sandbox(): Sandbox {
    const box = {
      cwd: mkdtempSync(join(tmpdir(), "mthds-skip-cwd-")),
      home: mkdtempSync(join(tmpdir(), "mthds-skip-home-")),
    };
    scratch.push(box.cwd, box.home);
    return box;
  }

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "mthds-skip-e2e-"));
    scratch = [repoDir];
    writeMethod(repoDir, "legacy_tool", FOREIGN_CONSTRAINT);
    writeMethod(repoDir, "new_tool", `>=${MTHDS_STANDARD_VERSION}`);
  });

  afterEach(() => {
    for (const dir of scratch) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("publish names what it did not publish", () => {
    const { stdout, status } = runAgent(["publish", "--local", repoDir]);

    expect(status).toBe(0);
    const result = parseJson(stdout);
    expect(result.success).toBe(true);
    expect(result.published_methods).toEqual(["new_tool"]);
    expect(skippedNames(result)).toEqual(["legacy_tool"]);
    expect((result.skipped_methods as SkipReport[])[0]!.errors.join(" ")).toContain(
      "mthds_version",
    );
  });

  it("install names what it did not install", () => {
    const { stdout, status } = runAgent(
      ["install", "--local", repoDir, "--location", "local", "--no-runner"],
      sandbox(),
    );

    expect(status).toBe(0);
    const result = parseJson(stdout);
    expect(result.installed_methods).toEqual(["new_tool"]);
    expect(skippedNames(result)).toEqual(["legacy_tool"]);
  });

  it("share names what it did not share", () => {
    const { stdout, status } = runAgent(["share", "--local", repoDir, "--platform", "x"]);

    expect(status).toBe(0);
    const result = parseJson(stdout);
    expect(result.methods).toEqual(["new_tool"]);
    expect(skippedNames(result)).toEqual(["legacy_tool"]);
  });

  it("carries the field as an empty array when every method was usable", () => {
    rmSync(join(repoDir, "methods", "legacy_tool"), { recursive: true, force: true });

    const { stdout, status } = runAgent(["publish", "--local", repoDir]);

    expect(status).toBe(0);
    expect(parseJson(stdout).skipped_methods).toEqual([]);
  });

  it("tells --method why a refused method is unusable instead of calling it missing", () => {
    const { stderr, status } = runAgent(["publish", "--local", repoDir, "--method", "legacy_tool"]);

    expect(status).toBe(1);
    const result = parseJson(stderr);
    expect(result.message).toContain('Method "legacy_tool" was found but skipped');
    expect(result.message).toContain("mthds_version");
    expect(result.message).not.toContain("not found");
    expect(skippedNames(result)).toEqual(["legacy_tool"]);
  });

  it("still reports a genuinely absent name as not found", () => {
    const { stderr, status } = runAgent(["publish", "--local", repoDir, "--method", "typo_tool"]);

    expect(status).toBe(1);
    const result = parseJson(stderr);
    expect(result.message).toContain('Method "typo_tool" not found');
    expect(result.message).toContain("new_tool");
  });

  it("says why nothing survived, rather than only that nothing did", () => {
    rmSync(join(repoDir, "methods", "new_tool"), { recursive: true, force: true });

    const { stderr, status } = runAgent(["publish", "--local", repoDir]);

    expect(status).toBe(1);
    const result = parseJson(stderr);
    expect(result.message).toBe("No valid methods to publish.");
    expect(skippedNames(result)).toEqual(["legacy_tool"]);
    expect((result.skipped_methods as SkipReport[])[0]!.errors.join(" ")).toContain(
      "mthds_version",
    );
  });
});
