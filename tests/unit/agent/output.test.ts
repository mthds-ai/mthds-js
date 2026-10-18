import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agentError,
  agentMarkdownError,
  agentProblem,
  agentWarning,
  chooseErrorFormat,
  problemOfError,
  resolveErrorFormat,
  unexpectedProblem,
} from "../../../src/agent/output.js";
import { BINARY_RECOVERY, buildInstallCommand } from "../../../src/agent/binaries.js";
import { buildProblem } from "../../../src/problems/build.js";
import { ProblemError } from "../../../src/problems/errors.js";
import { CORE_REGISTRY } from "../../../src/problems/registry.generated.js";
import type { Problem } from "../../../src/problems/types.js";
import { outcomeNotes, resetOutcomeNotes } from "../../../src/usage-stats/outcome.js";

// Every mthds-agent failure is one problem with a registered code, written on stderr: rendered as
// Markdown by default, for the agent reading it, and as the problem's JSON form, without `status`,
// when the command line asks for JSON. The members of this CLI's own ride beside the core ones,
// and the problem's domain is noted for the command's usage statistics.

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetOutcomeNotes();
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("__exit__");
  }) as never);
});

afterEach(() => {
  chooseErrorFormat(undefined);
  vi.restoreAllMocks();
});

function written(): string {
  return String(stderrSpy.mock.calls[0]![0]);
}

function writtenJson(): Record<string, unknown> {
  return JSON.parse(written()) as Record<string, unknown>;
}

describe("resolveErrorFormat", () => {
  it("is Markdown when the command line says nothing", () => {
    expect(resolveErrorFormat(["node", "mthds-agent", "models"])).toBe("markdown");
  });

  it.each([
    [["--error-format", "json"], "json"],
    [["--error-format=json"], "json"],
    [["--error-format", "markdown"], "markdown"],
    [["--format", "json"], "json"],
    [["--format=json"], "json"],
    [["--format", "markdown"], "markdown"],
    [["--format", "json", "--error-format", "markdown"], "markdown"],
    [["--format", "markdown", "--error-format", "json"], "json"],
  ] as const)("reads %j as %s", (args, expected) => {
    expect(resolveErrorFormat(["node", "mthds-agent", "validate", ...args])).toBe(expected);
  });

  it("ignores an error format it does not know, falling back to --format then Markdown", () => {
    expect(resolveErrorFormat(["node", "x", "--error-format", "yaml"])).toBe("markdown");
    expect(resolveErrorFormat(["node", "x", "--error-format", "yaml", "--format", "json"])).toBe(
      "json",
    );
  });
});

describe("agentProblem", () => {
  it("builds the code's problem from the registry, with the command's sentence in message", () => {
    const problem = agentProblem(
      "client.argument_invalid",
      { argument: "--type", reason: "unknown_value" },
      "--type must be one of: llm, extract.",
    );
    expect(problem).toEqual({
      type: "https://mthds.ai/errors/client.argument_invalid",
      title: "An argument was refused before sending",
      detail: "The argument '--type' was refused before any request left (reason: unknown_value).",
      code: "client.argument_invalid",
      domain: "input",
      retry: "no",
      next_step: {
        kind: "change_input",
        detail: "Correct the argument '--type', then try again.",
      },
      params: { argument: "--type", reason: "unknown_value" },
      message: "--type must be one of: llm, extract.",
    });
  });

  it("writes no message member when the command gives no sentence", () => {
    expect(agentProblem("client.tool_missing", { tool: "plxt" })).not.toHaveProperty("message");
  });

  it("carries the step of the reader it is given", () => {
    const actor = agentProblem("runtime.unsupported", { capability: "codegen" }, "No codegen.", {
      reader: "actor",
    });
    const other = agentProblem("runtime.unsupported", { capability: "codegen" }, "No codegen.", {
      reader: "other",
    });
    expect(actor.code).toBe("runtime.unsupported");
    expect(actor.domain).toBe("operator");
    expect(actor.next_step).not.toEqual(other.next_step);
  });
});

