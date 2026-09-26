import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// When the runner refuses a bundle, the `mthds` CLI prints each validation item, and
// an item that carries a suggested fix is followed by `Suggested fix: <description>`,
// so the person sees what to do as well as what is wrong — on `validate`, `build`
// and the validation step of `install`.

// ── Mocks ────────────────────────────────────────────────────────────

const spinner = { start: vi.fn(), stop: vi.fn(), message: vi.fn() };

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
import type { ValidationErrorItem } from "../../../src/runners/api/models.js";
import type { ResolvedRepo } from "../../../src/package/manifest/types.js";
import type { Runner } from "../../../src/runners/types.js";

const FIX_DESCRIPTION =
  "Replace model 'gpt-5.1' of pipe 'summarize' with 'gpt-5', its one close match in the model deck";

const UNKNOWN_MODEL_ITEM: ValidationErrorItem = {
  category: "pipe_validation",
  error_type: "unknown_model",
  message: "Model handle 'gpt-5.1' was not found in the model deck.",
  pipe_code: "summarize",
  source: "demo.mthds",
  field_name: "model",
  suggested_fix: {
    fix_code: "rename-model",
    description: FIX_DESCRIPTION,
    safety: "safe",
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

const NO_FIX_ITEM: ValidationErrorItem = {
  category: "pipe_validation",
  message: "Pipe 'demo.main' refers to 'summarise', which no bundle declares.",
  pipe_code: "main",
  source: "demo.mthds",
  missing_pipe_code: "summarise",
};

const INVALID = {
  is_valid: false as const,
  message: "MTHDS validation found errors",
  validation_errors: [UNKNOWN_MODEL_ITEM, NO_FIX_ITEM],
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
      validate: vi.fn().mockResolvedValue({
        ...INVALID,
        pending_signatures: [],
        is_runnable: false,
      }),
    });

    await expect(validatePipe(bundlePath, {})).rejects.toThrow("__exit__");

    expect(errorLines()).toContain(
      `demo.mthds: [pipe_validation] ${UNKNOWN_MODEL_ITEM.message}\n  Suggested fix: ${FIX_DESCRIPTION}`,
    );
    expect(errorLines()).toContain(`demo.mthds: [pipe_validation] ${NO_FIX_ITEM.message}`);
  });

  it("build prints the fix under the item that has one", async () => {
    useRunner({ type: "api", buildInputs: vi.fn().mockResolvedValue(INVALID) });

    await expect(buildInputsPipe(bundlePath, {})).rejects.toThrow("__exit__");

    expect(errorLines()).toContain(
      `demo.mthds · summarize: ${UNKNOWN_MODEL_ITEM.message}\n  Suggested fix: ${FIX_DESCRIPTION}`,
    );
    expect(errorLines()).toContain(`demo.mthds · main: ${NO_FIX_ITEM.message}`);
  });

  it("install's validation step prints the fix under the item that has one", async () => {
    vi.mocked(resolveFromLocal).mockReturnValue({
      methods: [
        {
          name: "demo",
          manifest: {
            package: { address: "github.com/acme/demo", version: "1.0.0", description: "Demo" },
          },
          files: [{ relativePath: "demo.mthds", content: 'domain = "demo"\n' }],
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

    expect(errorLines()).toContain(
      `  [pipe_validation] ${UNKNOWN_MODEL_ITEM.message}\n    Suggested fix: ${FIX_DESCRIPTION}`,
    );
    expect(errorLines()).toContain(`  [pipe_validation] ${NO_FIX_ITEM.message}`);
  });
});
