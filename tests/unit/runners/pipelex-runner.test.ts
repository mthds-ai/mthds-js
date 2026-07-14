import { describe, it, expect, vi, beforeEach } from "vitest";

const { execFileAsync } = vi.hoisted(() => ({
  execFileAsync: vi.fn().mockResolvedValue({ stdout: "{}", stderr: "" }),
}));

vi.mock("node:child_process", () => {
  const execFileMock = vi.fn() as ReturnType<typeof vi.fn> & Record<string | symbol, unknown>;
  execFileMock[Symbol.for("nodejs.util.promisify.custom")] = execFileAsync;
  return { execFile: execFileMock, spawn: vi.fn() };
});

vi.mock("node:fs", () => ({
  mkdtempSync: vi.fn(() => "/tmp/mthds-test"),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => "{}"),
  readdirSync: vi.fn(() => []),
  rmSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
}));

vi.mock("node:os", () => ({
  tmpdir: vi.fn(() => "/tmp"),
}));

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { PipelexRunner } from "../../../src/runners/pipelex/runner.js";

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedSpawn = vi.mocked(spawn);

/** A minimal closure that declares both a domain and a main_pipe, so the selector can default. */
const BUNDLE = 'domain = "smoke"\nmain_pipe = "echo"\n';

/** Make `spawn` return a fake child that closes with the given exit code. */
function mockSpawnExit(code: number): void {
  mockedSpawn.mockReturnValue({
    on(event: string, cb: (arg: number) => void) {
      if (event === "close") cb(code);
      return this;
    },
  } as unknown as ReturnType<typeof spawn>);
}

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
      await expect(runner.checkModel({ reference: "gpt-4o" } as any)).rejects.toThrow(
        /requires `type`/i,
      );
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
    it("runs `pipelex validate bundle` on the written contents and returns the minimal valid arm", async () => {
      execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

      const report = await runner.validate(["domain = 'x'"]);

      expect(report).toEqual({ is_valid: true });
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

  // The `files[]` envelope + the qualified `pipe_ref` selector the `/v1/build/*`
  // routes share. The local runner cannot let the engine resolve the ref for it
  // (it never loads a library), so it resolves one itself and passes it to `--pipe`
  // explicitly — which is what lets it echo back a ref it can stand behind.
  describe("build selector", () => {
    beforeEach(() => {
      execFileAsync.mockResolvedValue({ stdout: '{"inputs":{}}', stderr: "" });
    });

    it("defaults an omitted pipe_ref to the closure's main_pipe, qualified by its domain", async () => {
      const result = await runner.buildInputs({ files: [{ content: BUNDLE }] });

      const args = execFileAsync.mock.calls[0]![1] as string[];
      expect(args[args.indexOf("--pipe") + 1]).toBe("smoke.echo");
      // The RESOLVED ref is echoed; `requested_pipe_ref` is absent because the
      // caller never submitted one.
      expect(result).toMatchObject({ is_valid: true, pipe_ref: "smoke.echo" });
      expect(result).not.toHaveProperty("requested_pipe_ref");
    });

    it("qualifies a bare pipe_ref against the closure's single domain and echoes what was asked", async () => {
      const result = await runner.buildInputs({
        files: [{ content: BUNDLE }],
        pipe_ref: "other",
      });

      const args = execFileAsync.mock.calls[0]![1] as string[];
      expect(args[args.indexOf("--pipe") + 1]).toBe("smoke.other");
      expect(result).toMatchObject({ pipe_ref: "smoke.other", requested_pipe_ref: "other" });
    });

    it("rejects a bare pipe_ref that is ambiguous across domains", async () => {
      await expect(
        runner.buildInputs({
          files: [{ content: BUNDLE }, { content: 'domain = "other"\n' }],
          pipe_ref: "echo",
        }),
      ).rejects.toThrow(/ambiguous/);
    });

    it("rejects an omitted pipe_ref when the closure declares no main_pipe", async () => {
      await expect(
        runner.buildInputs({ files: [{ content: 'domain = "smoke"\n' }] }),
      ).rejects.toThrow(/declares no main_pipe/);
    });

    // Mirrors the engine's own default-resolution: several main_pipes across the
    // closure is an AMBIGUOUS closure, not a pick-the-first situation.
    it("rejects an omitted pipe_ref when the closure declares several main_pipes", async () => {
      await expect(
        runner.buildInputs({
          files: [{ content: BUNDLE }, { content: 'domain = "other"\nmain_pipe = "run"\n' }],
        }),
      ).rejects.toThrow(/several main_pipe/);
    });

    // `source` is what makes an invalid verdict point at a file. Locally it has a
    // second job: it names the file on disk, so the CLI's own diagnostics match.
    it("writes each file under its `source` label", async () => {
      await runner.buildInputs({
        files: [
          { content: BUNDLE, source: "smoke.mthds" },
          { content: 'domain = "shared"\n', source: "lib/shared.mthds" },
        ],
        pipe_ref: "smoke.echo",
      });

      const written = mockedWriteFileSync.mock.calls.map((call) => call[0]);
      expect(written).toEqual(["/tmp/mthds-test/smoke.mthds", "/tmp/mthds-test/shared.mthds"]);
    });

    // A `source` that is not a plain `.mthds` basename must never steer the write
    // out of the temp dir.
    it("falls back to a positional name for a source that is not a safe basename", async () => {
      await runner.buildInputs({
        files: [{ content: BUNDLE, source: "https://example.com/x" }],
        pipe_ref: "smoke.echo",
      });

      expect(mockedWriteFileSync.mock.calls[0]![0]).toBe("/tmp/mthds-test/bundle.mthds");
    });

    it("refuses method_ref, which only the API can serve (and only once the registry lands)", async () => {
      await expect(runner.buildInputs({ method_ref: "acme/summarize" })).rejects.toThrow(
        /method_ref is not supported/,
      );
    });
  });

  describe("buildInputs", () => {
    it("unwraps the agent CLI's envelope so `inputs` is the bare template, as on the API", async () => {
      execFileAsync.mockResolvedValue({
        stdout: '{"success":true,"pipe_code":"echo","inputs":{"text":"text_value"}}',
        stderr: "",
      });

      const result = await runner.buildInputs({ files: [{ content: BUNDLE }] });

      expect(result).toMatchObject({ format: "json", inputs: { text: "text_value" } });
      expect(result).not.toHaveProperty("inputs_toml");
    });

    // The format decides WHICH field carries the template. TOML rides raw text —
    // parsing it into a dict would destroy the concept comments that are the only
    // reason to ask for TOML.
    it("returns raw text in inputs_toml for --format toml", async () => {
      const toml = '# concept: native.Text\ntext = "text_value"\n';
      execFileAsync.mockResolvedValue({ stdout: toml, stderr: "" });

      const result = await runner.buildInputs({
        files: [{ content: BUNDLE }],
        format: "toml",
      });

      const args = execFileAsync.mock.calls[0]![1] as string[];
      expect(args[args.indexOf("--format") + 1]).toBe("toml");
      expect(result).toMatchObject({ format: "toml", inputs_toml: toml });
      expect(result).not.toHaveProperty("inputs");
    });

    it("passes --explicit only when asked", async () => {
      execFileAsync.mockResolvedValue({ stdout: '{"inputs":{}}', stderr: "" });

      await runner.buildInputs({ files: [{ content: BUNDLE }] });
      expect(execFileAsync.mock.calls[0]![1] as string[]).not.toContain("--explicit");

      await runner.buildInputs({ files: [{ content: BUNDLE }], explicit: true });
      expect(execFileAsync.mock.calls[1]![1] as string[]).toContain("--explicit");
    });

    // pipelex-agent's JSON envelope always carries `inputs` — `{}` for an input-less
    // pipe. An envelope WITHOUT the key means the CLI contract changed under us; that
    // must surface as a loud no-verdict, not an `is_valid: true` with a hollowed-out
    // template that would strip every required field from generated input forms.
    it("throws when the agent envelope carries no `inputs` key", async () => {
      execFileAsync.mockResolvedValue({
        stdout: '{"success":true,"pipe_code":"echo"}',
        stderr: "",
      });

      await expect(runner.buildInputs({ files: [{ content: BUNDLE }] })).rejects.toThrow(
        /no `inputs` field/,
      );
    });

    it("keeps an empty template valid — an input-less pipe is not a contract break", async () => {
      execFileAsync.mockResolvedValue({ stdout: '{"inputs":{}}', stderr: "" });

      const result = await runner.buildInputs({ files: [{ content: BUNDLE }] });

      expect(result).toMatchObject({ is_valid: true, inputs: {} });
    });
  });

  describe("buildOutput", () => {
    it("passes -o to a temp file and reads it back", async () => {
      const outputJson = '{"concept":"native.Text","content":{"type":"object"}}';
      execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(outputJson);

      const result = await runner.buildOutput({
        files: [{ content: BUNDLE }],
        pipe_ref: "smoke.echo",
      });

      const args = execFileAsync.mock.calls[0]![1] as string[];
      const oIndex = args.indexOf("-o");
      expect(oIndex).toBeGreaterThan(-1);
      expect(args[oIndex + 1]).toMatch(/output\.json$/);

      expect(result).toMatchObject({
        is_valid: true,
        pipe_ref: "smoke.echo",
        output: { concept: "native.Text", content: { type: "object" } },
      });
    });

    // The runner must pass an explicit `--format` so the parsing branch below does
    // not rely on pipelex's CLI default (which is outside our contract). The default
    // it passes is `schema` — the same default the API's `/v1/build/output` applies,
    // so the two runners behind one `Runner` interface cannot mean different things.
    it("passes --format schema when the caller omits format", async () => {
      execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue("{}");

      const result = await runner.buildOutput({ files: [{ content: BUNDLE }] });

      const args = execFileAsync.mock.calls[0]![1] as string[];
      expect(args[args.indexOf("--format") + 1]).toBe("schema");
      expect(result).toMatchObject({ format: "schema" });
    });

    // Regression: pipelex build output --format python writes Python source code,
    // not JSON. Parsing it would crash — which is exactly the 500 the API's own
    // `/build/output` used to return before the two-field split.
    it("returns source text in output_python for --format python", async () => {
      const pythonCode = "from pydantic import BaseModel\n\nclass Out(BaseModel):\n    text: str\n";
      execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(pythonCode);

      const result = await runner.buildOutput({
        files: [{ content: BUNDLE }],
        format: "python",
      });

      expect(result).toMatchObject({ format: "python", output_python: pythonCode });
      expect(result).not.toHaveProperty("output");
    });

    it("JSON-parses --format schema output into `output`", async () => {
      const schemaJson = '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object"}';
      execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(schemaJson);

      const result = await runner.buildOutput({
        files: [{ content: BUNDLE }],
        format: "schema",
      });

      expect(result).toMatchObject({
        output: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
      });
      expect(result).not.toHaveProperty("output_python");
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

      await expect(runner.buildOutput({ files: [{ content: BUNDLE }] })).rejects.toThrow(
        /native\.Anything/,
      );
      expect(mockedReadFileSync).not.toHaveBeenCalled();
    });
  });

  describe("buildRunner", () => {
    // A closure that resolves to no crate yields no structures projection (no
    // `structures/codegen.lock`). That is not a failure: the runner.py we just
    // generated is valid on its own, so a missing sidecar must not discard it.
    it("returns the runner script even when the CLI emitted no structures projection", async () => {
      mockSpawnExit(0);
      mockedExistsSync.mockReturnValue(false); // no structures/codegen.lock beside it
      mockedReadFileSync.mockReturnValue("# runner.py\n");

      const result = await runner.buildRunner({ files: [{ content: BUNDLE }] });

      expect(result.is_valid).toBe(true);
      if (!result.is_valid) throw new Error("unreachable");
      expect(result.python_code).toBe("# runner.py\n");
      expect(result.structures).toBeUndefined();
    });

    // pipelex's lock layer validates artifact paths as (possibly multi-part) RELATIVE
    // paths, so a projection may nest files in subdirectories. The collector must walk
    // them and report each artifact under its relative path — not EISDIR on the
    // directory entry, and not silently halve the locked artifact set by skipping it.
    it("collects nested structure artifacts under their relative paths", async () => {
      mockSpawnExit(0);
      mockedExistsSync.mockReturnValue(true); // structures/codegen.lock present
      const dirent = (name: string, kind: "file" | "dir") =>
        ({ name, isFile: () => kind === "file", isDirectory: () => kind === "dir" }) as never;
      mockedReaddirSync.mockImplementation((path) =>
        String(path).endsWith("/structures")
          ? ([
              dirent("codegen.lock", "file"),
              dirent("structures.py", "file"),
              dirent("pkg", "dir"),
            ] as never)
          : ([dirent("mod.py", "file")] as never),
      );
      mockedReadFileSync.mockImplementation((path) => {
        const p = String(path);
        if (p.endsWith("runner.py")) return "# runner.py\n";
        if (p.endsWith("codegen.lock")) return "lock-content";
        return `content of ${p.split("/").pop()}`;
      });

      const result = await runner.buildRunner({ files: [{ content: BUNDLE }] });

      expect(result.is_valid).toBe(true);
      if (!result.is_valid) throw new Error("unreachable");
      expect(result.structures).toMatchObject({
        directory: "structures",
        lock: "lock-content",
        artifacts: [
          { path: "pkg/mod.py", content: "content of mod.py" },
          { path: "structures.py", content: "content of structures.py" },
        ],
      });
    });

    // `pipelex build runner` has no --allow-signatures flag, so there is nothing to
    // forward. Dropping it silently would make one request mean two things.
    it("rejects allow_signatures rather than silently ignoring it", async () => {
      await expect(
        runner.buildRunner({ files: [{ content: BUNDLE }], allow_signatures: true }),
      ).rejects.toThrow(/allow_signatures is not supported by the local pipelex runner/);
    });
  });

  // The basic `mthds run` CLI dispatches to `execute` (pipelex, blocking) — this
  // is the local-runner half of the protocol's execute/start split.
  describe("execute", () => {
    it("runs `pipelex run bundle` and reduces working memory to the {concept, content} wire shape", async () => {
      mockSpawnExit(0);
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({
          root: {
            main_stuff: {
              stuff_code: "s1",
              concept: { code: "Greeting", domain_code: "hello" },
              content: { text: "hi" },
            },
          },
          aliases: { main_stuff: "main_stuff" },
        }),
      );

      const result = await runner.execute({ mthds_contents: ["bundle content"] });

      // spawn was invoked as `pipelex run bundle <path> -L <tmp> ...`
      const spawnArgs = mockedSpawn.mock.calls[0]![1] as string[];
      expect(spawnArgs.slice(0, 2)).toEqual(["run", "bundle"]);

      const root = (
        result.pipe_output as {
          working_memory: { root: Record<string, { concept: string; content: unknown }> };
        }
      ).working_memory.root;
      expect(root.main_stuff).toEqual({
        concept: "hello.Greeting",
        content: { text: "hi" },
      });
      expect(result.main_stuff_name).toBe("main_stuff");
    });

    it("throws `pipelex exited with code N` when the CLI fails", async () => {
      mockSpawnExit(1);
      await expect(runner.execute({ mthds_contents: ["bundle content"] })).rejects.toThrow(
        /pipelex exited with code 1/,
      );
    });
  });

  describe("validate — 0/1/2 exit-code policy", () => {
    it("returns the valid arm when the CLI exits 0", async () => {
      execFileAsync.mockResolvedValue({ stdout: "OK", stderr: "" });

      const result = await runner.validate(["bundle content"]);

      expect(result).toEqual({ is_valid: true });
    });

    it("returns the invalid arm (a verdict, not a throw) when the CLI exits 1", async () => {
      const execError = Object.assign(new Error("nonzero"), {
        code: 1,
        stderr: "Bundle validation failed: undefined concept",
        stdout: "",
      });
      execFileAsync.mockRejectedValue(execError);

      const result = await runner.validate(["bundle content"]);

      expect(result.is_valid).toBe(false);
      if (result.is_valid !== false) return;
      expect(result.message).toContain("undefined concept");
      expect(result.validation_errors).toEqual([]);
      expect(result.is_runnable).toBe(false);
    });

    it("throws on exit 2 (a no-verdict: setup / bad args / internal)", async () => {
      const execError = Object.assign(new Error("nonzero"), {
        code: 2,
        stderr: "Failed to validate: no .mthds bundle file found",
        stdout: "",
      });
      execFileAsync.mockRejectedValue(execError);

      await expect(runner.validate(["bundle content"])).rejects.toThrow("Bundle validation failed");
    });

    it("throws on a spawn failure (code is a string like ENOENT — a no-verdict)", async () => {
      const execError = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      execFileAsync.mockRejectedValue(execError);

      await expect(runner.validate(["bundle content"])).rejects.toThrow();
    });
  });
});
