import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { registerApiRunnerCommands } from "../../../src/agent/commands/api-commands.js";
import { MthdsApiClient } from "../../../src/runners/api/client.js";

// On the API runner, `validate bundle` and `inputs bundle` must send a method split
// across files whole, as the pipelex runner loads it: every `.mthds` file of a
// directory target and of each `-L` directory, the entrypoint first. `-L` must reach
// the subcommand when written after it, and the graph options, which only the
// pipelex runner can honour, must be named in a warning rather than swallowed,
// without keeping the bundle from being validated.

const ROOT = 'domain = "demo"\nmain_pipe = "main"\n';
const CHILD = 'domain = "demo"\nmain_pipe = "step"\n[pipe.step]\ntype = "PipeLLM"\n';
const SHARED = 'domain = "shared"\n';

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

describe("API-runner validate and inputs send the whole bundle", () => {
  let dir: string;
  let method: string;
  let shared: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let requests: Captured[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "closure-commands-test-"));
    method = join(dir, "method");
    shared = join(dir, "shared");
    mkdirSync(method);
    mkdirSync(shared);
    writeFileSync(join(method, "bundle.mthds"), ROOT);
    writeFileSync(join(method, "child.mthds"), CHILD);
    writeFileSync(join(shared, "shared.mthds"), SHARED);

    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // agentError ends in process.exit(1); throw a sentinel so the test can catch it.
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);

    requests = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      requests.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const answer = url.endsWith("/build/inputs")
        ? { is_valid: true, pipe_ref: "demo.main", inputs: {} }
        : { is_valid: true, message: "ok", pending_signatures: [], is_runnable: true };
      return new Response(JSON.stringify(answer), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Parse a command line the way `agent-cli.ts` sets the program up for the API runner. */
  async function agent(...args: string[]): Promise<void> {
    const program = new Command()
      .option(
        "-L, --library-dir <dir>",
        "Additional library directory",
        (value: string, previous: string[]) => [...previous, resolve(value)],
        [] as string[],
      )
      .enablePositionalOptions()
      .exitOverride();
    registerApiRunnerCommands(
      program,
      () => new MthdsApiClient({ baseUrl: "http://localhost:8081", apiKey: "test" }),
    );
    await program.parseAsync(args, { from: "user" });
  }

  function firstStderrJson(): Record<string, unknown> {
    return JSON.parse(String(stderrSpy.mock.calls[0]![0])) as Record<string, unknown>;
  }

  describe("validate bundle", () => {
    it("sends every file of a directory target, its main file first", async () => {
      await agent("validate", "bundle", method, "--format", "json");

      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toMatch(/\/v1\/validate$/);
      expect(requests[0]!.body.mthds_contents).toEqual([ROOT, CHILD]);
      expect(requests[0]!.body.mthds_sources).toEqual([
        join(method, "bundle.mthds"),
        join(method, "child.mthds"),
      ]);
      expect(JSON.parse(String(stdoutSpy.mock.calls[0]![0]))).toMatchObject({ is_valid: true });
    });

    it("reads -L written after the subcommand, sending the named file first and once", async () => {
      const child = join(method, "child.mthds");
      await agent("validate", "bundle", child, "-L", `${method}/`, "--allow-signatures");

      expect(requests[0]!.body.mthds_contents).toEqual([CHILD, ROOT]);
      expect(requests[0]!.body.mthds_sources).toEqual([child, join(method, "bundle.mthds")]);
      expect(requests[0]!.body.allow_signatures).toBe(true);
    });

    it("reads -L written before the subcommand too, beside one written after it", async () => {
      const root = join(method, "bundle.mthds");
      await agent("-L", shared, "validate", "bundle", root, "--library-dir", method);

      expect(requests[0]!.body.mthds_contents).toEqual([ROOT, SHARED, CHILD]);
    });

    it("sends a named file alone when no library directory is given", async () => {
      const root = join(method, "bundle.mthds");
      await agent("validate", "bundle", root);

      expect(requests[0]!.body.mthds_contents).toEqual([ROOT]);
      expect(requests[0]!.body.mthds_sources).toEqual([root]);
    });

    it("labels inline --content when library files ride beside it", async () => {
      await agent("validate", "bundle", "--content", ROOT, "-L", shared);

      expect(requests[0]!.body.mthds_contents).toEqual([ROOT, SHARED]);
      expect(requests[0]!.body.mthds_sources).toEqual([
        "inline://file-1.mthds",
        join(shared, "shared.mthds"),
      ]);
    });

    it("sends no sources for inline --content alone", async () => {
      await agent("validate", "bundle", "--content", ROOT);

      expect(requests[0]!.body.mthds_contents).toEqual([ROOT]);
      expect(requests[0]!.body).not.toHaveProperty("mthds_sources");
    });

    it.each([
      [["--graph"], "--graph was"],
      [["-g", "--direction", "LR"], "--graph, --direction were"],
      [["--view"], "--view was"],
      [["--graph-format", "reactflow"], "--graph-format was"],
    ])("validates with %j and warns that no graph was drawn", async (flags, named) => {
      await agent("validate", "bundle", method, "-L", shared, ...flags, "--format", "json");

      expect(requests).toHaveLength(1);
      expect(requests[0]!.body.mthds_contents).toEqual([ROOT, CHILD, SHARED]);
      expect(JSON.parse(String(stdoutSpy.mock.calls[0]![0]))).toMatchObject({ is_valid: true });
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const warning = firstStderrJson();
      expect(warning).toMatchObject({ warning: true });
      expect(String(warning.message)).toContain(`${named} not applied`);
    });

    it("adds no warning to an invalid verdict's error envelope", async () => {
      vi.mocked(globalThis.fetch).mockImplementation(
        async () =>
          new Response(
            JSON.stringify({
              is_valid: false,
              message: "bad bundle",
              validation_errors: [{ category: "concept", message: "undeclared" }],
              pending_signatures: [],
              is_runnable: false,
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );

      await expect(
        agent("validate", "bundle", method, "--graph", "--format", "json"),
      ).rejects.toThrow("__exit__");

      // The stubbed exit throws, so later writes are the stub's echo; the first is the envelope.
      expect(firstStderrJson()).toMatchObject({ error: true, error_type: "ValidateBundleError" });
      for (const [written] of stderrSpy.mock.calls) {
        expect(String(written)).not.toContain('"warning"');
      }
    });

    it("writes nothing to stderr without a graph option", async () => {
      await agent("validate", "bundle", method, "--format", "json");

      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("refuses a target that is not a .mthds file or a directory", async () => {
      const notes = join(dir, "notes.txt");
      writeFileSync(notes, "not a bundle");

      await expect(agent("validate", "bundle", notes)).rejects.toThrow("__exit__");

      expect(requests).toHaveLength(0);
      expect(firstStderrJson()).toMatchObject({
        error_type: "ArgumentError",
        error_domain: "argument",
      });
    });

    it("reports a missing target as an IOError", async () => {
      await expect(agent("validate", "bundle", join(dir, "missing.mthds"))).rejects.toThrow(
        "__exit__",
      );

      expect(requests).toHaveLength(0);
      expect(firstStderrJson()).toMatchObject({ error_type: "IOError", error_domain: "io" });
    });
  });

  describe("validate pipe", () => {
    it("sends the named file and the -L directory's files", async () => {
      const child = join(method, "child.mthds");
      await agent("validate", "pipe", child, "-L", method);

      expect(requests[0]!.body.mthds_contents).toEqual([CHILD, ROOT]);
    });
  });

  describe("inputs bundle", () => {
    it("sends every file of a directory target and asks for its entry file's pipe", async () => {
      await agent("inputs", "bundle", method);

      expect(requests[0]!.url).toMatch(/\/v1\/build\/inputs$/);
      expect(requests[0]!.body.files).toEqual([
        { content: ROOT, source: join(method, "bundle.mthds") },
        { content: CHILD, source: join(method, "child.mthds") },
      ]);
      // The child declares a main_pipe too, so the runner's chain alone could not choose.
      expect(requests[0]!.body.pipe_ref).toBe("demo.main");
    });

    it("leaves the pipe to the runner for a directory holding its entry alone", async () => {
      await agent("inputs", "bundle", shared);

      expect(requests[0]!.body.files).toEqual([
        { content: SHARED, source: join(shared, "shared.mthds") },
      ]);
      expect(requests[0]!.body).not.toHaveProperty("pipe_ref");
    });

    it("keeps a named file the entrypoint among the -L files", async () => {
      const child = join(method, "child.mthds");
      await agent("inputs", "bundle", child, "-L", method);

      expect(requests[0]!.body.files).toEqual([
        { content: CHILD, source: child },
        { content: ROOT, source: join(method, "bundle.mthds") },
      ]);
      expect(requests[0]!.body.pipe_ref).toBe("demo.step");
    });

    it("lets --pipe override the named file's main pipe", async () => {
      const child = join(method, "child.mthds");
      await agent("inputs", "bundle", child, "-L", method, "--pipe", "demo.main");

      expect(requests[0]!.body.pipe_ref).toBe("demo.main");
    });

    it("sends a named file alone, with no pipe_ref, when no library directory is given", async () => {
      const root = join(method, "bundle.mthds");
      await agent("inputs", "bundle", root);

      expect(requests[0]!.body.files).toEqual([{ content: ROOT, source: root }]);
      expect(requests[0]!.body).not.toHaveProperty("pipe_ref");
    });
  });

  describe("inputs pipe", () => {
    it("sends the named file and the -L directory's files", async () => {
      const child = join(method, "child.mthds");
      await agent("inputs", "pipe", child, "-L", method);

      expect(requests[0]!.body.files).toEqual([
        { content: CHILD, source: child },
        { content: ROOT, source: join(method, "bundle.mthds") },
      ]);
      expect(requests[0]!.body.pipe_ref).toBe("demo.step");
    });
  });
});
