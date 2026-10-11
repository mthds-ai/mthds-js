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

import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { PipelexRunner } from "../../../src/runners/pipelex/runner.js";
import { MODEL_CATEGORIES } from "../../../src/protocol/models.js";

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedSpawn = vi.mocked(spawn);

/** A minimal bundle that declares a domain and a main_pipe. */
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

    it("names every protocol category when type is omitted", async () => {
      await expect(runner.checkModel({ reference: "gpt-4o" } as any)).rejects.toThrow(
        `(one of: ${MODEL_CATEGORIES.join(", ")})`,
      );
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
      expect(deck.aliases).toEqual({ llm: { best: "gpt-4o" } });
      expect(deck.waterfalls).toEqual({ llm: { default: ["gpt-4o"] } });
    });

    // The same alias name exists in several categories pointing at different
    // models (a default per family), so the routing extensions stay keyed by
    // category, as pipelex's own protocol runner serves them: flattening them
    // kept only the category iterated last.
    it("keeps an alias name defined in two categories under each of them", async () => {
      execFileAsync.mockResolvedValue({
        stdout: JSON.stringify({
          success: true,
          presets: { llm: [{ name: "gpt-4o" }], img_gen: [{ name: "flux" }] },
          aliases: { llm: { default: "gpt-4o" }, img_gen: { default: "flux" } },
          waterfalls: { llm: { cheap: ["gpt-4o-mini"] }, img_gen: { cheap: ["flux-schnell"] } },
        }),
        stderr: "",
      });

      const deck = await runner.models();

      expect(deck.aliases).toEqual({ llm: { default: "gpt-4o" }, img_gen: { default: "flux" } });
      expect(deck.waterfalls).toEqual({
        llm: { cheap: ["gpt-4o-mini"] },
        img_gen: { cheap: ["flux-schnell"] },
      });
    });

    it("keeps a judgment preset and a category it does not know with their raw type", async () => {
      execFileAsync.mockResolvedValue({
        stdout: JSON.stringify({
          success: true,
          presets: {
            llm: [{ name: "gpt-4o" }],
            judgment: [{ name: "judge-small" }],
            vendor_family: [{ name: "future-model" }],
          },
          aliases: { judgment: { default: "judge-small" } },
          waterfalls: {},
        }),
        stderr: "",
      });

      const deck = await runner.models();

      expect(deck.models).toEqual([
        { name: "gpt-4o", type: "llm" },
        { name: "judge-small", type: "judgment" },
        { name: "future-model", type: "vendor_family" },
      ]);
      expect(deck.aliases).toEqual({ judgment: { default: "judge-small" } });
    });

    it("forwards the judgment filter to pipelex-agent", async () => {
      execFileAsync.mockResolvedValue({ stdout: '{"success":true,"presets":{}}', stderr: "" });

      await runner.models("judgment");

      const args = execFileAsync.mock.calls[0]![1] as string[];
      expect(args[args.indexOf("--type") + 1]).toBe("judgment");
    });

    it("passes a protocol-shaped ModelDeck through verbatim", async () => {
      execFileAsync.mockResolvedValue({
        stdout: JSON.stringify({
          models: [{ name: "gpt-4o", type: "llm" }],
          aliases: { llm: { best: "gpt-4o" } },
          waterfalls: {},
        }),
        stderr: "",
      });

      const deck = await runner.models();
      expect(deck.models).toEqual([{ name: "gpt-4o", type: "llm" }]);
      expect(deck.aliases).toEqual({ llm: { best: "gpt-4o" } });
    });

    it("passes a protocol-shaped deck carrying an unknown category through unchanged", async () => {
      const served = {
        models: [
          { name: "judge-small", type: "judgment" },
          { name: "future-model", type: "vendor_family" },
        ],
        aliases: { vendor_family: { default: "future-model" } },
        waterfalls: {},
      };
      execFileAsync.mockResolvedValue({ stdout: JSON.stringify(served), stderr: "" });

      const deck = await runner.models();

      expect(deck).toEqual(served);
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

    it("writes the first content as bundle.mthds, the rest beside it, and points the CLI there", async () => {
      execFileAsync.mockResolvedValue({ stdout: "", stderr: "" });

      await runner.validate([BUNDLE, "domain = 'other'", "domain = 'third'"]);

      expect(mockedWriteFileSync.mock.calls.map((call) => [call[0], call[1]])).toEqual([
        ["/tmp/mthds-test/bundle.mthds", BUNDLE],
        ["/tmp/mthds-test/extra_1.mthds", "domain = 'other'"],
        ["/tmp/mthds-test/extra_2.mthds", "domain = 'third'"],
      ]);
      const args = execFileAsync.mock.calls[0]![1] as string[];
      expect(args.slice(0, 5)).toEqual([
        "validate",
        "bundle",
        "/tmp/mthds-test/bundle.mthds",
        "-L",
        "/tmp/mthds-test",
      ]);
    });

    it("refuses an empty bundle list before calling the CLI", async () => {
      await expect(runner.validate([])).rejects.toThrow(/At least one MTHDS file/);
      expect(execFileAsync).not.toHaveBeenCalled();
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
              stuff_name: "main_stuff",
              concept: "hello.Greeting",
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

    it("passes a dependency's package-qualified crate key through as written", async () => {
      mockSpawnExit(0);
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(
        JSON.stringify({
          root: {
            clause: {
              stuff_code: "s1",
              concept: "github.com/acme/legal::legal.Clause",
              content: { text: "…" },
            },
          },
          aliases: {},
        }),
      );

      const result = await runner.execute({ mthds_contents: ["bundle content"] });

      const root = (
        result.pipe_output as {
          working_memory: { root: Record<string, { concept: string; content: unknown }> };
        }
      ).working_memory.root;
      expect(root.clause!.concept).toBe("github.com/acme/legal::legal.Clause");
    });

    // Since standard 2.1.0 a stuff names its concept by its crate key wherever it travels,
    // the working memory a run writes included, so the reduction has nothing to rebuild.
    it.each([
      [
        "the concept object a runtime older than 2.1.0 wrote",
        { code: "Greeting", domain_code: "hello" },
        "an object",
      ],
      ["no concept at all", undefined, "missing"],
      ["a null concept", null, "null"],
    ])(
      "refuses a stuff carrying %s in place of its ref string",
      async (_topic, concept, described) => {
        mockSpawnExit(0);
        mockedExistsSync.mockReturnValue(true);
        mockedReadFileSync.mockReturnValue(
          JSON.stringify({
            root: { main_stuff: { stuff_code: "s1", concept, content: { text: "hi" } } },
            aliases: { main_stuff: "main_stuff" },
          }),
        );

        await expect(runner.execute({ mthds_contents: ["bundle content"] })).rejects.toThrow(
          `pipelex wrote the stuff "main_stuff" whose "concept" is ${described}`,
        );
      },
    );

    it("throws `pipelex exited with code N` when the CLI fails", async () => {
      mockSpawnExit(1);
      await expect(runner.execute({ mthds_contents: ["bundle content"] })).rejects.toThrow(
        /pipelex exited with code 1/,
      );
    });

    it("rejects bundle_b64 — the local runner has no zip decoder", async () => {
      await expect(runner.execute({ bundle_b64: "UEsDBBQ=" })).rejects.toThrow(/bundle_b64|zip/i);
      expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it("rejects files combined with mthds_contents (self-contained bundle)", async () => {
      await expect(
        runner.execute({ files: { "m.mthds": BUNDLE }, mthds_contents: ["domain = 'x'"] }),
      ).rejects.toThrow(/self-contained|mutually exclusive/i);
      expect(mockedSpawn).not.toHaveBeenCalled();
    });

    it("points `run bundle` at the caller-selected entrypoint (bundleMain)", async () => {
      mockSpawnExit(0);
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue(JSON.stringify({ root: {}, aliases: {} }));
      await runner.execute({
        files: { "method_a.mthds": 'main_pipe = "a"', "method_b.mthds": 'main_pipe = "b"' },
        bundleMain: "method_b.mthds",
      });
      const spawnArgs = mockedSpawn.mock.calls[0]![1] as string[];
      // `run bundle <path>` — the path must be the selected method_b, not method_a.
      expect(spawnArgs[2]).toContain("method_b.mthds");
      expect(spawnArgs[2]).not.toContain("method_a.mthds");
    });

    // A dry run that never reaches pipelex is a real, paid run.
    it("forwards --dry-run, --mock-inputs and --local to `pipelex run`", async () => {
      mockSpawnExit(0);
      await runner.execute(
        { mthds_contents: ["bundle content"] },
        { dryRun: true, mockInputs: true, hosted: false },
      );
      const spawnArgs = mockedSpawn.mock.calls[0]![1] as string[];
      expect(spawnArgs).toEqual(expect.arrayContaining(["--dry-run", "--mock-inputs", "--local"]));
      expect(spawnArgs).not.toContain("--hosted");
    });

    it("forwards --hosted to `pipelex run pipe`", async () => {
      mockSpawnExit(0);
      await runner.execute({ pipe_code: "echo" }, { hosted: true });
      const spawnArgs = mockedSpawn.mock.calls[0]![1] as string[];
      expect(spawnArgs.slice(0, 3)).toEqual(["run", "pipe", "echo"]);
      expect(spawnArgs).toContain("--hosted");
      expect(spawnArgs).not.toContain("--local");
    });

    it("adds no run flag when none is given, leaving `[run] execution` to pipelex", async () => {
      mockSpawnExit(0);
      await runner.execute({ mthds_contents: ["bundle content"] });
      const spawnArgs = mockedSpawn.mock.calls[0]![1] as string[];
      for (const flag of ["--dry-run", "--mock-inputs", "--hosted", "--local"]) {
        expect(spawnArgs).not.toContain(flag);
      }
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
