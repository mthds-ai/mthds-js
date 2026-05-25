import { describe, it, expect, vi, beforeEach } from "vitest";

const { execFileAsync } = vi.hoisted(() => ({
  execFileAsync: vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" }),
}));

vi.mock("node:child_process", () => {
  const execFileMock: Record<string | symbol, unknown> = vi.fn();
  execFileMock[Symbol.for("nodejs.util.promisify.custom")] = execFileAsync;
  return { execFile: execFileMock, spawn: vi.fn() };
});

vi.mock("node:fs", () => ({
  mkdtempSync: vi.fn(() => "/tmp/mthds-test"),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => "{}"),
  rmSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  tmpdir: vi.fn(() => "/tmp"),
}));

import { readFileSync } from "node:fs";
import { PipelexRunner } from "../../../src/runners/pipelex-runner.js";

const mockedReadFileSync = vi.mocked(readFileSync);

describe("PipelexRunner", () => {
  let runner: PipelexRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    runner = new PipelexRunner();
  });

  describe("checkModel", () => {
    it("passes --format json when caller omits format", async () => {
      execFileAsync.mockResolvedValue({
        stdout: '{"success":true,"valid":true}',
        stderr: "",
      });

      await runner.checkModel({ reference: "gpt-4o", type: "llm" });

      const args = execFileAsync.mock.calls[0]![1] as string[];
      expect(args).toContain("--format");
      expect(args[args.indexOf("--format") + 1]).toBe("json");
    });

    // Regression: pipelex-agent's --format markdown writes plain text via print(),
    // which can't satisfy CheckModelResponse. The runner must force JSON regardless
    // of what the caller asks for.
    it("forces --format json even when caller passes markdown", async () => {
      execFileAsync.mockResolvedValue({
        stdout: '{"success":true,"valid":true}',
        stderr: "",
      });

      await runner.checkModel({ reference: "gpt-4o", format: "markdown" });

      const args = execFileAsync.mock.calls[0]![1] as string[];
      expect(args[args.indexOf("--format") + 1]).toBe("json");
    });
  });

  describe("models", () => {
    it("always passes --format json", async () => {
      execFileAsync.mockResolvedValue({
        stdout: '{"success":true,"presets":{}}',
        stderr: "",
      });

      await runner.models({ type: ["llm"] });

      const args = execFileAsync.mock.calls[0]![1] as string[];
      expect(args).toContain("--format");
      expect(args[args.indexOf("--format") + 1]).toBe("json");
    });
  });

  describe("concept", () => {
    it("returns synthesized wrapper from raw TOML stdout", async () => {
      const toml = '[concept.Invoice]\ndescription = "A commercial invoice"';
      execFileAsync.mockResolvedValue({ stdout: toml, stderr: "" });

      const result = await runner.concept({
        spec: { concept_code: "Invoice", description: "A commercial invoice" },
      });

      expect(result).toEqual({
        success: true,
        concept_code: "Invoice",
        toml,
      });
    });
  });

  describe("pipeSpec", () => {
    it("returns synthesized wrapper from raw TOML stdout", async () => {
      const toml = '[pipe.say_hi]\ntype = "PipeLLM"\ndescription = "Say hi."';
      execFileAsync.mockResolvedValue({ stdout: toml, stderr: "" });

      const result = await runner.pipeSpec({
        pipe_type: "PipeLLM",
        spec: { pipe_code: "say_hi", description: "Say hi." },
      });

      expect(result).toEqual({
        success: true,
        pipe_code: "say_hi",
        pipe_type: "PipeLLM",
        toml,
      });
    });
  });

  describe("buildOutput", () => {
    it("passes -o to a temp file and reads it back", async () => {
      const outputJson =
        '{"concept":"native.Text","content":{"type":"object"}}';
      execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
      mockedReadFileSync.mockReturnValue(outputJson);

      const result = await runner.buildOutput({
        mthds_contents: ["bundle content"],
        pipe_code: "test_pipe",
      });

      const args = execFileAsync.mock.calls[0]![1] as string[];
      const oIndex = args.indexOf("-o");
      expect(oIndex).toBeGreaterThan(-1);
      expect(args[oIndex + 1]).toMatch(/output\.json$/);

      expect(result).toEqual({
        concept: "native.Text",
        content: { type: "object" },
      });
    });

    // Regression: pipelex build output --format python writes Python source code,
    // not JSON. Parsing it would crash. Schema/json formats remain JSON-parsed.
    it("returns raw string for --format python", async () => {
      const pythonCode = "from pydantic import BaseModel\n\nclass Out(BaseModel):\n    text: str\n";
      execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
      mockedReadFileSync.mockReturnValue(pythonCode);

      const result = await runner.buildOutput({
        mthds_contents: ["bundle content"],
        pipe_code: "test_pipe",
        format: "python",
      });

      expect(result).toBe(pythonCode);
    });

    it("JSON-parses --format schema output", async () => {
      const schemaJson = '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}';
      execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
      mockedReadFileSync.mockReturnValue(schemaJson);

      const result = await runner.buildOutput({
        mthds_contents: ["bundle content"],
        pipe_code: "test_pipe",
        format: "schema",
      });

      expect(result).toEqual({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
      });
    });
  });
});
