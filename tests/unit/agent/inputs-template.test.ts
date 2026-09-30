import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { emitInputsTemplate, methodSelector } from "../../../src/agent/commands/api-commands.js";
import type { InputsRendering } from "../../../src/agent/commands/api-commands.js";
import { ApiResponseError } from "../../../src/runners/api/exceptions.js";
import type { InputForm } from "../../../src/protocol/input_form.js";
import type { PipeIOResponse, PipeIOValidReport, Runner } from "../../../src/runners/types.js";

// `mthds-agent inputs` on the API runner reads a pipe's input form from
// `POST /v1/pipe-io` and projects the fill-in template itself. These tests pin the
// request it sends, the two rendering axes against the shared projection corpus, and
// the envelope of each way the call can fail.

const CORPUS_URL = new URL("../../fixtures/protocol/", import.meta.url);
const INPUT_FORM = JSON.parse(
  readFileSync(new URL("input_form.json", CORPUS_URL), "utf-8"),
) as InputForm;

// A corpus pipe carrying floats, markers and a structured slot, so the TOML bytes
// exercise the emitter's layout rules and not just a bare string.
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

function apiRunner(pipeIo: ReturnType<typeof vi.fn>): Runner {
  return { type: "api", pipeIo } as unknown as Runner;
}

function refusal(status: number, errorType: string, detail: string): ApiResponseError {
  return new ApiResponseError(
    `API POST /v1/pipe-io failed (${status}): ${detail}`,
    "http://localhost:8081",
    status,
    "",
    "{}",
    errorType,
    detail,
    undefined,
    { problem: { errorDomain: "input", requestId: "req-pipe-io" } },
  );
}

const JSON_COMPACT: InputsRendering = { format: "json", explicit: false };
const FILES = { files: [{ content: 'domain = "x"\n', source: "x.mthds" }] };

