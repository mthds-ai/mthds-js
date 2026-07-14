import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emitInputsTemplate } from "../../../src/agent/commands/api-commands.js";
import type { Runner, BuildInputsResponse } from "../../../src/runners/types.js";

// An invalid build closure is a PRODUCED verdict (a 200 `is_valid: false` body), not a
// request/transport failure. The spec reserves `ValidateBundleError` for produced
// verdicts — `is_valid` / `validation_errors` ride only that envelope — while
// `ValidationError` is the no-verdict type. These tests pin `emitInputsTemplate` to the
// same envelope `runProtocolValidate` emits for the identical case.

function makeRunner(report: BuildInputsResponse): Runner {
  return { type: "pipelex", buildInputs: vi.fn().mockResolvedValue(report) } as unknown as Runner;
}

describe("emitInputsTemplate — invalid closure verdict envelope", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // agentError ends in process.exit(1); throw a sentinel so the test can catch it.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a ValidateBundleError envelope carrying the verdict fields", async () => {
    const runner = makeRunner({
      is_valid: false,
      message: "Bundle is invalid",
      validation_errors: [{ category: "blueprint_validation", message: "boom" } as never],
    } as BuildInputsResponse);

    await expect(
      emitInputsTemplate(runner, { content: 'domain = "x"\n' }, undefined),
    ).rejects.toThrow("__exit__");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const envelope = JSON.parse(stderrSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
    expect(envelope.error_type).toBe("ValidateBundleError");
    expect(envelope.error_domain).toBe("validation");
    expect(envelope.is_valid).toBe(false);
    expect(envelope.validation_errors).toEqual([
      { category: "blueprint_validation", message: "boom" },
    ]);
  });
});
