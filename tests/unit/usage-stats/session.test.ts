import { describe, expect, it } from "vitest";
import { Command, Option } from "commander";
import { hostedFromOptions } from "../../../src/usage-stats/session.js";

// `hosted` comes from a run command's `--hosted` or `--local` as Commander parsed them, never from
// a token that merely looks like one.

/** `mthds run pipe`, declaring the options the CLI declares, parsed from `argv`. */
function parsedRunPipe(argv: string[]): Command {
  const program = new Command().enablePositionalOptions().exitOverride();
  let leaf: Command | undefined;
  program
    .command("run")
    .passThroughOptions()
    .command("pipe")
    .argument("<target>")
    .option("-i, --inputs <file>")
    .addOption(new Option("--hosted").conflicts("local"))
    .addOption(new Option("--local"))
    .allowExcessArguments(true)
    .action((_target, _options, command: Command) => {
      leaf = command;
    });
  program.parse(["run", "pipe", ...argv], { from: "user" });
  return leaf!;
}

describe("hostedFromOptions", () => {
  it("reads the flags Commander parsed", () => {
    expect(hostedFromOptions("run pipe", parsedRunPipe(["t", "--hosted"]))).toBe(true);
    expect(hostedFromOptions("run pipe", parsedRunPipe(["t", "--local"]))).toBe(false);
    expect(hostedFromOptions("run pipe", parsedRunPipe(["t"]))).toBe(undefined);
  });

  it("never reads an option's value or an argument after `--` as the flag", () => {
    expect(hostedFromOptions("run pipe", parsedRunPipe(["t", "--inputs", "--local"]))).toBe(
      undefined,
    );
    expect(hostedFromOptions("run pipe", parsedRunPipe(["t", "--", "--hosted"]))).toBe(undefined);
  });

  it("is absent on a command that declares neither flag, and on a command that is not a run", () => {
    const stub = new Command("pipe").allowUnknownOption();
    expect(hostedFromOptions("run pipe", stub)).toBe(undefined);
    expect(hostedFromOptions("install", parsedRunPipe(["t", "--local"]))).toBe(undefined);
  });
});
