import { describe, it, expect, afterEach } from "vitest";
import { extractArgsForPipelexAgent } from "../../../src/agent/commands/pipelex-passthrough.js";

const ORIGINAL_ARGV = process.argv;

function setArgv(args: string[]): void {
  process.argv = ["node", "/path/to/mthds-agent", ...args];
}

afterEach(() => {
  process.argv = ORIGINAL_ARGV;
});

describe("extractArgsForPipelexAgent", () => {
  it("returns positional args unchanged", () => {
    setArgv(["models"]);
    expect(extractArgsForPipelexAgent()).toEqual(["models"]);
  });

  it("strips --runner <value>", () => {
    setArgv(["--runner", "pipelex", "models"]);
    expect(extractArgsForPipelexAgent()).toEqual(["models"]);
  });

  it("strips --runner=<value>", () => {
    setArgv(["--runner=pipelex", "models"]);
    expect(extractArgsForPipelexAgent()).toEqual(["models"]);
  });

  it("strips --auto-install", () => {
    setArgv(["--auto-install", "models"]);
    expect(extractArgsForPipelexAgent()).toEqual(["models"]);
  });

  it("strips --log-level <value> (pipelex-agent 0.30.1 removed the flag)", () => {
    setArgv(["--log-level", "DEBUG", "models"]);
    expect(extractArgsForPipelexAgent()).toEqual(["models"]);
  });

  it("strips --log-level=<value>", () => {
    setArgv(["--log-level=DEBUG", "models"]);
    expect(extractArgsForPipelexAgent()).toEqual(["models"]);
  });

  it("keeps -L / --library-dir (pipelex-agent understands these)", () => {
    setArgv(["-L", "/tmp/libs", "--library-dir", "/tmp/more", "models"]);
    expect(extractArgsForPipelexAgent()).toEqual([
      "-L",
      "/tmp/libs",
      "--library-dir",
      "/tmp/more",
      "models",
    ]);
  });

  it("strips multiple mthds-agent-only flags in one invocation", () => {
    setArgv([
      "--runner",
      "pipelex",
      "--log-level",
      "DEBUG",
      "--auto-install",
      "validate",
      "bundle",
      "foo.mthds",
    ]);
    expect(extractArgsForPipelexAgent()).toEqual(["validate", "bundle", "foo.mthds"]);
  });

  it("preserves subcommand args that look like values for stripped flags", () => {
    // A positional "pipelex" or "DEBUG" later in the line must NOT be eaten
    // by greedy stripping — only the flag-and-value pairs are dropped.
    setArgv(["models", "pipelex", "DEBUG"]);
    expect(extractArgsForPipelexAgent()).toEqual(["models", "pipelex", "DEBUG"]);
  });

  it.each([
    ["before the command", ["--error-format", "json", "run", "bundle", "x.mthds"]],
    ["before the command, in its = form", ["--error-format=json", "run", "bundle", "x.mthds"]],
    ["on the command", ["run", "bundle", "x.mthds", "--error-format", "json"]],
    ["on the command, in its = form", ["run", "bundle", "--error-format=json", "x.mthds"]],
  ])("moves --error-format given %s after the command", (_where, args) => {
    setArgv(args);
    expect(extractArgsForPipelexAgent()).toEqual([
      "run",
      "bundle",
      "x.mthds",
      "--error-format",
      "json",
    ]);
  });

  it("keeps the last --error-format written", () => {
    setArgv(["--error-format", "markdown", "validate", "bundle", "x.mthds", "--error-format=json"]);
    expect(extractArgsForPipelexAgent()).toEqual([
      "validate",
      "bundle",
      "x.mthds",
      "--error-format",
      "json",
    ]);
  });

  it("drops --error-format for a command pipelex-agent does not give it", () => {
    setArgv(["--error-format", "json", "inputs", "bundle", "x.mthds", "--error-format=json"]);
    expect(extractArgsForPipelexAgent({ forwardErrorFormat: false })).toEqual([
      "inputs",
      "bundle",
      "x.mthds",
    ]);
  });

  it("forwards the operands after -- verbatim, after the options", () => {
    setArgv(["--error-format", "json", "run", "bundle", "--", "--error-format", "x.mthds"]);
    expect(extractArgsForPipelexAgent()).toEqual([
      "run",
      "bundle",
      "--error-format",
      "json",
      "--",
      "--error-format",
      "x.mthds",
    ]);
  });
});
