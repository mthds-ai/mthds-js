import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentError, agentWarning } from "../../../src/agent/output.js";
import type { AgentErrorDomain, RunnerErrorDomain } from "../../../src/agent/output.js";
import { outcomeNotes, resetOutcomeNotes } from "../../../src/usage-stats/outcome.js";

// An agent error notes, for the command's usage statistics, who can fix it: the envelope's own
// domain read as the contract's `input`, `config` or `runtime`, and nothing when it does not say.

beforeEach(() => {
  resetOutcomeNotes();
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("__exit__");
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

type EnvelopeDomain = AgentErrorDomain | RunnerErrorDomain;

function domainNotedFor(domain: EnvelopeDomain | undefined): string | undefined {
  resetOutcomeNotes();
  expect(() =>
    agentError("It failed.", "SomeError", domain === undefined ? {} : { error_domain: domain }),
  ).toThrow("__exit__");
  return outcomeNotes().errorDomain;
}

describe("agentError and the usage statistics", () => {
  it.each([
    ["argument", "input"],
    ["validation", "input"],
    ["package", "input"],
    ["input", "input"],
    ["config", "config"],
    ["binary", "config"],
    ["runner", "runtime"],
    ["pipeline", "runtime"],
    ["runtime", "runtime"],
    ["install", undefined],
    ["io", undefined],
    [undefined, undefined],
  ] as const)("notes the envelope domain %s as %s", (domain, expected) => {
    expect(domainNotedFor(domain)).toBe(expected);
  });

  it("keeps the first domain noted", () => {
    expect(() => agentError("First.", "ArgumentError", { error_domain: "argument" })).toThrow(
      "__exit__",
    );
    expect(() => agentError("Second.", "RunnerError", { error_domain: "runner" })).toThrow(
      "__exit__",
    );
    expect(outcomeNotes().errorDomain).toBe("input");
  });
});

describe("JSON on stderr and the notice", () => {
  it("notes that an agent error wrote JSON to stderr", () => {
    expect(outcomeNotes().jsonOnStderr).toBe(false);
    expect(() => agentError("It failed.", "SomeError")).toThrow("__exit__");
    expect(outcomeNotes().jsonOnStderr).toBe(true);
  });

  it("notes that a warning wrote JSON to stderr, in the CLI's warning shape", () => {
    agentWarning({ message: "Careful." });
    expect(outcomeNotes().jsonOnStderr).toBe(true);
    expect(process.stderr.write).toHaveBeenCalledWith('{"warning":true,"message":"Careful."}\n');
  });
});
