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

/** The problem document of a refused command line, as `--error-format json` writes it. */
interface RefusalProblem {
  code?: string;
  params?: Record<string, unknown>;
  message?: string;
  status?: number;
}

// A path naming a command `mthds-agent` does not register on the active runner is
// refused by name, on both runners, whether it is run or asked for its help. Left to
// Commander, `--help` on a deleted command printed the root help and exited 0 as if it
// still existed. Each case names its runner, so the user's configured default plays
// no part.
describe("mthds-agent on a path naming no command (e2e)", () => {
  it.each([
    ["pipelex", ["concept"], "concept"],
    ["pipelex", ["pipe"], "pipe"],
    ["api", ["concept"], "concept"],
    ["api", ["pipe"], "pipe"],
    ["pipelex", ["config", "nonexistent"], "nonexistent"],
    ["api", ["package", "nonexistent"], "nonexistent"],
    ["pipelex", ["validate", "nonexistent"], "nonexistent"],
    // The API runner offers `run start` in place of `run pipe`.
    ["api", ["run", "pipe"], "pipe"],
    // File storage is a Pipelex capability, not the MTHDS Protocol: no runner uploads.
    ["api", ["inputs", "upload"], "upload"],
    ["pipelex", ["inputs", "upload"], "upload"],
  ])("refuses `--help` on `%s` runner path %j by name", (runner, path, unknownWord) => {
    const { stdout, stderr, status } = runAgent(
      "--runner",
      runner,
      ...path,
      "--help",
      "--error-format",
      "json",
    );

    expect(status).toBe(1);
    expect(stdout).toBe("");
    const payload = JSON.parse(stderr) as RefusalProblem;
    expect(payload.code).toBe("client.argument_invalid");
    expect(payload.params).toEqual({ argument: "command", reason: "unknown_command" });
    expect(payload.message).toBe(
      `Unknown command: ${unknownWord}. Run mthds-agent --help for usage.`,
    );
    // A CLI writes the problem without the HTTP status member.
    expect(payload).not.toHaveProperty("status");
  });

  // Commander alone refused these as an unknown option or an excess argument, which
  // named neither the command nor the fault, and nothing reaches `pipelex-agent`.
  it.each([
    ["pipelex", ["concept", "--spec", "{}"], "concept"],
    ["pipelex", ["pipe", "--type", "PipeLLM", "--spec", "{}"], "pipe"],
    ["api", ["concept", "--spec-file", "spec.json"], "concept"],
    ["api", ["pipe"], "pipe"],
    ["pipelex", ["-L", "lib", "nonexistent", "arg"], "nonexistent"],
    ["api", ["inputs", "upload", "./synthetic.png"], "upload"],
  ])("refuses a run of `%s` runner path %j by name", (runner, path, unknownWord) => {
    // The error stream's default form: the problem rendered as Markdown, for the agent.
    const { stdout, stderr, status } = runAgent("--runner", runner, ...path);

    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/^## An argument was refused before sending\n/);
    expect(stderr).toContain(`Unknown command: ${unknownWord}. Run mthds-agent --help for usage.`);
    expect(stderr).toContain("- Code: `client.argument_invalid`");
  });

  it("still answers no command at all with its own refusal", () => {
    const { stderr, status } = runAgent("--runner", "pipelex", "--error-format", "json");

    expect(status).toBe(1);
    const payload = JSON.parse(stderr) as RefusalProblem;
    expect(payload.code).toBe("client.argument_invalid");
    expect(payload.params).toEqual({ argument: "command", reason: "missing" });
    expect(payload.message).toBe("No command specified. Run mthds-agent --help for usage.");
  });

  it("reads --error-format given before the command, as a program option", () => {
    const { stderr, status } = runAgent("--error-format", "json", "--runner", "api", "concept");

    expect(status).toBe(1);
    const payload = JSON.parse(stderr) as RefusalProblem;
    expect(payload.code).toBe("client.argument_invalid");
    expect(payload.message).toBe("Unknown command: concept. Run mthds-agent --help for usage.");
  });

  it("writes the error stream in JSON when --format json asks for the success stream in JSON", () => {
    const { stderr, status } = runAgent("--runner", "api", "concept", "--format", "json");

    expect(status).toBe(1);
    expect((JSON.parse(stderr) as RefusalProblem).code).toBe("client.argument_invalid");
  });

  it.each([
    ["pipelex", []],
    ["pipelex", ["run", "pipe"]],
    ["pipelex", ["validate", "pipe"]],
    ["pipelex", ["inputs", "pipe"]],
    ["pipelex", ["plxt", "fmt"]],
    ["api", ["run", "start"]],
    ["api", ["validate", "pipe"]],
    ["api", ["inputs", "bundle"]],
    ["api", ["inputs", "pipe"]],
    ["api", ["inputs", "method"]],
  ])("still answers `%s` runner path %j with its help", (runner, path) => {
    const { stdout, status } = runAgent("--runner", runner, ...path, "--help");

    expect(status).toBe(0);
    expect(stdout).toContain("Usage:");
  });
});
