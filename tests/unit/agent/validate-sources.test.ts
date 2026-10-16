import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { runProtocolValidate } from "../../../src/agent/commands/api-commands.js";
import type { Runner } from "../../../src/runners/types.js";
import type { ValidationResult } from "../../../src/protocol/models.js";
import { chooseErrorFormat } from "../../../src/agent/output.js";

// `runProtocolValidate` is the live agent validate path. These tests pin the
// `mthds_sources` threading: the file path the user passed must reach the
// concrete API client so the server names it in each item's `location.file`,
// and the `method.invalid` problem must forward that file to agent consumers. The guard is duck-typed on `.type`, so a stub runner suffices.

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

describe("runProtocolValidate — mthds_sources threading", () => {
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

  it("passes the file path as mthds_sources to the API client", async () => {
    const { runner, validate } = makeRunner("api", VALID_REPORT);
    await runProtocolValidate(runner, ["domain = 'x'"], false, ["bundle.mthds"]);
    // The default output format is markdown, so the client also opts into the
    // server's rendered_markdown extra (render: ["markdown"]); mthds_sources rides arg 3.
    expect(validate).toHaveBeenCalledWith(["domain = 'x'"], false, ["bundle.mthds"], ["markdown"]);
  });

  it("omits the sources argument when none is provided (inline --content)", async () => {
    const { runner, validate } = makeRunner("api", VALID_REPORT);
    await runProtocolValidate(runner, ["domain = 'x'"], true);
    expect(validate).toHaveBeenCalledWith(["domain = 'x'"], true, undefined, ["markdown"]);
  });

  it("does not thread sources through a non-API runner (extension lives on the client)", async () => {
    const { runner, validate } = makeRunner("pipelex", VALID_REPORT);
    await runProtocolValidate(runner, ["domain = 'x'"], false, ["bundle.mthds"]);
    expect(validate).toHaveBeenCalledWith(["domain = 'x'"], false);
  });

  it("forwards the items' files into the method.invalid problem", async () => {
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

    await expect(
      runProtocolValidate(runner, ["broken"], false, ["bundle.mthds"], "markdown", "json"),
    ).rejects.toThrow("__exit__");

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

    await expect(runProtocolValidate(runner, ["broken"], false, ["bundle.mthds"])).rejects.toThrow(
      "__exit__",
    );

    const markdown = String(stderrSpy.mock.calls[0]![0]);
    expect(markdown).toContain("`method.syntax`: The method does not parse (boom).");
    expect(markdown).toContain("file 'bundle.mthds', line 3");
  });
});
