import { afterEach, describe, expect, it, vi } from "vitest";
import type { Problem } from "../../../src/problems/types.js";

// A ProblemError no command caught reaches mthds-agent's last catch, which writes its problem as
// received rather than flattening it into runtime.unexpected. `upgrade` stands in for any command:
// its action is made to throw, and the problem written is captured.

const thrown = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("../../../src/agent/commands/upgrade.js", () => ({
  agentUpgrade: vi.fn(async () => {
    throw thrown.value;
  }),
}));

const written = vi.hoisted(() => ({ problems: [] as Problem[] }));

vi.mock("../../../src/agent/output.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/agent/output.js")>();
  return {
    ...original,
    agentError: vi.fn((problem: Problem) => {
      written.problems.push(problem);
    }),
    // The last catch writes an error it caught through `agentErrorOf`, which writes its problem.
    agentErrorOf: vi.fn((err: unknown, fallback: (message: string) => Problem) => {
      written.problems.push(original.problemOfError(err, fallback));
    }),
  };
});

const ORIGINAL_ARGV = process.argv;

afterEach(() => {
  process.argv = ORIGINAL_ARGV;
  written.problems.length = 0;
  vi.resetModules();
});

/** Run `mthds-agent upgrade` with its action throwing `err`, and give the problem written. */
async function problemWrittenFor(err: unknown): Promise<Problem> {
  thrown.value = err;
  process.argv = ["node", "/path/to/mthds-agent", "upgrade"];
  await import("../../../src/agent-cli.js");
  // Importing the CLI compiles its whole command tree, which takes a while on a loaded machine.
  await vi.waitFor(() => expect(written.problems).toHaveLength(1), { timeout: 30_000 });
  return written.problems[0]!;
}

describe("mthds-agent's last catch", { timeout: 60_000 }, () => {
  it("writes an escaping ProblemError's problem as received", async () => {
    const { problemError } = await import("../../../src/problems/errors.js");
    const problem = await problemWrittenFor(
      problemError("client.not_configured", { setting: "base_url" }, { message: "No base URL." }),
    );
    expect(problem).toMatchObject({
      code: "client.not_configured",
      params: { setting: "base_url" },
      message: "No base URL.",
    });
  });

  it("writes any other escaping error as runtime.unexpected with its message", async () => {
    const problem = await problemWrittenFor(new Error("boom"));
    expect(problem).toMatchObject({ code: "runtime.unexpected", message: "boom" });
  });
});
