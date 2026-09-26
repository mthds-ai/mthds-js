import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  emitInputsTemplate,
  runProtocolValidate,
} from "../../../src/agent/commands/api-commands.js";
import type { BuildInputsResponse, Runner } from "../../../src/runners/types.js";
import type { ValidationResult } from "../../../src/protocol/models.js";
import type { ValidationErrorItem } from "../../../src/runners/api/models.js";

// A validation item's suggested fix is the next step of a refusal: for an unknown
// model, it names the model to use instead. mthds-agent's invalid-verdict envelope
// carries each item whole, so the fix and the missing pipe reach the agent.

const UNKNOWN_MODEL_ITEM: ValidationErrorItem = {
  category: "pipe_validation",
  error_type: "unknown_model",
  message: "Model handle 'gpt-5.1' was not found in the model deck. Did you mean: gpt-5?",
  pipe_code: "summarize",
  domain_code: "demo",
  source: "demo.mthds",
  field_path: "pipe.summarize.model",
  field_name: "model",
  model_reference: "gpt-5.1",
  model_type: "llm",
  suggestions: ["gpt-5"],
  suggested_fix: {
    fix_code: "rename-model",
    description:
      "Replace model 'gpt-5.1' of pipe 'summarize' with 'gpt-5', its one close match in the model deck",
    safety: "safe",
    source: "demo.mthds",
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

const MISSING_PIPE_ITEM: ValidationErrorItem = {
  category: "pipe_validation",
  error_type: "unresolved_pipe_dependency",
  message: "Pipe 'demo.main' refers to 'summarise', which no bundle declares.",
  pipe_code: "main",
  domain_code: "demo",
  missing_pipe_code: "summarise",
  field_path: "pipe.main",
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
      validation_errors: [UNKNOWN_MODEL_ITEM, MISSING_PIPE_ITEM],
    } as ValidationResult;
    const runner = {
      type: "api",
      validate: vi.fn().mockResolvedValue(report),
    } as unknown as Runner;

    await expect(runProtocolValidate(runner, ["x"], false, undefined, "json")).rejects.toThrow(
      "__exit__",
    );

    const envelope = stderrEnvelope();
    expect(envelope.error_type).toBe("ValidateBundleError");
    expect(envelope.is_valid).toBe(false);
    expect(envelope.validation_errors).toEqual([UNKNOWN_MODEL_ITEM, MISSING_PIPE_ITEM]);
  });

  it("validate falls back to the same envelope when the runner renders no Markdown", async () => {
    const report = {
      is_valid: false,
      message: "MTHDS validation found errors",
      pending_signatures: [],
      is_runnable: false,
      validation_errors: [UNKNOWN_MODEL_ITEM],
    } as ValidationResult;
    const runner = {
      type: "api",
      validate: vi.fn().mockResolvedValue(report),
    } as unknown as Runner;

    await expect(runProtocolValidate(runner, ["x"], false)).rejects.toThrow("__exit__");

    const items = stderrEnvelope().validation_errors as ValidationErrorItem[];
    expect(items[0]!.suggested_fix?.description).toBe(
      UNKNOWN_MODEL_ITEM.suggested_fix!.description,
    );
  });

  it("inputs prints the suggested fix and the missing pipe of an invalid closure", async () => {
    const runner = {
      type: "api",
      buildInputs: vi.fn().mockResolvedValue({
        is_valid: false,
        message: "MTHDS library could not be resolved",
        validation_errors: [UNKNOWN_MODEL_ITEM, MISSING_PIPE_ITEM],
      } satisfies BuildInputsResponse),
    } as unknown as Runner;

    await expect(
      emitInputsTemplate(runner, { content: 'domain = "demo"\n' }, undefined),
    ).rejects.toThrow("__exit__");

    const envelope = stderrEnvelope();
    expect(envelope.error_type).toBe("ValidateBundleError");
    expect(envelope.validation_errors).toEqual([UNKNOWN_MODEL_ITEM, MISSING_PIPE_ITEM]);
  });
});
