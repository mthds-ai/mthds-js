import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runProtocolValidate } from "../../../src/agent/commands/api-commands.js";
import type { Runner } from "../../../src/runners/types.js";
import type { ValidationResult } from "../../../src/protocol/models.js";
import { chooseErrorFormat } from "../../../src/agent/output.js";

// `runProtocolValidate` is the live agent validate path. These tests pin that the method's tree
// reaches the runner as given, each item naming its file by tree path in its `location.file`, and
// that the `method.invalid` problem forwards that path to agent consumers. The guard is duck-typed
// on `.type`, so a stub runner suffices.

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
    chooseErrorFormat(undefined);
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

  it("forwards the items' files, named by tree path, into the method.invalid problem", async () => {
    const invalid: ValidationResult = {
      is_valid: false,
      message: "Bundle is invalid",
      pending_signatures: [],
      is_runnable: false,
      errors: [
        {
          code: "method.syntax",
          detail: "The method does not parse (boom).",
          params: { finding: "boom" },
          location: { file: "bundle.mthds", line: 3 },
        },
      ],
    };
    const { runner } = makeRunner("api", invalid);

    await expect(runProtocolValidate(runner, SOURCE, false, "markdown", "json")).rejects.toThrow(
      "__exit__",
    );

    expect(exitSpy).toHaveBeenCalledWith(1);
    // The first stderr write is the real method.invalid problem (mocking
    // process.exit as a throw lets the function's own catch fire a second time —
    // a test artifact; in production process.exit terminates first).
    const written = String(stderrSpy.mock.calls[0]![0]);
    const payload = JSON.parse(written) as {
      code: string;
      is_valid: boolean;
      message: string;
      errors: Array<{ location?: { file?: string } }>;
    };
    expect(payload.code).toBe("method.invalid");
    expect(payload.is_valid).toBe(false);
    expect(payload.message).toBe("Bundle is invalid");
    expect(payload.errors[0]?.location?.file).toBe("bundle.mthds");
  });

  it("names the items' files in the Markdown it renders when the runner renders none", async () => {
    const invalid: ValidationResult = {
      is_valid: false,
      message: "Bundle is invalid",
      is_runnable: false,
      errors: [
        {
          code: "method.syntax",
          detail: "The method does not parse (boom).",
          location: { file: "bundle.mthds", line: 3 },
        },
      ],
    };
    const { runner } = makeRunner("api", invalid);

    await expect(runProtocolValidate(runner, SOURCE, false)).rejects.toThrow("__exit__");

    const markdown = String(stderrSpy.mock.calls[0]![0]);
    expect(markdown).toContain("`method.syntax`: The method does not parse (boom).");
    expect(markdown).toContain("file 'bundle.mthds', line 3");
  });
});
