import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// When the runner refuses a bundle, the `mthds` CLI prints each problem item, and an
// item that carries a suggested fix is followed by `Suggested fix (<safety>, <rule>):
// <description>`, so the person sees what to do as well as what is wrong — on
// `validate`, `build`, the validation step of `install`, and `run` when the runner
// refuses to run.

// ── Mocks ────────────────────────────────────────────────────────────

const spinner = { start: vi.fn(), stop: vi.fn(), error: vi.fn(), message: vi.fn() };

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  spinner: () => spinner,
  select: vi.fn(),
  log: {
    step: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../../src/cli/commands/index.js", () => ({ printLogo: vi.fn() }));

vi.mock("../../../src/runners/registry.js", () => ({ createRunner: vi.fn() }));

vi.mock("../../../src/installer/resolver/local.js", () => ({ resolveFromLocal: vi.fn() }));

vi.mock("../../../src/installer/telemetry/posthog.js", () => ({ shutdown: vi.fn() }));

import * as p from "@clack/prompts";
import { createRunner } from "../../../src/runners/registry.js";
import { resolveFromLocal } from "../../../src/installer/resolver/local.js";
import { validatePipe } from "../../../src/cli/commands/validate.js";
import { buildInputsPipe } from "../../../src/cli/commands/build.js";
import { installMethod } from "../../../src/cli/commands/install.js";
import { runPipe } from "../../../src/cli/commands/run.js";
import { ApiResponseError } from "../../../src/runners/api/exceptions.js";
import type { Problem, ProblemItem } from "../../../src/problems/types.js";
import type { ResolvedRepo } from "../../../src/package/manifest/types.js";
import type { Runner } from "../../../src/runners/types.js";

const FIX_DESCRIPTION =
  "Replace model 'gpt-5.1' of pipe 'summarize' with 'gpt-5', its one close match in the model deck";

const UNKNOWN_MODEL_ITEM: ProblemItem = {
  code: "model.unknown",
  detail: "Model handle 'gpt-5.1' was not found in the model deck.",
  location: { pipe: "summarize", field: "model", file: "demo.mthds" },
  suggested_fix: {
    fix_code: "rename-model",
    description: FIX_DESCRIPTION,
    safety: "unsafe",
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

const NO_FIX_ITEM: ProblemItem = {
  code: "method.pipe_unresolved",
  detail: "Pipe 'demo.main' refers to 'summarise', which no bundle declares.",
  params: { pipe_ref: "demo.summarise" },
  location: { pipe: "main" },
};

const FIX_LINE = `Suggested fix (unsafe, rename-model): ${FIX_DESCRIPTION}`;
const MODEL_LINE = `- model.unknown: ${UNKNOWN_MODEL_ITEM.detail} (pipe 'summarize', field 'model', file 'demo.mthds')`;

const INVALID = {
  is_valid: false as const,
  message: "MTHDS validation found errors",
  errors: [UNKNOWN_MODEL_ITEM, NO_FIX_ITEM],
};

const workDir = mkdtempSync(join(tmpdir(), "mthds-suggested-fix-"));
const bundlePath = join(workDir, "demo.mthds");
writeFileSync(bundlePath, 'domain = "demo"\nmain_pipe = "main"\n');

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  // Every command ends a refusal in process.exit(1); throw a sentinel so the test can catch it.
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("__exit__");
  }) as never);
});

function useRunner(runner: Record<string, unknown>): void {
  vi.mocked(createRunner).mockReturnValue(runner as unknown as Runner);
}

/** Every `p.log.error` message, in order. */
function errorLines(): string[] {
  return vi.mocked(p.log.error).mock.calls.map((call) => String(call[0]));
}