describe("emitInputsTemplate", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // agentError ends in process.exit(1); throw a sentinel so the test can catch it.
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stdout(): string {
    return stdoutSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
  }

  function errorEnvelope(): Record<string, unknown> {
    return JSON.parse(stderrSpy.mock.calls[0]![0] as string) as Record<string, unknown>;
  }

  describe("the request", () => {
    it("posts the closure and the qualified pipe ref to pipeIo", async () => {
      const pipeIo = vi.fn().mockResolvedValue(validReport());
      await emitInputsTemplate(apiRunner(pipeIo), FILES, PIPE_REF, JSON_COMPACT);
      expect(pipeIo).toHaveBeenCalledWith({ ...FILES, pipe_ref: PIPE_REF });
    });

    // An omitted `--pipe` must reach the server ABSENT, so the server's own selection
    // chain decides rather than a client-side guess.
    it("leaves pipe_ref out when no pipe was named", async () => {
      const pipeIo = vi.fn().mockResolvedValue(validReport());
      await emitInputsTemplate(apiRunner(pipeIo), FILES, undefined, JSON_COMPACT);
      expect(pipeIo).toHaveBeenCalledWith(FILES);
    });

    it("sends a method_ref or method_id selector as given", async () => {
      const pipeIo = vi.fn().mockResolvedValue(validReport());
      await emitInputsTemplate(
        apiRunner(pipeIo),
        { method_ref: "github.com/acme/methods/docs@v1.0.0" },
        undefined,
        JSON_COMPACT,
      );
      await emitInputsTemplate(apiRunner(pipeIo), { method_id: "mt_abc" }, "a.b", JSON_COMPACT);
      expect(pipeIo).toHaveBeenNthCalledWith(1, {
        method_ref: "github.com/acme/methods/docs@v1.0.0",
      });
      expect(pipeIo).toHaveBeenNthCalledWith(2, { method_id: "mt_abc", pipe_ref: "a.b" });
    });
  });

  describe("the rendering", () => {
    it("prints the JSON envelope with the RESOLVED pipe ref and the compact template", async () => {
      const pipeIo = vi.fn().mockResolvedValue(validReport());
      await emitInputsTemplate(apiRunner(pipeIo), FILES, undefined, JSON_COMPACT);
      const envelope = JSON.parse(stdout()) as Record<string, unknown>;
      expect(envelope).toEqual({
        success: true,
        pipe_ref: PIPE_REF,
        inputs: JSON.parse(corpusTemplate("compact", "json")),
      });
    });

    it("honours --explicit in the JSON envelope", async () => {
      const pipeIo = vi.fn().mockResolvedValue(validReport());
      await emitInputsTemplate(apiRunner(pipeIo), FILES, undefined, {
        format: "json",
        explicit: true,
      });
      const envelope = JSON.parse(stdout()) as Record<string, unknown>;
      expect(envelope.inputs).toEqual(JSON.parse(corpusTemplate("explicit", "json")));
    });

    // TOML is printed raw, as `pipelex-agent inputs --format toml` prints it, and it
    // is the projection's own bytes: the corpus both repos hold to.
    it.each([
      ["compact", false],
      ["explicit", true],
    ] as const)(
      "prints the %s TOML template raw, byte-identical to the corpus",
      async (shape, explicit) => {
        const pipeIo = vi.fn().mockResolvedValue(validReport());
        await emitInputsTemplate(apiRunner(pipeIo), FILES, undefined, { format: "toml", explicit });
        expect(stdout()).toBe(corpusTemplate(shape, "toml"));
        expect(exitSpy).not.toHaveBeenCalled();
      },
    );

    it("prints an empty inputs object, or a TOML comment, for a pipe declaring no inputs", async () => {
      const report = validReport({ input_form: { [PIPE_REF]: { fields: [] } } });
      await emitInputsTemplate(
        apiRunner(vi.fn().mockResolvedValue(report)),
        FILES,
        undefined,
        JSON_COMPACT,
      );
      expect(JSON.parse(stdout())).toEqual({ success: true, pipe_ref: PIPE_REF, inputs: {} });

      stdoutSpy.mockClear();
      await emitInputsTemplate(apiRunner(vi.fn().mockResolvedValue(report)), FILES, undefined, {
        format: "toml",
        explicit: false,
      });
      expect(stdout()).toBe(`# Pipe '${PIPE_REF}' declares no inputs.\n`);
    });
  });

  describe("the failures", () => {
    // An invalid closure is a PRODUCED verdict (a 200 `is_valid: false` body), not a
    // request/transport failure: the `ValidateBundleError` envelope `validate` emits.
    it("emits a ValidateBundleError envelope carrying the verdict fields", async () => {
      const pipeIo = vi.fn().mockResolvedValue({
        is_valid: false,
        message: "Bundle is invalid",
        validation_errors: [{ category: "blueprint_validation", message: "boom" } as never],
      } satisfies PipeIOResponse);

      await expect(
        emitInputsTemplate(apiRunner(pipeIo), FILES, undefined, JSON_COMPACT),
      ).rejects.toThrow("__exit__");

      expect(exitSpy).toHaveBeenCalledWith(1);
      const envelope = errorEnvelope();
      expect(envelope.error_type).toBe("ValidateBundleError");
      expect(envelope.error_domain).toBe("validation");
      expect(envelope.is_valid).toBe(false);
      expect(envelope.validation_errors).toEqual([
        { category: "blueprint_validation", message: "boom" },
      ]);
    });

    // A refused selection is the caller's argument at fault, and the runner's own
    // sentence is where it names the candidates, so it is printed alone.
    it.each(["EntryPipeNotFoundError", "EntryPipeAmbiguousError"])(
      "turns a 422 typed %s into an ArgumentError carrying the runner's detail",
      async (errorType) => {
        const detail = "Pipe 'x.nope' not found in the submitted closure.";
        const pipeIo = vi.fn().mockRejectedValue(refusal(422, errorType, detail));

        await expect(
          emitInputsTemplate(apiRunner(pipeIo), FILES, "x.nope", JSON_COMPACT),
        ).rejects.toThrow("__exit__");

        expect(errorEnvelope()).toMatchObject({
          error_type: "ArgumentError",
          message: detail,
          error_domain: "input",
          request_id: "req-pipe-io",
        });
      },
    );

    // Any other 422 is a malformed request, not a selection — classified by the
    // error_type, never by what the message says.
    it("keeps any other 422 a RunnerError quoting the runner", async () => {
      const err = refusal(422, "ValidationError", "Pipe 'x.nope' not found");
      const pipeIo = vi.fn().mockRejectedValue(err);

      await expect(
        emitInputsTemplate(apiRunner(pipeIo), FILES, "x.nope", JSON_COMPACT),
      ).rejects.toThrow("__exit__");

      expect(errorEnvelope()).toMatchObject({
        error_type: "RunnerError",
        message: err.message,
        error_domain: "input",
      });
    });

    it("reports an answer whose input_form does not describe the selected pipe", async () => {
      const pipeIo = vi
        .fn()
        .mockResolvedValue(validReport({ input_form: { "other.pipe": { fields: [] } } }));

      await expect(
        emitInputsTemplate(apiRunner(pipeIo), FILES, undefined, JSON_COMPACT),
      ).rejects.toThrow("__exit__");

      const envelope = errorEnvelope();
      expect(envelope.error_type).toBe("RunnerError");
      expect(envelope.message).toContain(`'${PIPE_REF}'`);
      expect(envelope.message).toContain("other.pipe");
    });

    it("reports a descriptor the projection cannot render", async () => {
      // A concept ref carrying a line terminator would end its `# concept:` comment,
      // so the TOML emitter refuses it rather than writing a live key.
      const report = validReport({
        input_form: {
          [PIPE_REF]: {
            fields: [
              {
                kind: "text",
                name: "note",
                concept_ref: "native.Text\nrogue = 1",
                required: true,
                presence: "plain",
                gating: true,
              },
            ],
          },
        } as unknown as InputForm,
      });

      await expect(
        emitInputsTemplate(apiRunner(vi.fn().mockResolvedValue(report)), FILES, undefined, {
          format: "toml",
          explicit: false,
        }),
      ).rejects.toThrow("__exit__");

      const envelope = errorEnvelope();
      expect(envelope.error_type).toBe("RunnerError");
      expect(envelope.message).toContain(`Cannot render the inputs template of '${PIPE_REF}'`);
      expect(stdout()).toBe("");
    });
  });
});

