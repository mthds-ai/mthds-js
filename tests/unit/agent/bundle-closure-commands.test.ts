import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { registerApiRunnerCommands } from "../../../src/agent/commands/api-commands.js";
import { MthdsApiClient } from "../../../src/runners/api/client.js";

// On the API runner, `validate` sends the method's tree as the standard's lister defines it, each
// file under its tree path, and `-L` can only root a lone file's tree at a directory holding it.
// `inputs` still sends a closure of `.mthds` files, since `/v1/pipe-io` takes no tree: every
// `.mthds` file of a directory target and of each `-L` directory, the entrypoint first. `-L` must
// reach the subcommand when written after it, and the graph options, which only the pipelex runner
// can honour, must be named in a warning rather than swallowed, without keeping the bundle from
// being validated.

const ROOT = 'domain = "demo"\nmain_pipe = "main"\n';
const CHILD = 'domain = "demo"\nmain_pipe = "step"\n[pipe.step]\ntype = "PipeLLM"\n';
const SHARED = 'domain = "shared"\n';

interface Captured {
  url: string;
  body: Record<string, unknown>;
}

const VALIDATE_ANSWER = {
  is_valid: true,
  message: "ok",
  pending_signatures: [],
  is_runnable: true,
};

/** A valid `/v1/pipe-io` answer for the pipe the request named, else `demo.main`, with one text input. */
function pipeIoAnswer(body: Record<string, unknown>): Record<string, unknown> {
  const pipeRef = typeof body.pipe_ref === "string" ? body.pipe_ref : "demo.main";
  return {
    is_valid: true,
    pipe_ref: pipeRef,
    pipe_io_contracts: {},
    input_form: {
      [pipeRef]: {
        fields: [
          {
            kind: "prose",
            name: "topic",
            concept_ref: "native.Text",
            description: "A topic",
            required: true,
            presence: "plain",
            gating: true,
          },
        ],
      },
    },
    output_form: {},
    default_pipe_ref: pipeRef,
    pending_signatures: [],
    is_runnable: true,
  };
}

describe("API-runner validate sends the method's tree, inputs the whole bundle", () => {
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
      // The handshake: a runner with no blob store, so every tree travels inline.
      if (url.endsWith("/version")) {
        return new Response(JSON.stringify({ protocol_version: "1.0.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, body });
      const answer = url.endsWith("/pipe-io") ? pipeIoAnswer(body) : VALIDATE_ANSWER;
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
    it("sends a directory target as its tree, each file under its tree path", async () => {
      await agent("validate", "bundle", method, "--format", "json");

      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toMatch(/\/v1\/validate$/);
      // The client always asks for the rendered Markdown, a Pipelex-API extension.
      expect(requests[0]!.body).toEqual({
        files: { "bundle.mthds": ROOT, "child.mthds": CHILD },
        allow_signatures: false,
        render: ["markdown"],
      });
      expect(JSON.parse(String(stdoutSpy.mock.calls[0]![0]))).toMatchObject({ is_valid: true });
    });

    it("roots a named file at an -L directory holding it, written after the subcommand", async () => {
      const child = join(method, "child.mthds");
      await agent("validate", "bundle", child, "-L", `${method}/`, "--allow-signatures");

      expect(requests[0]!.body.files).toEqual({ "bundle.mthds": ROOT, "child.mthds": CHILD });
      expect(requests[0]!.body.allow_signatures).toBe(true);
    });

    it("reads -L written before the subcommand too", async () => {
      const child = join(method, "child.mthds");
      await agent("-L", method, "validate", "bundle", child);

      expect(requests[0]!.body.files).toEqual({ "bundle.mthds": ROOT, "child.mthds": CHILD });
    });

    it("refuses an -L directory that would add a second tree, sending nothing", async () => {
      const root = join(method, "bundle.mthds");
      await expect(
        agent("-L", shared, "validate", "bundle", root, "--library-dir", method),
      ).rejects.toThrow("__exit__");

      expect(requests).toHaveLength(0);
      expect(firstStderrJson()).toMatchObject({
        error_type: "ArgumentError",
        error_domain: "argument",
      });
      expect(String(firstStderrJson().message)).toContain("does not hold it");
    });

    it("sends a named file alone when no library directory is given", async () => {
      await agent("validate", "bundle", join(method, "bundle.mthds"));

      expect(requests[0]!.body.files).toEqual({ "bundle.mthds": ROOT });
    });

    it("sends inline --content as a one-file tree, with no handshake", async () => {
      await agent("validate", "bundle", "--content", ROOT);

      expect(requests).toHaveLength(1);
      expect(requests[0]!.body.files).toEqual({ "bundle.mthds": ROOT });
      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    });

    it("refuses a library directory beside inline --content", async () => {
      await expect(agent("validate", "bundle", "--content", ROOT, "-L", shared)).rejects.toThrow(
        "__exit__",
      );

      expect(requests).toHaveLength(0);
      expect(firstStderrJson()).toMatchObject({ error_type: "ArgumentError" });
    });

    it.each([
      [["--graph"], "--graph was"],
      [["-g", "--direction", "LR"], "--graph, --direction were"],
      [["--view"], "--view was"],
      [["--graph-format", "reactflow"], "--graph-format was"],
    ])("validates with %j and warns that no graph was drawn", async (flags, named) => {
      await agent("validate", "bundle", method, ...flags, "--format", "json");

      expect(requests).toHaveLength(1);
      expect(requests[0]!.body.files).toEqual({ "bundle.mthds": ROOT, "child.mthds": CHILD });
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
    it("sends the tree of the -L directory holding the named file", async () => {
      const child = join(method, "child.mthds");
      await agent("validate", "pipe", child, "-L", method);

      expect(requests[0]!.body.files).toEqual({ "bundle.mthds": ROOT, "child.mthds": CHILD });
    });
  });

  describe("inputs bundle", () => {
    it("sends every file of a directory target and asks for its entry file's pipe", async () => {
      await agent("inputs", "bundle", method);

      expect(requests[0]!.url).toMatch(/\/v1\/pipe-io$/);
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

    it("sends an empty --pipe as given instead of the entry's main pipe", async () => {
      const child = join(method, "child.mthds");
      await agent("inputs", "bundle", child, "-L", method, "--pipe", "");

      expect(requests[0]!.body).toHaveProperty("pipe_ref", "");
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
      expect(JSON.parse(String(stdoutSpy.mock.calls[0]![0]))).toEqual({
        success: true,
        pipe_ref: "demo.step",
        inputs: { topic: "text_value" },
      });
    });

    it("renders the closure's template in TOML beside -L", async () => {
      const child = join(method, "child.mthds");
      await agent("inputs", "pipe", child, "-L", method, "--format", "toml");

      expect(requests[0]!.body.pipe_ref).toBe("demo.step");
      expect(String(stdoutSpy.mock.calls[0]![0])).toBe(
        '# concept: native.Text\ntopic = "text_value"\n',
      );
    });
  });
});
