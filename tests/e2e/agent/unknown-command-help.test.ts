import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
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

// Commander answers `--help` before it rejects a command it does not know, so a
// deleted command would print the root help and exit 0 as if it still existed.
// `mthds-agent` refuses such a path instead, on both runners, before any help is
// written. Each case names its runner, so the user's configured default plays no part.
describe("mthds-agent --help on a path naming no command (e2e)", () => {
  it.each([
    ["pipelex", ["concept"], "concept"],
    ["pipelex", ["pipe"], "pipe"],
    ["api", ["concept"], "concept"],
    ["api", ["pipe"], "pipe"],
    ["pipelex", ["config", "nonexistent"], "nonexistent"],
    ["api", ["package", "nonexistent"], "nonexistent"],
    // A group that passes its options through reads `--help` as an argument, so
    // Commander refuses these itself, in its own words.
    ["pipelex", ["validate", "nonexistent"], "nonexistent"],
    // The API runner offers `run start` in place of `run pipe`.
    ["api", ["run", "pipe"], "pipe"],
  ])("refuses `%s` runner path %j as an unknown command", (runner, path, unknownWord) => {
    const { stdout, stderr, status } = runAgent("--runner", runner, ...path, "--help");

    expect(status).toBe(1);
    expect(stdout).toBe("");
    const payload = JSON.parse(stderr) as {
      error?: boolean;
      error_type?: string;
      message?: string;
    };
    expect(payload.error).toBe(true);
    expect(payload.error_type).toBe("ArgumentError");
    expect(payload.message?.toLowerCase()).toContain("unknown command");
    expect(payload.message).toContain(unknownWord);
  });

  it.each([
    ["pipelex", []],
    ["pipelex", ["run", "pipe"]],
    ["pipelex", ["validate", "pipe"]],
    ["pipelex", ["inputs", "pipe"]],
    ["pipelex", ["plxt", "fmt"]],
    ["api", ["run", "start"]],
    ["api", ["validate", "pipe"]],
    ["api", ["inputs", "pipe"]],
  ])("still answers `%s` runner path %j with its help", (runner, path) => {
    const { stdout, status } = runAgent("--runner", runner, ...path, "--help");

    expect(status).toBe(0);
    expect(stdout).toContain("Usage:");
  });
});
