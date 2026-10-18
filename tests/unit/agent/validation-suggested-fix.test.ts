import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  emitInputsTemplate,
  runProtocolValidate,
} from "../../../src/agent/commands/api-commands.js";
import type { PipeIOResponse, Runner } from "../../../src/runners/types.js";
import type { ValidationResult } from "../../../src/protocol/models.js";
import { chooseErrorFormat } from "../../../src/agent/output.js";
import type { ProblemItem } from "../../../src/problems/types.js";

// An item's suggested fix is the next step of a refusal: for an unknown model, it
// names the model to use instead. mthds-agent writes an invalid verdict as the
// `method.invalid` problem holding each item whole, so the fix and the missing pipe
// reach the agent.

const UNKNOWN_MODEL_ITEM: ProblemItem = {
  code: "model.unknown",
  detail: "Model handle 'gpt-5.1' was not found in the model deck. Did you mean: gpt-5?",
  params: { model: "gpt-5.1", model_type: "llm", suggestions: ["gpt-5"] },
  location: { pipe: "summarize", field: "model", file: "demo.mthds" },
  suggestions: ["gpt-5"],
  suggested_fix: {
    fix_code: "rename-model",
    description:
      "Replace model 'gpt-5.1' of pipe 'summarize' with 'gpt-5', its one close match in the model deck",
    safety: "unsafe",
    file: "demo.mthds",
    ops: [
      {
        kind: "remap_value",
        table_path: ["pipe", "summarize"],
        key: "model",
        mapping: { "gpt-5.1": "gpt-5" },
      },
    ],
  },
};

const MISSING_PIPE_ITEM: ProblemItem = {
  code: "method.pipe_unresolved",
  detail: "Pipe 'demo.main' refers to 'summarise', which no bundle declares.",
  params: { pipe: "main", missing: "demo.summarise", candidates: [] },
  location: { pipe: "main" },
};

describe("mthds-agent invalid-verdict envelope keeps each item's next step", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // agentError ends in process.exit(1); throw a sentinel so the test can catch it.
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
  });

  afterEach(() => {
    chooseErrorFormat(undefined);
    vi.restoreAllMocks();
  });

  function stderrEnvelope(): Record<string, unknown> {
    return JSON.parse(String(stderrSpy.mock.calls[0]![0])) as Record<string, unknown>;
  }

  it("validate --format json prints the suggested fix and the missing pipe", async () => {
    const report = {
      is_valid: false,
      message: "MTHDS validation found errors",
      pending_signatures: [],
      is_runnable: false,
      errors: [UNKNOWN_MODEL_ITEM, MISSING_PIPE_ITEM],
    } as ValidationResult;
    const runner = {
      type: "api",
      validate: vi.fn().mockResolvedValue(report),
    } as unknown as Runner;

    await expect(
      runProtocolValidate(runner, { files: { "x.mthds": "x" } }, false, "json"),
    ).rejects.toThrow("__exit__");

    const envelope = stderrEnvelope();
    expect(envelope).toMatchObject({
      code: "method.invalid",
      domain: "method",
      is_valid: false,
      message: "MTHDS validation found errors",
    });
    expect(envelope).not.toHaveProperty("status");
    expect(envelope.errors).toEqual([UNKNOWN_MODEL_ITEM, MISSING_PIPE_ITEM]);
  });

  it("validate renders the problem itself when the runner renders no Markdown", async () => {
    const report = {
      is_valid: false,
      message: "MTHDS validation found errors",
      pending_signatures: [],
      is_runnable: false,
      errors: [UNKNOWN_MODEL_ITEM],
    } as ValidationResult;
    const runner = {
      type: "api",
      validate: vi.fn().mockResolvedValue(report),
    } as unknown as Runner;

    await expect(runProtocolValidate(runner, { files: { "x.mthds": "x" } }, false)).rejects.toThrow(
      "__exit__",
    );

    const markdown = String(stderrSpy.mock.calls[0]![0]);
    expect(markdown).toContain("## The method does not validate");
    expect(markdown).toContain("MTHDS validation found errors");
    expect(markdown).toContain("`model.unknown`");
    expect(markdown).toContain(
      "Suggested fix (unsafe, rename-model): " + UNKNOWN_MODEL_ITEM.suggested_fix!.description,
    );
  });

  it("validate writes the runner's own Markdown verbatim when it renders one", async () => {
    const report = {
      is_valid: false,
      message: "MTHDS validation found errors",
      is_runnable: false,
      errors: [UNKNOWN_MODEL_ITEM],
      rendered_markdown: "# Invalid bundle\n\nThe runner's own words.",
    } as ValidationResult;
    const runner = {
      type: "api",
      validate: vi.fn().mockResolvedValue(report),
    } as unknown as Runner;

    await expect(runProtocolValidate(runner, ["x"], false)).rejects.toThrow("__exit__");

    expect(String(stderrSpy.mock.calls[0]![0])).toBe(
      "# Invalid bundle\n\nThe runner's own words.\n",
    );
  });

  it("inputs prints the suggested fix and the missing pipe of an invalid method", async () => {
    const runner = {
      type: "api",
      pipeIo: vi.fn().mockResolvedValue({
        is_valid: false,
        message: "MTHDS library could not be resolved",
        errors: [UNKNOWN_MODEL_ITEM, MISSING_PIPE_ITEM],
      } satisfies PipeIOResponse),
    } as unknown as Runner;

    chooseErrorFormat("json");
    await expect(
      emitInputsTemplate(runner, { files: { "demo.mthds": 'domain = "demo"\n' } }, undefined, {
        format: "json",
        explicit: false,
      }),
    ).rejects.toThrow("__exit__");

    const envelope = stderrEnvelope();
    expect(envelope).toMatchObject({
      code: "method.invalid",
      is_valid: false,
      message: "MTHDS library could not be resolved",
    });
    expect(envelope.errors).toEqual([UNKNOWN_MODEL_ITEM, MISSING_PIPE_ITEM]);
  });
});
