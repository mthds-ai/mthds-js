import { describe, expect, it } from "vitest";
import { extractTopLevelOptions } from "../../../../src/agent/commands/pipelex.js";

describe("extractTopLevelOptions", () => {
  it("extracts --log-level before subcommand args", () => {
    const result = extractTopLevelOptions(["--log-level", "debug", "some-arg"]);
    expect(result.topLevel).toEqual(["--log-level", "debug"]);
    expect(result.rest).toEqual(["some-arg"]);
  });

  it("extracts --log-level=value syntax", () => {
    const result = extractTopLevelOptions(["--log-level=debug", "some-arg"]);
    expect(result.topLevel).toEqual(["--log-level=debug"]);
    expect(result.rest).toEqual(["some-arg"]);
  });

  it("leaves bare --log-level with no value in rest", () => {
    const result = extractTopLevelOptions(["--log-level"]);
    expect(result.topLevel).toEqual([]);
    expect(result.rest).toEqual(["--log-level"]);
  });

  it("stops scanning at -- separator", () => {
    const result = extractTopLevelOptions([
      "--log-level",
      "debug",
      "--",
      "--log-level",
      "info",
    ]);
    expect(result.topLevel).toEqual(["--log-level", "debug"]);
    expect(result.rest).toEqual(["--", "--log-level", "info"]);
  });

  it("passes everything through when -- is first", () => {
    const result = extractTopLevelOptions(["--", "--log-level", "debug"]);
    expect(result.topLevel).toEqual([]);
    expect(result.rest).toEqual(["--", "--log-level", "debug"]);
  });

  it("passes through args that are not top-level options", () => {
    const result = extractTopLevelOptions(["--verbose", "run", "pipe"]);
    expect(result.topLevel).toEqual([]);
    expect(result.rest).toEqual(["--verbose", "run", "pipe"]);
  });
});
