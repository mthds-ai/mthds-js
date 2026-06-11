import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MthdsApiClient } from "../../../src/runners/api/client.js";
import { BaseRunner } from "../../../src/runners/base-runner.js";
import type { DictRunResultExecute } from "../../../src/runners/api/models.js";

/**
 * New-behavior coverage for the protocol ⊥ runners structural split (plan 04b):
 * the run-response split (`RunResultExecute<T>` ⊥ `RunResultStart`), the
 * slimmed extension-open discovery models, and the D-B composite merge.
 */

const BASE_URL = "http://localhost:8081";

function makeClient(): MthdsApiClient {
  return new MthdsApiClient({ baseUrl: BASE_URL, apiToken: "test-token" });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run-response split (T2)", () => {
  it("execute() → RunResultExecute carrying pipe_output (present)", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        pipeline_run_id: "run-1",
        pipe_output: {
          working_memory: { root: { main_stuff: { concept: "x.Y", content: "hi" } }, aliases: {} },
          pipeline_run_id: "run-1",
        },
      })
    );

    const result = await client.execute({ pipe_code: "p" });

    expect(result.pipeline_run_id).toBe("run-1");
    expect(result.pipe_output).toBeDefined();
    expect(result.pipe_output.working_memory.root.main_stuff!.content).toBe("hi");
  });

  it("RunResultExecute<DictPipeOutput> parses with the Dict-serialized output", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        pipeline_run_id: "run-2",
        pipe_output: { working_memory: { root: {}, aliases: {} }, pipeline_run_id: "run-2" },
        main_stuff_name: "main_stuff", // server extension field
      })
    );

    const result: DictRunResultExecute = await client.execute({ pipe_code: "p" });

    expect(result.pipe_output.working_memory).toEqual({ root: {}, aliases: {} });
    expect(result.main_stuff_name).toBe("main_stuff"); // extension preserved via index signature
  });

  it("start() → RunResultStart with NO pipe_output (id only)", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(202, { pipeline_run_id: "run-3", state: "STARTED", created_at: "t0" })
    );

    const ack = await client.start({ pipe_code: "p" });

    expect(ack.pipeline_run_id).toBe("run-3");
    expect((ack as Record<string, unknown>).pipe_output).toBeUndefined();
    expect(ack.state).toBe("STARTED"); // extension field preserved via index signature
  });
});

describe("slimmed discovery models, extension-open (T3)", () => {
  it("ModelDeck with only models[] parses", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { models: [{ name: "gpt-4o", type: "llm" }] })
    );
    const deck = await client.models();
    expect(deck.models[0]!.name).toBe("gpt-4o");
  });

  it("ModelDeck extension fields (aliases/waterfalls) survive via the index signature", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, {
        models: [{ name: "gpt-4o", type: "llm" }],
        aliases: { best: "gpt-4o" },
        waterfalls: { cheap: ["a", "b"] },
      })
    );
    const deck = await client.models();
    expect(deck.aliases).toEqual({ best: "gpt-4o" });
    expect(deck.waterfalls).toEqual({ cheap: ["a", "b"] });
  });

  it("VersionInfo parses WITH the implementation extension field", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { protocol_version: "0.6.0", runner_version: "1.2.3", implementation: "pipelex-api" })
    );
    const info = await client.version();
    expect(info.protocol_version).toBe("0.6.0");
    expect(info.runner_version).toBe("1.2.3");
    expect(info.implementation).toBe("pipelex-api"); // extension field preserved
  });

  it("VersionInfo parses WITHOUT implementation (base-only)", async () => {
    const client = makeClient();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { protocol_version: "0.6.0" })
    );
    const info = await client.version();
    expect(info.protocol_version).toBe("0.6.0");
    expect(info.implementation).toBeUndefined();
  });
});

describe("D-B composite merge (MthdsApiClient IS the api runner)", () => {
  it("inherits waitForResult from BaseRunner (no duplicate on the client)", () => {
    // The composite resolves to BaseRunner's single implementation — the client
    // does not redefine it, so the wait/poll behavior can never drift.
    expect(MthdsApiClient.prototype.waitForResult).toBe(BaseRunner.prototype.waitForResult);
  });

  it("overrides startAndWaitForResult (bare-runner blocking-execute fallback)", () => {
    expect(MthdsApiClient.prototype.startAndWaitForResult).not.toBe(
      BaseRunner.prototype.startAndWaitForResult
    );
  });
});
