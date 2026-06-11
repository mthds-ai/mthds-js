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

import { readFileSync, existsSync } from "node:fs";
import { PipelexRunner } from "../../../src/runners/pipelex/runner.js";

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);

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

      await runner.checkModel({
        reference: "gpt-4o",
        type: "llm",
        format: "markdown",
      });

      const args = execFileAsync.mock.calls[0]![1] as string[];
      expect(args[args.indexOf("--format") + 1]).toBe("json");
    });

    // Regression: pipelex-agent declares --type as a required typer option, so the
    // runner must reject calls without type early — otherwise pipelex-agent exits
    // non-zero with a cryptic 'Missing option --type' wrapped in execFileAsync's
    // truncated 'Command failed: ...' message.
    it("throws when type is omitted", async () => {
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runner.checkModel({ reference: "gpt-4o" } as any)
      ).rejects.toThrow(/requires `type`/i);
      expect(execFileAsync).not.toHaveBeenCalled();
    });
  });

  describe("models", () => {
    it("always passes --format json and forwards the single --type filter", async () => {
      execFileAsync.mockResolvedValue({
        stdout: '{"success":true,"presets":{}}',
        stderr: "",
      });

      await runner.models("llm");

      const args = execFileAsync.mock.calls[0]![1] as string[];
      expect(args).toContain("--format");
      expect(args[args.indexOf("--format") + 1]).toBe("json");
      expect(args[args.indexOf("--type") + 1]).toBe("llm");
    });

    it("maps the legacy pipelex-agent shape (presets / nested aliases) to a ModelDeck", async () => {
      execFileAsync.mockResolvedValue({
        stdout: JSON.stringify({
          success: true,
          presets: { llm: [{ name: "gpt-4o" }], img_gen: [{ name: "flux" }] },
          aliases: { llm: { best: "gpt-4o" } },
          waterfalls: { llm: { default: ["gpt-4o"] } },
        }),
        stderr: "",
      });

      const deck = await runner.models();

      expect(deck.models).toEqual([
        { name: "gpt-4o", type: "llm" },
        { name: "flux", type: "img_gen" },
      ]);
      expect(deck.aliases).toEqual({ best: "gpt-4o" });
      expect(deck.waterfalls).toEqual({ default: ["gpt-4o"] });
    });

    it("passes a protocol-shaped ModelDeck through verbatim", async () => {
      execFileAsync.mockResolvedValue({
        stdout: JSON.stringify({
          models: [{ name: "gpt-4o", type: "llm" }],
          aliases: { best: "gpt-4o" },
          waterfalls: {},
        }),
        stderr: "",
      });

      const deck = await runner.models();
      expect(deck.models).toEqual([{ name: "gpt-4o", type: "llm" }]);
      expect(deck.aliases).toEqual({ best: "gpt-4o" });
    });
  });

  describe("validate", () => {
    it("runs `pipelex validate bundle` on the written contents and returns an empty report", async () => {
      execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

      const report = await runner.validate(["domain = 'x'"]);

      expect(report).toEqual({});
      const args = execFileAsync.mock.calls[0]![1] as string[];
      expect(args[0]).toBe("validate");
      expect(args[1]).toBe("bundle");
      expect(args).not.toContain("--allow-signatures");
    });

    it("passes --allow-signatures when requested", async () => {
      execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

      await runner.validate(["domain = 'x'"], true);

      const args = execFileAsync.mock.calls[0]![1] as string[];
      expect(args).toContain("--allow-signatures");
    });

    it("throws with the pipelex stderr when validation fails", async () => {
      const failure = Object.assign(new Error("Command failed"), {
        stderr: "Pipe 'broken' references unknown concept",
        stdout: "",
      });
      execFileAsync.mockRejectedValue(failure);

      await expect(runner.validate(["broken"])).rejects.toThrow(/unknown concept/);
    });
  });

  describe("version", () => {
    it("wraps the local pipelex version in a VersionInfo handshake", async () => {
      execFileAsync.mockResolvedValue({ stdout: "0.32.0\n", stderr: "" });

      const info = await runner.version();

      expect(info.implementation).toBe("pipelex");
      expect(info.implementation_version).toBe("0.32.0");
      expect(info.runtime_version).toBe("0.32.0");
      expect(info.protocol_version).toBeTruthy();
    });
  });

  describe("concept", () => {
    // Regression: pipelex's ConceptSpec.validate_concept_code normalizes (ASCII fold +
    // snake→PascalCase) before emitting TOML. The wrapper's concept_code must reflect
    // the normalized value from the TOML section header, not the caller's raw input.
    it("returns concept_code parsed from the TOML section header, not the request spec", async () => {
      const toml = '[concept.MyInvoice]\ndescription = "A commercial invoice"\n';
      execFileAsync.mockResolvedValue({ stdout: toml, stderr: "" });

      const result = await runner.concept({
        spec: { concept_code: "my_invoice", description: "A commercial invoice" },
      });

      expect(result).toEqual({
        success: true,
        concept_code: "MyInvoice",
        toml,
      });
    });

    it("falls back to the request spec's concept_code if the TOML header can't be parsed", async () => {
      const malformed = "no section header here";
      execFileAsync.mockResolvedValue({ stdout: malformed, stderr: "" });

      const result = await runner.concept({
        spec: { concept_code: "Fallback", description: "x" },
      });

      expect(result.concept_code).toBe("Fallback");
    });
  });

  describe("pipeSpec", () => {
    // Regression: pipelex's validate_pipe_code_syntax strips `domain.` prefix and
    // ASCII-folds before emitting TOML. The wrapper's pipe_code must reflect the
    // normalized value from the TOML section header, not the caller's raw input.
    it("returns pipe_code parsed from the TOML section header, not the request spec", async () => {
      const toml = '[pipe.summarize_doc]\ntype = "PipeLLM"\ndescription = "Summarize."\n';
      execFileAsync.mockResolvedValue({ stdout: toml, stderr: "" });

      const result = await runner.pipeSpec({
        pipe_type: "PipeLLM",
        spec: { pipe_code: "myapp.summarize_doc", description: "Summarize." },
      });

      expect(result).toEqual({
        success: true,
        pipe_code: "summarize_doc",
        pipe_type: "PipeLLM",
        toml,
      });
    });

    it("falls back to the request spec's pipe_code if the TOML header can't be parsed", async () => {
      const malformed = "no section header here";
      execFileAsync.mockResolvedValue({ stdout: malformed, stderr: "" });

      const result = await runner.pipeSpec({
        pipe_type: "PipeLLM",
        spec: { pipe_code: "fallback_code", description: "x" },
      });

      expect(result.pipe_code).toBe("fallback_code");
    });
  });

  describe("buildOutput", () => {
    it("passes -o to a temp file and reads it back", async () => {
      const outputJson =
        '{"concept":"native.Text","content":{"type":"object"}}';
      execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
      mockedExistsSync.mockReturnValue(true);
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

    // Regression: when the caller omits `format`, the runner must pass an explicit
    // `--format json` to pipelex so the JSON.parse() branch below does not rely on
    // pipelex's CLI default (which is outside our contract).
    it("passes --format json when caller omits format", async () => {
      execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue("{}");

      await runner.buildOutput({
        mthds_contents: ["bundle content"],
        pipe_code: "test_pipe",
      });

      const args = execFileAsync.mock.calls[0]![1] as string[];
      expect(args).toContain("--format");
      expect(args[args.indexOf("--format") + 1]).toBe("json");
    });

    // Regression: pipelex build output --format python writes Python source code,
    // not JSON. Parsing it would crash. Schema/json formats remain JSON-parsed.
    it("returns raw string for --format python", async () => {
      const pythonCode =
        "from pydantic import BaseModel\n\nclass Out(BaseModel):\n    text: str\n";
      execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(pythonCode);

      const result = await runner.buildOutput({
        mthds_contents: ["bundle content"],
        pipe_code: "test_pipe",
        format: "python",
      });

      expect(result).toBe(pythonCode);
    });

    it("JSON-parses --format schema output", async () => {
      const schemaJson =
        '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}';
      execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
      mockedExistsSync.mockReturnValue(true);
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

    // Regression: pipelex can exit 0 without writing the file (e.g. render_output
    // raises ValueError and the CLI does `typer.Exit(0)` after printing the message
    // to stderr). The runner must surface that stderr instead of an opaque ENOENT.
    it("surfaces pipelex stderr when no output file was written", async () => {
      execFileAsync.mockResolvedValue({
        stdout: "",
        stderr: "Output is 'native.Anything' which has no specific shape",
      });
      mockedExistsSync.mockReturnValue(false);

      await expect(
        runner.buildOutput({
          mthds_contents: ["bundle content"],
          pipe_code: "test_pipe",
        })
      ).rejects.toThrow(/native\.Anything/);
      expect(mockedReadFileSync).not.toHaveBeenCalled();
    });
  });
});
