import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runProtocolValidate } from "../../../src/agent/commands/api-commands.js";
import type { Runner } from "../../../src/runners/types.js";
import type { ValidationResult } from "../../../src/protocol/models.js";

// `runProtocolValidate` honors --format on the API runner: when Markdown is wanted
// (the default) it opts into the server's `rendered_markdown` extra and emits it
// verbatim (stdout on valid, stderr+exit 1 on invalid); --format json keeps the
// structured JSON envelope. The guard is duck-typed on `.type`, so a stub suffices.

function makeRunner(report: ValidationResult): {
  runner: Runner;
  validate: ReturnType<typeof vi.fn>;
} {
  const validate = vi.fn().mockResolvedValue(report);
  const runner = { type: "api", validate } as unknown as Runner;
  return { runner, validate };
}

const VALID_WITH_MD: ValidationResult = { is_valid: true, rendered_markdown: "# Validation passed\n\nall good" } as ValidationResult;
const VALID_NO_MD: ValidationResult = { is_valid: true };
const INVALID_WITH_MD: ValidationResult = {
  is_valid: false,
  message: "Bundle is invalid",
  pending_signatures: [],
  is_runnable: false,
  validation_errors: [{ category: "blueprint_validation", message: "boom" } as never],
  rendered_markdown: "# Validation failed\n\nboom",
} as ValidationResult;

describe("runProtocolValidate — --format handling", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests render=['markdown'] when the format is markdown (the default)", async () => {
    const { runner, validate } = makeRunner(VALID_WITH_MD);
    await runProtocolValidate(runner, ["x"], false);
    expect(validate).toHaveBeenCalledWith(["x"], false, undefined, ["markdown"]);
  });

  it("does NOT request render when the format is json", async () => {
    const { runner, validate } = makeRunner(VALID_NO_MD);
    await runProtocolValidate(runner, ["x"], false, undefined, "json");
    expect(validate).toHaveBeenCalledWith(["x"], false, undefined, undefined);
  });

  it("emits rendered_markdown verbatim to stdout on a valid bundle (markdown)", async () => {
    const { runner } = makeRunner(VALID_WITH_MD);
    await runProtocolValidate(runner, ["x"], false);
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("# Validation passed");
    // It is the verbatim Markdown, not a JSON envelope.
    expect(written).not.toContain('"success"');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("emits rendered_markdown to stderr and exits 1 on an invalid bundle (markdown)", async () => {
    const { runner } = makeRunner(INVALID_WITH_MD);
    await expect(runProtocolValidate(runner, ["x"], false)).rejects.toThrow("__exit__");
    const written = String(stderrSpy.mock.calls[0]![0]);
    expect(written).toContain("# Validation failed");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("emits the JSON success envelope under --format json", async () => {
    const { runner } = makeRunner(VALID_NO_MD);
    await runProtocolValidate(runner, ["x"], false, undefined, "json");
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    const payload = JSON.parse(written) as { success: boolean; is_valid: boolean };
    expect(payload.success).toBe(true);
    expect(payload.is_valid).toBe(true);
  });

  it("falls back to the JSON envelope when the server omits rendered_markdown (markdown requested)", async () => {
    const { runner } = makeRunner(VALID_NO_MD);
    await runProtocolValidate(runner, ["x"], false);
    const written = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    // No rendered_markdown on the report → never empty: the JSON envelope is emitted.
    const payload = JSON.parse(written) as { success: boolean };
    expect(payload.success).toBe(true);
  });
});
