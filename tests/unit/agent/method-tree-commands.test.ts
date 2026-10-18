import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import { registerApiRunnerCommands } from "../../../src/agent/commands/api-commands.js";
import { chooseErrorFormat } from "../../../src/agent/output.js";
import { MthdsApiClient } from "../../../src/runners/api/client.js";

// On the API runner, `validate`, `run start` and `inputs` send the method's tree as the standard's
// lister defines it, each file under its tree path, and `-L` can only root a lone file's tree at a
// directory holding it. `inputs` asks for a named bundle's own `main_pipe`, qualified with its
// domain, and leaves a directory's pipe to the runner's entry rule. `-L` must reach the subcommand
// when written after it, and the graph options, which only the pipelex runner can honour, must be
// named in a warning rather than swallowed, without keeping the bundle from being validated.

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

const START_ANSWER = { pipeline_run_id: "run-1", state: "STARTED" };

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

describe("API-runner commands send the method's tree", () => {
  let dir: string;
  let method: string;
  let shared: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let requests: Captured[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "method-tree-commands-test-"));
    method = join(dir, "method");
    shared = join(dir, "shared");
    mkdirSync(method);
    mkdirSync(shared);
    writeFileSync(join(method, "bundle.mthds"), ROOT);
    writeFileSync(join(method, "child.mthds"), CHILD);
    writeFileSync(join(shared, "shared.mthds"), SHARED);

    chooseErrorFormat("json");
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
      // A started run is a 202 naming the run; every other route answers a 200 verdict.
      const started = url.endsWith("/start");
      const answer = url.endsWith("/pipe-io")
        ? pipeIoAnswer(body)
        : started
          ? START_ANSWER
          : VALIDATE_ANSWER;
      return new Response(JSON.stringify(answer), {
        status: started ? 202 : 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  });

  afterEach(() => {
    chooseErrorFormat(undefined);
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

  describe("run start", () => {
    it("roots a lone file's tree at the -L directory holding it, so the files beside it travel", async () => {
      await agent("run", "start", join(method, "child.mthds"), "-L", method);

      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toMatch(/\/v1\/start$/);
      expect(requests[0]!.body.files).toEqual({ "bundle.mthds": ROOT, "child.mthds": CHILD });
      expect(requests[0]!.body.pipe_code).toBe("step");
    });

    it("reads -L written before the subcommand too", async () => {
      await agent("-L", method, "run", "start", join(method, "child.mthds"));

      expect(requests[0]!.body.files).toEqual({ "bundle.mthds": ROOT, "child.mthds": CHILD });
    });

    it("reads a directory's own inputs.json as the run's inputs, which never travels with the tree", async () => {
      writeFileSync(join(method, "inputs.json"), '{"topic": "invoices"}\n');

      await agent("run", "start", method);

      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toMatch(/\/v1\/start$/);
      expect(requests[0]!.body.inputs).toEqual({ topic: "invoices" });
      expect(requests[0]!.body.files).toEqual({ "bundle.mthds": ROOT, "child.mthds": CHILD });
    });

    // A link found by name could carry JSON from outside the method's folder to the runner.
    it.each([
      ["a link to JSON outside the method's folder", "a symbolic link", "outside"],
      ["a dangling link", "a symbolic link", "dangling"],
      ["a directory", "not a regular file", "directory"],
    ])(
      "refuses a directory's own inputs.json that is %s, starting nothing",
      async (_what, described, kind) => {
        const candidate = join(method, "inputs.json");
        if (kind === "outside") {
          writeFileSync(join(dir, "elsewhere.json"), '{"topic": "from outside"}\n');
          symlinkSync(join(dir, "elsewhere.json"), candidate);
        } else if (kind === "dangling") {
          symlinkSync(join(dir, "missing.json"), candidate);
        } else {
          mkdirSync(candidate);
        }
        const start = vi.spyOn(MthdsApiClient.prototype, "start");

        await expect(agent("run", "start", method)).rejects.toThrow("__exit__");

        expect(start).not.toHaveBeenCalled();
        expect(requests).toHaveLength(0);
        const error = firstStderrJson();
        expect(error).toMatchObject({
          code: "client.argument_invalid",
          params: { argument: "inputs", reason: "not_a_regular_file" },
        });
        expect(String(error.message)).toContain(`'${candidate}'`);
        expect(String(error.message)).toContain(`it is ${described}`);
        expect(String(error.message)).toContain("--inputs <path>");
      },
    );

    it("reads an inputs file named with --inputs as given, a link included", async () => {
      writeFileSync(join(dir, "elsewhere.json"), '{"topic": "chosen"}\n');
      symlinkSync(join(dir, "elsewhere.json"), join(dir, "chosen.json"));

      await agent("run", "start", method, "--inputs", join(dir, "chosen.json"));

      expect(requests).toHaveLength(1);
      expect(requests[0]!.body.inputs).toEqual({ topic: "chosen" });
    });

    it("starts inline --content beside a global -L, which does not apply to it", async () => {
      await agent("-L", shared, "run", "start", "--content", ROOT);

      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toMatch(/\/v1\/start$/);
      expect(requests[0]!.body.files).toEqual({ "bundle.mthds": ROOT });
    });

    it("refuses an -L directory outside the tree, starting nothing", async () => {
      await expect(
        agent("run", "start", join(method, "child.mthds"), "-L", method, "-L", shared),
      ).rejects.toThrow("__exit__");

      expect(requests).toHaveLength(0);
      expect(String(firstStderrJson().message)).toContain("outside that tree");
    });

    it("refuses a named bundle whose main_pipe is empty without --pipe, starting nothing", async () => {
      await expect(
        agent("run", "start", "--content", 'domain = "demo"\nmain_pipe = ""\n'),
      ).rejects.toThrow("__exit__");

      expect(requests).toHaveLength(0);
      expect(String(firstStderrJson().message)).toContain("Could not determine pipe code");
    });
  });

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
        code: "client.argument_invalid",
        domain: "input",
        params: { argument: "target", reason: "library_dir_outside_tree" },
      });
      expect(String(firstStderrJson().message)).toContain("outside that tree");
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

    it("sends inline --content alone beside a library directory, which does not apply to it", async () => {
      await agent("validate", "bundle", "--content", ROOT, "-L", shared);

      expect(requests).toHaveLength(1);
      expect(requests[0]!.body.files).toEqual({ "bundle.mthds": ROOT });
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
        async (input) =>
          new Response(
            JSON.stringify(
              // The handshake still reads a version; only the validation answers an invalid verdict.
              String(input).endsWith("/version")
                ? { protocol_version: "1.0.0" }
                : {
                    is_valid: false,
                    message: "bad bundle",
                    errors: [
                      { code: "method.concept_unresolved", detail: "The concept is undeclared." },
                    ],
                    pending_signatures: [],
                    is_runnable: false,
                  },
            ),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      );

      await expect(
        agent("validate", "bundle", method, "--graph", "--format", "json"),
      ).rejects.toThrow("__exit__");

      // The stubbed exit throws, so later writes are the stub's echo; the first is the envelope.
      expect(firstStderrJson()).toMatchObject({
        code: "method.invalid",
        is_valid: false,
        message: "bad bundle",
        errors: [{ code: "method.concept_unresolved", detail: "The concept is undeclared." }],
      });
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
        code: "client.argument_invalid",
        domain: "input",
        params: { argument: "target", reason: "not_a_bundle_file" },
      });
    });

    it("reports a missing target as a file it cannot read", async () => {
      const missing = join(dir, "missing.mthds");
      await expect(agent("validate", "bundle", missing)).rejects.toThrow("__exit__");

      expect(requests).toHaveLength(0);
      expect(firstStderrJson()).toMatchObject({
        code: "client.file_unreadable",
        domain: "input",
        params: { path: missing, reason: "enoent" },
      });
    });

    it.each([
      [
        "a name too long for the system",
        () => join(dir, `${"x".repeat(300)}.mthds`),
        "enametoolong",
      ],
      [
        "a path through a loop of symbolic links",
        () => {
          symlinkSync(join(dir, "loop-b"), join(dir, "loop-a"));
          symlinkSync(join(dir, "loop-a"), join(dir, "loop-b"));
          return join(dir, "loop-a", "bundle.mthds");
        },
        "eloop",
      ],
    ])("reports a target refused for %s with the system's reason", async (_what, path, reason) => {
      const target = path();
      await expect(agent("validate", "bundle", target)).rejects.toThrow("__exit__");

      expect(requests).toHaveLength(0);
      expect(firstStderrJson()).toMatchObject({
        code: "client.file_unreadable",
        params: { path: target, reason },
      });
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
    it("sends a directory target as its tree and leaves the pipe to the runner's entry rule", async () => {
      await agent("inputs", "bundle", method);

      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toMatch(/\/v1\/pipe-io$/);
      expect(requests[0]!.body).toEqual({ files: { "bundle.mthds": ROOT, "child.mthds": CHILD } });
    });

    it("roots a named file at the -L directory holding it and asks for its own pipe", async () => {
      await agent("inputs", "bundle", join(method, "child.mthds"), "-L", method);

      expect(requests[0]!.body).toEqual({
        files: { "bundle.mthds": ROOT, "child.mthds": CHILD },
        pipe_ref: "demo.step",
      });
    });

    it("qualifies the named bundle's main_pipe with its own domain, so two domains declaring it are told apart", async () => {
      const twoDomains = join(dir, "two-domains");
      mkdirSync(twoDomains);
      writeFileSync(join(twoDomains, "alpha.mthds"), 'domain = "alpha"\nmain_pipe = "run"\n');
      writeFileSync(join(twoDomains, "beta.mthds"), 'domain = "beta"\nmain_pipe = "run"\n');

      await agent("inputs", "bundle", join(twoDomains, "beta.mthds"), "-L", twoDomains);

      expect(requests[0]!.body.pipe_ref).toBe("beta.run");
      expect(Object.keys(requests[0]!.body.files as object)).toEqual(["alpha.mthds", "beta.mthds"]);
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

    it("sends a named file alone when no library directory holds it, asking for its own pipe", async () => {
      await agent("inputs", "bundle", join(method, "bundle.mthds"));

      expect(requests[0]!.body).toEqual({
        files: { "bundle.mthds": ROOT },
        pipe_ref: "demo.main",
      });
    });

    it("leaves the pipe to the runner for a named bundle declaring no main_pipe", async () => {
      await agent("inputs", "bundle", join(shared, "shared.mthds"));

      expect(requests[0]!.body).toEqual({ files: { "shared.mthds": SHARED } });
    });

    it("sends no malformed pipe_ref for an empty domain or an empty main_pipe", async () => {
      const emptyDomain = 'domain = ""\nmain_pipe = "go"\n';
      const emptyMainPipe = 'domain = "demo"\nmain_pipe = ""\n';
      await agent("inputs", "bundle", "--content", emptyDomain);
      await agent("inputs", "bundle", "--content", emptyMainPipe);

      expect(requests.map((request) => request.body)).toEqual([
        { files: { "bundle.mthds": emptyDomain } },
        { files: { "bundle.mthds": emptyMainPipe } },
      ]);
    });

    it("sends inline --content as a one-file tree with its own pipe, with no handshake", async () => {
      await agent("-L", shared, "inputs", "bundle", "--content", ROOT);

      expect(requests).toHaveLength(1);
      expect(requests[0]!.body).toEqual({
        files: { "bundle.mthds": ROOT },
        pipe_ref: "demo.main",
      });
      expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
    });

    it("sends the files the membership rule keeps, leaving hidden folders behind", async () => {
      const broken = 'domain = "broken"\n[pipe.oops\n';
      mkdirSync(join(method, ".drafts"));
      writeFileSync(join(method, ".drafts", "broken.mthds"), broken);
      mkdirSync(join(method, "results"));
      writeFileSync(join(method, "results", "kept.mthds"), SHARED);

      await agent("inputs", "bundle", method);

      expect(requests[0]!.body.files).toEqual({
        "bundle.mthds": ROOT,
        "child.mthds": CHILD,
        "results/kept.mthds": SHARED,
      });
    });

    it("refuses an -L directory outside the tree, sending nothing", async () => {
      await expect(
        agent("inputs", "bundle", join(method, "child.mthds"), "-L", method, "-L", shared),
      ).rejects.toThrow("__exit__");

      expect(requests).toHaveLength(0);
      expect(firstStderrJson()).toMatchObject({
        code: "client.argument_invalid",
        domain: "input",
        params: { argument: "target", reason: "library_dir_outside_tree" },
      });
      expect(String(firstStderrJson().message)).toContain("outside that tree");
    });

    it("reports a missing target as a file it cannot read, sending nothing", async () => {
      const missing = join(dir, "missing.mthds");
      await expect(agent("inputs", "bundle", missing)).rejects.toThrow("__exit__");

      expect(requests).toHaveLength(0);
      expect(firstStderrJson()).toMatchObject({
        code: "client.file_unreadable",
        domain: "input",
        params: { path: missing, reason: "enoent" },
      });
    });
  });

  describe("inputs pipe", () => {
    it("sends the tree of the -L directory holding the named file", async () => {
      const child = join(method, "child.mthds");
      await agent("inputs", "pipe", child, "-L", method);

      expect(requests[0]!.body).toEqual({
        files: { "bundle.mthds": ROOT, "child.mthds": CHILD },
        pipe_ref: "demo.step",
      });
      expect(JSON.parse(String(stdoutSpy.mock.calls[0]![0]))).toEqual({
        success: true,
        pipe_ref: "demo.step",
        inputs: { topic: "text_value" },
      });
    });

    it("renders the tree's template in TOML beside -L", async () => {
      const child = join(method, "child.mthds");
      await agent("inputs", "pipe", child, "-L", method, "--format", "toml");

      expect(requests[0]!.body.pipe_ref).toBe("demo.step");
      expect(String(stdoutSpy.mock.calls[0]![0])).toBe(
        '# concept: native.Text\ntopic = "text_value"\n',
      );
    });
  });
});