describe("mthds CLI prints a validation item's suggested fix", () => {
  it("validate prints the fix under the item that has one", async () => {
    useRunner({
      type: "api",
      methodTreeLimits: vi.fn().mockResolvedValue({}),
      validate: vi.fn().mockResolvedValue({
        ...INVALID,
        pending_signatures: [],
        is_runnable: false,
      }),
    });

    await expect(validatePipe(bundlePath, {})).rejects.toThrow("__exit__");

    expect(errorLines()).toContain("MTHDS validation found errors");
    expect(errorLines()).toContain(`${MODEL_LINE}\n  ${FIX_LINE}`);
    // An item the runner located in no file names the bundle the person passed.
    expect(errorLines()).toContain(
      `- method.pipe_unresolved: ${NO_FIX_ITEM.detail} (pipe 'main', file '${bundlePath}')`,
    );
  });

  it("build prints the fix under the item that has one", async () => {
    useRunner({
      type: "api",
      methodTreeLimits: vi.fn().mockResolvedValue({}),
      pipeIo: vi.fn().mockResolvedValue(INVALID),
    });

    await expect(buildInputsPipe(bundlePath, {})).rejects.toThrow("__exit__");

    expect(errorLines()).toContain(`${MODEL_LINE}\n  ${FIX_LINE}`);
    expect(errorLines()).toContain(`- method.pipe_unresolved: ${NO_FIX_ITEM.detail} (pipe 'main')`);
  });

  it("install's validation step prints the fix under the item that has one", async () => {
    vi.mocked(resolveFromLocal).mockResolvedValue({
      methods: [
        {
          name: "demo",
          manifest: {
            package: { address: "github.com/acme/demo", version: "1.0.0", description: "Demo" },
          },
          files: [{ path: "demo.mthds", bytes: new TextEncoder().encode('domain = "demo"\n') }],
        },
      ],
      skipped: [],
    } as unknown as ResolvedRepo);
    useRunner({
      type: "api",
      health: vi.fn().mockResolvedValue({}),
      version: vi.fn().mockResolvedValue(null),
      validate: vi.fn().mockResolvedValue({
        ...INVALID,
        pending_signatures: [],
        is_runnable: false,
      }),
    });

    await expect(installMethod({ dir: workDir })).rejects.toThrow("__exit__");

    expect(errorLines()).toContain("demo: MTHDS validation found errors");
    expect(errorLines()).toContain(`  ${MODEL_LINE}\n    ${FIX_LINE}`);
    expect(errorLines()).toContain(
      `  - method.pipe_unresolved: ${NO_FIX_ITEM.detail} (pipe 'main')`,
    );
  });
});

// A run route refuses an invalid method with a 422 problem document listing its items,
// which the API runner raises as an `ApiResponseError` carrying the problem whole.
function runRefusal(errors: ProblemItem[] | undefined): ApiResponseError {
  const problem: Problem = {
    type: "https://mthds.ai/errors/method.invalid",
    title: "The method does not validate",
    status: 422,
    detail: "The method is invalid and was not run.",
    code: "method.invalid",
    domain: "method",
    retry: "no",
    next_step: { kind: "change_method", detail: "Fix each fault the errors list." },
    ...(errors === undefined ? {} : { errors }),
  };
  return new ApiResponseError(problem, {
    apiUrl: "http://localhost:8081",
    route: "POST /v1/execute",
    status: 422,
    statusText: "Unprocessable Entity",
    responseBody: "{}",
  });
}

describe("mthds run prints a refused run's problem items", () => {
  it("prints each item with its location, and the fix under the item that has one", async () => {
    useRunner({
      type: "api",
      execute: vi.fn().mockRejectedValue(runRefusal([UNKNOWN_MODEL_ITEM, NO_FIX_ITEM])),
    });

    await expect(runPipe("demo.main", {})).rejects.toThrow("__exit__");

    // The spinner stops with its failure marker before the refusal prints, so the
    // two never share a line and no success marker sits above the refusal.
    expect(spinner.error).toHaveBeenCalledWith("Run failed.");
    expect(spinner.stop).not.toHaveBeenCalled();
    expect(errorLines()).toEqual([
      [
        "The method does not validate: The method is invalid and was not run.",
        "POST /v1/execute failed (422 Unprocessable Entity).",
        "Next step: Fix each fault the errors list.",
        "Code: method.invalid (domain method, retry no)",
        MODEL_LINE,
        `  ${FIX_LINE}`,
        `- method.pipe_unresolved: ${NO_FIX_ITEM.detail} (pipe 'main')`,
      ].join("\n"),
    ]);
  });

  it("prints a refusal with no items as the route that answered and the problem's members alone", async () => {
    useRunner({ type: "api", execute: vi.fn().mockRejectedValue(runRefusal(undefined)) });

    await expect(runPipe("demo.main", {})).rejects.toThrow("__exit__");

    expect(errorLines()).toEqual([
      [
        "The method does not validate: The method is invalid and was not run.",
        "POST /v1/execute failed (422 Unprocessable Entity).",
        "Next step: Fix each fault the errors list.",
        "Code: method.invalid (domain method, retry no)",
      ].join("\n"),
    ]);
  });
});