describe("methodSelector", () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads a catalog id as a method_id", () => {
    expect(methodSelector("mt_abc123")).toEqual({ method_id: "mt_abc123" });
  });

  it("reads anything with a path as a method_ref", () => {
    expect(methodSelector("github.com/Pipelex/methods/documents@v0.1.0")).toEqual({
      method_ref: "github.com/Pipelex/methods/documents@v0.1.0",
    });
  });

  it("refuses a bare installed-method name with an ArgumentError", () => {
    expect(() => methodSelector("my-method")).toThrow("__exit__");
    const envelope = JSON.parse(
      vi.mocked(process.stderr.write).mock.calls[0]![0] as string,
    ) as Record<string, unknown>;
    expect(envelope.error_type).toBe("ArgumentError");
    expect(envelope.message).toContain("--runner pipelex");
  });

  // A local path has a separator too; sent as a method_ref it would come back as the
  // runner's registry-form 501, which says nothing about local files.
  it.each([
    "./methods/invoice",
    "../shared/bundle",
    "/abs/path",
    "~/methods/x",
    "dir/bundle.mthds",
  ])("refuses the local path %s with an ArgumentError pointing at inputs bundle", (target) => {
    expect(() => methodSelector(target)).toThrow("__exit__");
    const envelope = JSON.parse(
      vi.mocked(process.stderr.write).mock.calls[0]![0] as string,
    ) as Record<string, unknown>;
    expect(envelope.error_type).toBe("ArgumentError");
    expect(envelope.message).toContain("is a local path");
    expect(envelope.message).toContain("inputs bundle");
  });

  it("refuses a relative path that exists on disk", () => {
    // `tests/unit` exists relative to the repository root the suite runs from.
    expect(() => methodSelector("tests/unit")).toThrow("__exit__");
  });
});
