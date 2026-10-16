import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runProtocolValidate } from "../../../src/agent/commands/api-commands.js";
import type { Runner } from "../../../src/runners/types.js";
import type { ValidationResult } from "../../../src/protocol/models.js";

// `runProtocolValidate` is the live agent validate path. These tests pin that the method's tree
// reaches the runner as given, each diagnostic naming its file by tree path, and that the
// structured failure envelope forwards that path to agent consumers. The guard is duck-typed on
// `.type`, so a stub runner suffices.

function makeRunner(
  type: "api" | "pipelex",
  report: ValidationResult,
): {
  runner: Runner;
  validate: ReturnType<typeof vi.fn>;
} {
  const validate = vi.fn().mockResolvedValue(report);
  const runner = { type, validate } as unknown as Runner;
  return { runner, validate };
}

const VALID_REPORT: ValidationResult = { is_valid: true };
const SOURCE = { files: { "bundle.mthds": "domain = 'x'", "funcs/f.py": "def f(): ..." } };

describe("runProtocolValidate — the method's tree", () => {
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

  it("hands the tree to the API client, opting into the rendered Markdown", async () => {
    const { runner, validate } = makeRunner("api", VALID_REPORT);
    await runProtocolValidate(runner, SOURCE, true);
    expect(validate).toHaveBeenCalledWith(SOURCE, true, ["markdown"]);
  });

  it("hands the tree to a non-API runner with no render request (an API extension)", async () => {
    const { runner, validate } = makeRunner("pipelex", VALID_REPORT);
    await runProtocolValidate(runner, SOURCE, false);
    expect(validate).toHaveBeenCalledWith(SOURCE, false);
  });

  it("forwards validation_errors naming their file by tree path into the failure envelope", async () => {
    const invalid: ValidationResult = {
      is_valid: false,
      message: "Bundle is invalid",
      pending_signatures: [],
      is_runnable: false,
      validation_errors: [
        { category: "blueprint_validation", message: "boom", source: "bundle.mthds" } as never,
      ],
    };
    const { runner } = makeRunner("api", invalid);

    await expect(runProtocolValidate(runner, SOURCE, false, "json")).rejects.toThrow("__exit__");

    expect(exitSpy).toHaveBeenCalledWith(1);
    // The first stderr write is the real ValidateBundleError envelope (mocking
    // process.exit as a throw lets the function's own catch fire a second time —
    // a test artifact; in production process.exit terminates first).
    const written = String(stderrSpy.mock.calls[0]![0]);
    const payload = JSON.parse(written) as {
      error_type: string;
      is_valid: boolean;
      validation_errors: Array<{ source?: string }>;
    };
    expect(payload.error_type).toBe("ValidateBundleError");
    expect(payload.is_valid).toBe(false);
    expect(payload.validation_errors[0]?.source).toBe("bundle.mthds");
  });
});
