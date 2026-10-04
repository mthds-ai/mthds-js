import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { findUnknownSubcommand } from "../../../src/cli/commands/unknown-subcommand.js";

/** A command tree shaped like the `mthds` CLI's: global options with values, groups, leaves. */
function makeProgram(): Command {
  const program = new Command("mthds")
    .option("--runner <type>", "Runner to use")
    .option("-L, --library-dir <dir>", "Additional library directory")
    .option("--no-logo", "Suppress the ASCII logo");
  const build = program.command("build");
  const inputs = build.command("inputs");
  inputs.command("method").argument("<name>");
  inputs.command("pipe").argument("<target>").option("--pipe <ref>").option("--explicit");
  program.command("run").command("pipe").argument("<target>");
  program
    .command("package")
    .option("-C, --package-dir <path>", "Package directory")
    .command("init");
  program.command("install").argument("[address]");
  return program;
}

describe("findUnknownSubcommand", () => {
  // Commander answers `--help` before it rejects an unknown subcommand, so a deleted
  // command would otherwise show the help and exit 0 as if it were still there.
  it("names a subcommand the group does not have", () => {
    const program = makeProgram();
    expect(findUnknownSubcommand(program, ["build", "output", "--help"])).toBe("output");
    expect(findUnknownSubcommand(program, ["build", "runner", "pipe", "x.mthds", "--help"])).toBe(
      "runner",
    );
    expect(findUnknownSubcommand(program, ["nonexistent", "--help"])).toBe("nonexistent");
  });

  it("accepts every path that names existing commands", () => {
    const program = makeProgram();
    expect(findUnknownSubcommand(program, ["--help"])).toBeUndefined();
    expect(findUnknownSubcommand(program, ["build", "--help"])).toBeUndefined();
    expect(findUnknownSubcommand(program, ["build", "inputs", "--help"])).toBeUndefined();
    expect(
      findUnknownSubcommand(program, ["build", "inputs", "pipe", "x.mthds", "--explicit", "-h"]),
    ).toBeUndefined();
  });

  // A leaf command's remaining words are its arguments, never subcommands.
  it("stops at a leaf command", () => {
    const program = makeProgram();
    expect(findUnknownSubcommand(program, ["run", "pipe", "anything", "--help"])).toBeUndefined();
    expect(findUnknownSubcommand(program, ["install", "org/repo", "--help"])).toBeUndefined();
  });

  it("skips an option's value, from the command that declares it or one above it", () => {
    const program = makeProgram();
    expect(
      findUnknownSubcommand(program, ["--runner", "api", "build", "inputs", "--help"]),
    ).toBeUndefined();
    expect(
      findUnknownSubcommand(program, ["-L", "lib", "build", "inputs", "pipe", "--help"]),
    ).toBeUndefined();
    expect(
      findUnknownSubcommand(program, ["package", "-C", "dir", "init", "--help"]),
    ).toBeUndefined();
    expect(findUnknownSubcommand(program, ["--runner=api", "build", "output", "--help"])).toBe(
      "output",
    );
    expect(findUnknownSubcommand(program, ["-Llib", "build", "output", "--help"])).toBe("output");
  });

  it("leaves Commander's help command and the end of options to Commander", () => {
    const program = makeProgram();
    expect(findUnknownSubcommand(program, ["help", "build"])).toBeUndefined();
    expect(findUnknownSubcommand(program, ["build", "--", "output"])).toBeUndefined();
  });
});