describe("agentError", () => {
  it("writes the problem as Markdown by default, stating title, detail, message, step and code", () => {
    chooseErrorFormat("markdown");
    expect(() =>
      agentError(
        agentProblem("client.argument_invalid", { argument: "command", reason: "missing" }, "No."),
      ),
    ).toThrow("__exit__");
    const markdown = written();
    expect(markdown).toContain("## An argument was refused before sending");
    expect(markdown).toContain(
      "The argument 'command' was refused before any request left (reason: missing).",
    );
    expect(markdown).toContain("No.");
    expect(markdown).toContain("**Next step** (`change_input`)");
    expect(markdown).toContain("`client.argument_invalid`");
    expect(() => JSON.parse(markdown)).toThrow();
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("writes the problem's JSON form under --error-format json", () => {
    chooseErrorFormat("json");
    const problem = agentProblem("client.tool_missing", { tool: "plxt" }, "plxt not found.");
    expect(() => agentError(problem)).toThrow("__exit__");
    expect(writtenJson()).toEqual(problem);
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("reads the format from the command line when no command chose one", () => {
    const argv = process.argv;
    process.argv = ["node", "mthds-agent", "models", "--error-format", "json"];
    try {
      expect(() => agentError(unexpectedProblem("It broke."))).toThrow("__exit__");
    } finally {
      process.argv = argv;
    }
    expect(writtenJson()).toMatchObject({ code: "runtime.unexpected", message: "It broke." });
  });

  it("leaves out the status of a problem relayed from a runner", () => {
    chooseErrorFormat("json");
    const relayed = buildProblem("request.pipe_not_found", {
      pipe: "demo.nope",
      suggestions: ["demo.main"],
    });
    relayed.status = 422;
    expect(() => agentError(relayed)).toThrow("__exit__");
    const envelope = writtenJson();
    expect(envelope).not.toHaveProperty("status");
    expect(envelope).toMatchObject({
      code: "request.pipe_not_found",
      params: { pipe: "demo.nope", suggestions: ["demo.main"] },
    });
  });

  it("writes the extras beside the problem's members", () => {
    chooseErrorFormat("json");
    const recovery = BINARY_RECOVERY["plxt"]!;
    expect(() =>
      agentError(agentProblem("client.tool_missing", { tool: "plxt" }), {
        recovery,
        is_valid: false,
        skipped_methods: [{ name: "old", errors: ["Too old."] }],
        registrations: [{ name: "a", outcome: "refused", message: "Not public." }],
      }),
    ).toThrow("__exit__");
    expect(writtenJson()).toMatchObject({
      code: "client.tool_missing",
      recovery: {
        binary: recovery.binary,
        uv_package: recovery.uv_package,
        version_constraint: recovery.version_constraint,
      },
      is_valid: false,
      skipped_methods: [{ name: "old", errors: ["Too old."] }],
      registrations: [{ name: "a", outcome: "refused", message: "Not public." }],
    });
  });

  it("renders the extras as Markdown sections after the problem", () => {
    chooseErrorFormat("markdown");
    const recovery = BINARY_RECOVERY["plxt"]!;
    expect(() =>
      agentError(agentProblem("client.tool_missing", { tool: "plxt" }), {
        recovery,
        skipped_methods: [{ name: "old", errors: ["Too old.", "No main pipe."] }],
        registrations: [
          { name: "a", outcome: "refused", message: "Not public." },
          { name: "b", outcome: "error", error: { message: "Hub down." } },
        ],
      }),
    ).toThrow("__exit__");
    const markdown = written();
    expect(markdown).toContain(`### Recovery\n\nRun \`${buildInstallCommand(recovery)}\`.`);
    expect(markdown).toContain("### Skipped methods\n\n- `old`: Too old.; No main pipe.");
    expect(markdown).toContain(
      "### Registrations\n\n- `a`: refused (Not public.)\n- `b`: error (Hub down.)",
    );
    expect(markdown.indexOf("### Recovery")).toBeGreaterThan(
      markdown.indexOf("`client.tool_missing`"),
    );
  });

  it("never lets an extra overwrite a member of the problem, and skips an undefined one", () => {
    chooseErrorFormat("json");
    expect(() =>
      agentError(agentProblem("client.tool_missing", { tool: "plxt" }), {
        skipped_methods: undefined,
        ...({ code: "overwritten" } as object),
      }),
    ).toThrow("__exit__");
    const envelope = writtenJson();
    expect(envelope.code).toBe("client.tool_missing");
    expect(envelope).not.toHaveProperty("skipped_methods");
  });

  // A member the runtime's problem holds under an extra's name is kept, and the client's extra of
  // that name is written in neither form, so the JSON and the Markdown forms carry the same extras.
  describe("an extra named as a member the runtime's problem holds", () => {
    const problem = buildProblem(
      "runtime.misconfigured",
      {},
      { status: 500, extra: { server_answer: "the runtime's own" } },
    );
    const extras = {
      server_answer: { route: "POST /v1/validate", status: 500, excerpt: "what the client read" },
      recovery: BINARY_RECOVERY["plxt"]!,
    };

    it("keeps the problem's member in the JSON form", () => {
      chooseErrorFormat("json");
      expect(() => agentError(problem, extras)).toThrow("__exit__");
      const envelope = writtenJson();
      expect(envelope.server_answer).toBe("the runtime's own");
      expect(envelope).toHaveProperty("recovery");
    });

    it("renders no section of the client's extra in the Markdown form", () => {
      chooseErrorFormat("markdown");
      expect(() => agentError(problem, extras)).toThrow("__exit__");
      const markdown = written();
      expect(markdown).not.toContain("### Server answer");
      expect(markdown).not.toContain("POST /v1/validate");
      expect(markdown).not.toContain("what the client read");
      expect(markdown).toContain("### Recovery");
    });
  });
});

describe("agentWarning", () => {
  it("writes a JSON warning with its members in the JSON form, and never exits", () => {
    chooseErrorFormat("json");
    agentWarning("Upgrade may not have taken effect.", { version_constraint: ">=1.0.0" });
    expect(writtenJson()).toEqual({
      warning: true,
      message: "Upgrade may not have taken effect.",
      version_constraint: ">=1.0.0",
    });
    expect(process.exit).not.toHaveBeenCalled();
  });

  it("writes a Markdown warning line by default", () => {
    chooseErrorFormat("markdown");
    agentWarning("Upgrade may not have taken effect.", { version_constraint: ">=1.0.0" });
    expect(written()).toBe("> **Warning**: Upgrade may not have taken effect.\n");
    expect(process.exit).not.toHaveBeenCalled();
  });
});

describe("agentMarkdownError", () => {
  it("writes the runner's Markdown as it came and notes the problem's domain", () => {
    const problem = buildProblem("method.invalid", {});
    expect(() => agentMarkdownError("# Invalid\n", problem)).toThrow("__exit__");
    expect(written()).toBe("# Invalid\n");
    expect(outcomeNotes().errorDomain).toBe("input");
  });

  it("ends the Markdown with a newline", () => {
    expect(() => agentMarkdownError("# Invalid", buildProblem("method.invalid", {}))).toThrow(
      "__exit__",
    );
    expect(written()).toBe("# Invalid\n");
  });
});

describe("problemOfError", () => {
  it("forwards the problem a ProblemError carries, whole", () => {
    const problem = buildProblem(
      "method.invalid",
      {},
      {
        status: 422,
        errors: [{ code: "method.syntax", detail: "The method does not parse (eof)." }],
        extra: { request_id: "req-1" },
      },
    );
    expect(problemOfError(new ProblemError(problem), unexpectedProblem)).toBe(problem);
  });

  it("reads any other error by the fallback, with its message", () => {
    const problem = problemOfError(new Error("disk on fire"), unexpectedProblem);
    expect(problem).toMatchObject({
      code: "runtime.unexpected",
      domain: "runtime",
      message: "disk on fire",
    });
  });

  it("reads a thrown value that is not an Error by its string", () => {
    const fallback = vi.fn((message: string): Problem => unexpectedProblem(message));
    problemOfError("plain", fallback);
    expect(fallback).toHaveBeenCalledWith("plain");
  });
});

describe("agentError and the usage statistics", () => {
  function domainNotedFor(problem: Problem): string | undefined {
    resetOutcomeNotes();
    expect(() => agentError(problem)).toThrow("__exit__");
    return outcomeNotes().errorDomain;
  }

  it.each([
    ["client.argument_invalid", "input"],
    ["method.invalid", "input"],
    ["runtime.unsupported", "config"],
    ["account.quota_exhausted", "config"],
    ["runtime.unexpected", "runtime"],
    ["client.unreachable", "runtime"],
  ] as const)("notes the domain of %s as %s", (code, expected) => {
    const problem = { ...unexpectedProblem("x"), code, domain: CORE_REGISTRY[code].domain };
    expect(domainNotedFor(problem)).toBe(expected);
  });

  it("reads a domain it does not know by the code's family, an unknown family as runtime", () => {
    expect(
      domainNotedFor({ ...unexpectedProblem("x"), code: "quorum.lost", domain: "elsewhere" }),
    ).toBe("runtime");
  });

  it("keeps the first domain noted", () => {
    expect(() =>
      agentError(agentProblem("client.argument_invalid", { argument: "a", reason: "b" })),
    ).toThrow("__exit__");
    expect(() => agentError(unexpectedProblem("Second."))).toThrow("__exit__");
    expect(outcomeNotes().errorDomain).toBe("input");
  });
});
