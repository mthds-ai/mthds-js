import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runProtocolValidate } from "../../../src/agent/commands/api-commands.js";
import type { Runner } from "../../../src/runners/types.js";
import type { ValidationResult } from "../../../src/protocol/models.js";

// `runProtocolValidate` is the live agent validate path. These tests pin the
// `mthds_sources` threading: the file path the user passed must reach the
// concrete API client so the server attributes `validation_errors[].source`,
// and the structured failure envelope must forward that source to agent
// consumers. The guard is duck-typed on `.type`, so a stub runner suffices.

function makeRunner(type: "api" | "pipelex", report: ValidationResult): {
  runner: Runner;
  validate: ReturnType<typeof vi.fn>;
} {
  const validate = vi.fn().mockResolvedValue(report);
  const runner = { type, validate } as unknown as Runner;
  return { runner, validate };
}

const VALID_REPORT: ValidationResult = { is_valid: true };

describe("runProtocolValidate — mthds_sources threading", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // agentError ends in process.exit(1); throw a sentinel so the test can catch it.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the file path as mthds_sources to the API client", async () => {
    const { runner, validate } = makeRunner("api", VALID_REPORT);
    await runProtocolValidate(runner, ["domain = 'x'"], false, ["bundle.mthds"]);
    expect(validate).toHaveBeenCalledWith(["domain = 'x'"], false, ["bundle.mthds"]);
  });

  it("omits the sources argument when none is provided (inline --content)", async () => {
    const { runner, validate } = makeRunner("api", VALID_REPORT);
    await runProtocolValidate(runner, ["domain = 'x'"], true);
    expect(validate).toHaveBeenCalledWith(["domain = 'x'"], true);
  });

  it("does not thread sources through a non-API runner (extension lives on the client)", async () => {
    const { runner, validate } = makeRunner("pipelex", VALID_REPORT);
    await runProtocolValidate(runner, ["domain = 'x'"], false, ["bundle.mthds"]);
    expect(validate).toHaveBeenCalledWith(["domain = 'x'"], false);
  });

  it("forwards source-attributed validation_errors into the failure envelope", async () => {
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

    await expect(
      runProtocolValidate(runner, ["broken"], false, ["bundle.mthds"])
    ).rejects.toThrow("__exit__");

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
