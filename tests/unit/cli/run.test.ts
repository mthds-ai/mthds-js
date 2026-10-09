import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `mthds run pipe` and `run bundle` build their own `pipelex run` command, so the
// pipelex flags they declare must reach it, and a runner that cannot honour them must
// refuse them before anything starts: a dropped `--dry-run` is a real, paid run.

// ── Mocks ────────────────────────────────────────────────────────────

const spinner = { start: vi.fn(), stop: vi.fn(), error: vi.fn(), message: vi.fn() };

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  spinner: () => spinner,
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

import * as p from "@clack/prompts";
import { createRunner } from "../../../src/runners/registry.js";
import { runBundle, runPipe } from "../../../src/cli/commands/run.js";
import type { Runner } from "../../../src/runners/types.js";

const tmp = mkdtempSync(join(tmpdir(), "mthds-run-test-"));
const BUNDLE_PATH = join(tmp, "hello.mthds");
writeFileSync(BUNDLE_PATH, 'domain = "demo"\nmain_pipe = "hello"\n', "utf-8");

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

class ExitCalled extends Error {}

const execute = vi.fn();

function useRunner(type: "pipelex" | "api"): void {
  vi.mocked(createRunner).mockReturnValue({ type, execute } as unknown as Runner);
}

function errorMessages(): string[] {
  return vi.mocked(p.log.error).mock.calls.map((call) => String(call[0]));
}

const COMMANDS = [
  ["run pipe", runPipe],
  ["run bundle", runBundle],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  execute.mockResolvedValue({ pipeline_run_id: "", pipe_output: null });
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new ExitCalled();
  });
});

describe.each(COMMANDS)("mthds %s", (_name, command) => {
  it("hands --dry-run, --mock-inputs and --local to the pipelex runner", async () => {
    useRunner("pipelex");
    await command(BUNDLE_PATH, { dryRun: true, mockInputs: true, local: true });

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]![1]).toEqual({ dryRun: true, mockInputs: true, hosted: false });
  });

  it("hands --hosted to the pipelex runner", async () => {
    useRunner("pipelex");
    await command(BUNDLE_PATH, { hosted: true });

    expect(execute.mock.calls[0]![1]).toMatchObject({ hosted: true });
  });

  it("refuses --dry-run on the API runner and starts nothing", async () => {
    useRunner("api");
    await expect(command(BUNDLE_PATH, { dryRun: true, mockInputs: true })).rejects.toThrow(
      ExitCalled,
    );

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(execute).not.toHaveBeenCalled();
    const [message] = errorMessages();
    expect(message).toContain("--dry-run, --mock-inputs apply only to the pipelex runner");
    expect(message).toContain("nothing was started");
    expect(message).toContain("mthds validate bundle");
  });

  it("refuses --local on the API runner without speaking of a dry run", async () => {
    useRunner("api");
    await expect(command(BUNDLE_PATH, { local: true })).rejects.toThrow(ExitCalled);

    expect(execute).not.toHaveBeenCalled();
    const [message] = errorMessages();
    expect(message).toContain("--local applies only to the pipelex runner");
    expect(message).not.toContain("dry run");
  });

  it("runs on the API runner when no pipelex flag is given", async () => {
    useRunner("api");
    await command(BUNDLE_PATH, {});

    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]).toHaveLength(1);
  });
});
