import { describe, expect, it } from "vitest";
import { Command, Option } from "commander";
import {
  agentNoticeAllowed,
  errorsAreJson,
  scannedOptionValues,
} from "../../../src/agent/usage-stats-notice.js";

// When mthds-agent may print the usage-statistics notice. The format options are read from what
// Commander parsed when the command declares them, and otherwise from the arguments up to `--`.

/** `mthds-agent validate bundle`, declaring its options as the API runner does; parsed from `argv`. */
function parsedValidateBundle(argv: string[]): Command {
  const program = new Command().exitOverride();
  let leaf: Command | undefined;
  program
    .command("validate")
    .command("bundle")
    .argument("[target]")
    .option("--content <mthds>")
    .addOption(new Option("--format <fmt>").choices(["markdown", "json"]))
    .addOption(new Option("--error-format <fmt>").choices(["markdown", "json"]))
    .allowExcessArguments(true)
    .action((_target, _options, command: Command) => {
      leaf = command;
    });
  program.parse(["validate", "bundle", ...argv], { from: "user" });
  return leaf!;
}

/** A pipelex-runner stub, which declares none of the options it hands to pipelex-agent. */
function stub(): Command {
  return new Command("pipe").allowUnknownOption();
}

describe("scannedOptionValues", () => {
  const FORMATS = ["--error-format", "--format"];

  it("reads `--name value` and `--name=value`, the last one given winning", () => {
    expect(scannedOptionValues(["--format", "json"], FORMATS).get("--format")).toBe("json");
    expect(scannedOptionValues(["--format=json"], FORMATS).get("--format")).toBe("json");
    const last = scannedOptionValues(["--format", "json", "--format=markdown"], FORMATS);
    expect(last.get("--format")).toBe("markdown");
  });

  it("stops at `--`, after which every token is an argument", () => {
    const after = scannedOptionValues(["run", "pipe", "x", "--", "--format", "json"], FORMATS);
    expect(after.get("--format")).toBe(undefined);
    expect(scannedOptionValues(["--format", "--"], FORMATS).get("--format")).toBe(undefined);
    const valueless = scannedOptionValues(["--format", "--", "--error-format", "json"], FORMATS);
    expect(valueless.size).toBe(0);
  });

  it("takes an option's value as that value, never as another option", () => {
    const values = scannedOptionValues(["--format", "--error-format", "json"], FORMATS);
    expect(values.get("--format")).toBe("--error-format");
    expect(values.get("--error-format")).toBe(undefined);
  });
});

describe("errorsAreJson", () => {
  it("reads a command's own declared options from what Commander parsed", () => {
    expect(errorsAreJson(parsedValidateBundle(["x.mthds", "--format", "json"]), [])).toBe(true);
    expect(
      errorsAreJson(
        parsedValidateBundle(["x.mthds", "--format", "json", "--error-format", "markdown"]),
        [],
      ),
    ).toBe(false);
  });

  it("does not read an option's value as the format option", () => {
    // `--content` takes `--format` as its value; `json` is the target.
    const argv = ["--content", "--format", "json"];
    expect(errorsAreJson(parsedValidateBundle(argv), ["validate", "bundle", ...argv])).toBe(false);
  });

  it("reads a stub's arguments up to `--`", () => {
    expect(errorsAreJson(stub(), ["run", "pipe", "x", "--format", "json"])).toBe(true);
    expect(errorsAreJson(stub(), ["run", "pipe", "x", "--error-format=json"])).toBe(true);
    expect(
      errorsAreJson(stub(), ["run", "pipe", "x", "--format", "json", "--error-format", "markdown"]),
    ).toBe(false);
    expect(errorsAreJson(stub(), ["run", "pipe", "x", "--", "--format", "json"])).toBe(false);
  });
});

describe("agentNoticeAllowed", () => {
  it("never allows it on a native command", () => {
    expect(agentNoticeAllowed({ path: "config list", command: stub(), argv: [] }, false)).toBe(
      false,
    );
  });

  it("allows it on a runner command whose errors are Markdown", () => {
    const argv = ["run", "pipe", "x"];
    expect(agentNoticeAllowed({ path: "run pipe", command: stub(), argv }, false)).toBe(true);
  });

  it("allows it on the API runner only where errors can be Markdown", () => {
    const command = parsedValidateBundle(["x.mthds"]);
    expect(agentNoticeAllowed({ path: "validate bundle", command, argv: [] }, true)).toBe(true);
    expect(agentNoticeAllowed({ path: "run pipe", command: stub(), argv: [] }, true)).toBe(false);
  });
});
