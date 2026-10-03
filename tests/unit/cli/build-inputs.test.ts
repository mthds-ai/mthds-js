import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `mthds build inputs pipe` on the API runner reads the pipe's input form from
// `POST /v1/pipe-io` and projects the template locally, as `mthds-agent inputs`
// does. These tests pin the request it sends, the rendering on both axes against the
// shared projection corpus, and the answer that contradicts itself.

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
import { buildInputsPipe } from "../../../src/cli/commands/build.js";
import type { InputForm } from "../../../src/protocol/input_form.js";
import type { PipeIOValidReport, Runner } from "../../../src/runners/types.js";

const CORPUS_URL = new URL("../../fixtures/protocol/", import.meta.url);
const INPUT_FORM = JSON.parse(
  readFileSync(new URL("input_form.json", CORPUS_URL), "utf-8"),
) as InputForm;
const PIPE_REF = "input_semantics_probe.probe_markers";

function corpusTemplate(shape: "compact" | "explicit", format: "json" | "toml"): string {
  return readFileSync(
    new URL(`inputs_template/${PIPE_REF}.${shape}.${format}`, CORPUS_URL),
    "utf-8",
  );
}

function validReport(overrides: Partial<PipeIOValidReport> = {}): PipeIOValidReport {
  return {
    is_valid: true,
    pipe_ref: PIPE_REF,
    pipe_io_contracts: {},
    input_form: { [PIPE_REF]: INPUT_FORM[PIPE_REF]! },
    output_form: {},
    default_pipe_ref: PIPE_REF,
    pending_signatures: [],
    is_runnable: true,
    ...overrides,
  };
}

const workDir = mkdtempSync(join(tmpdir(), "mthds-build-inputs-"));
const bundlePath = join(workDir, "probe.mthds");
const BUNDLE = 'domain = "input_semantics_probe"\n';
writeFileSync(bundlePath, BUNDLE);

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("__exit__");
  }) as never);
});

function useApiRunner(pipeIo: ReturnType<typeof vi.fn>): void {
  vi.mocked(createRunner).mockReturnValue({ type: "api", pipeIo } as unknown as Runner);
}

function infoLines(): string[] {
  return vi.mocked(p.log.info).mock.calls.map((call) => String(call[0]));
}

function errorLines(): string[] {
  return vi.mocked(p.log.error).mock.calls.map((call) => String(call[0]));
}

describe("mthds build inputs pipe on the API runner", () => {
  it("sends the bundle and the pipe ref to pipeIo, labelled with its path", async () => {
    const pipeIo = vi.fn().mockResolvedValue(validReport());
    useApiRunner(pipeIo);

    await buildInputsPipe(bundlePath, { pipe: PIPE_REF });

    expect(pipeIo).toHaveBeenCalledWith({
      files: [{ content: BUNDLE, source: bundlePath }],
      pipe_ref: PIPE_REF,
    });
  });

  it("sends the -L directory's files after the bundle and asks for the bundle's main pipe", async () => {
    const libraryDir = join(workDir, "library");
    mkdirSync(libraryDir, { recursive: true });
    const sibling = 'domain = "other"\nmain_pipe = "elsewhere"\n';
    writeFileSync(join(libraryDir, "other.mthds"), sibling);
    const entry = join(workDir, "entry.mthds");
    const entryBundle = 'domain = "input_semantics_probe"\nmain_pipe = "probe_markers"\n';
    writeFileSync(entry, entryBundle);
    const pipeIo = vi.fn().mockResolvedValue(validReport());
    useApiRunner(pipeIo);

    await buildInputsPipe(entry, { libraryDir: [libraryDir] });

    // Both files declare a main_pipe, so the runner's chain alone could not choose.
    expect(pipeIo).toHaveBeenCalledWith({
      files: [
        { content: entryBundle, source: entry },
        { content: sibling, source: join(libraryDir, "other.mthds") },
      ],
      pipe_ref: PIPE_REF,
    });
  });

  it.each([
    ["compact", "json", false],
    ["explicit", "json", true],
    ["compact", "toml", false],
    ["explicit", "toml", true],
  ] as const)(
    "prints the %s %s template byte-identical to the corpus",
    async (shape, format, explicit) => {
      useApiRunner(vi.fn().mockResolvedValue(validReport()));

      await buildInputsPipe(bundlePath, { format, explicit });

      expect(infoLines()).toEqual([corpusTemplate(shape, format)]);
      expect(spinner.stop).toHaveBeenCalledWith(`Inputs generated for ${PIPE_REF}.`);
    },
  );

  it("prints a comment for a pipe declaring no inputs", async () => {
    useApiRunner(
      vi.fn().mockResolvedValue(validReport({ input_form: { [PIPE_REF]: { fields: [] } } })),
    );

    await buildInputsPipe(bundlePath, { format: "toml" });

    expect(infoLines()).toEqual([`# Pipe '${PIPE_REF}' declares no inputs.`]);
  });

  it("fails on an answer whose input_form does not describe the selected pipe", async () => {
    useApiRunner(
      vi.fn().mockResolvedValue(validReport({ input_form: { "other.pipe": { fields: [] } } })),
    );

    await expect(buildInputsPipe(bundlePath, {})).rejects.toThrow("__exit__");

    expect(errorLines().join("\n")).toContain("does not describe it (it describes: other.pipe)");
  });

  it("refuses a format it does not render before calling the runner", async () => {
    const pipeIo = vi.fn();
    useApiRunner(pipeIo);

    await expect(buildInputsPipe(bundlePath, { format: "yaml" })).rejects.toThrow("__exit__");

    expect(pipeIo).not.toHaveBeenCalled();
    expect(errorLines()[0]).toContain('Invalid format "yaml"');
  });
});
