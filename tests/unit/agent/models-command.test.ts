import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerApiRunnerCommands } from "../../../src/agent/commands/api-commands.js";
import { MODEL_CATEGORIES } from "../../../src/protocol/models.js";
import { MthdsApiClient } from "../../../src/runners/api/client.js";

// `mthds-agent models --runner api` lists the deck the runner routes to, filtered by
// one of the protocol's model categories. The categories it accepts and names are
// the protocol's own, read from `MODEL_CATEGORIES`, so `judgment` is one of them.

const BASE_URL = "http://localhost:8081";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeProgram(): Command {
  const program = new Command().enablePositionalOptions().exitOverride();
  registerApiRunnerCommands(
    program,
    () => new MthdsApiClient({ baseUrl: BASE_URL, apiKey: "test" }),
  );
  return program;
}

function typeOptionHelp(program: Command, commandName: string): string {
  const command = program.commands.find((cmd) => cmd.name() === commandName);
  const option = command?.options.find((opt) => opt.long === "--type");
  return option?.description ?? "";
}

describe("mthds-agent models on the API runner", () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // agentError ends in process.exit(1); throw a sentinel so the test can catch it.
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("__exit__");
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts --type judgment and filters the deck by it", async () => {
    const deck = { models: [{ name: "judge-small", type: "judgment" }], aliases: {} };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, deck));

    await makeProgram().parseAsync(["models", "--type", "judgment"], { from: "user" });

    expect(fetchSpy.mock.calls[0]![0]).toBe(`${BASE_URL}/v1/models?type=judgment`);
    expect(JSON.parse(String(stdoutSpy.mock.calls[0]![0]))).toEqual(deck);
  });

  it("refuses a category the protocol does not define, naming every one it does", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      makeProgram().parseAsync(["models", "--type", "lmm"], { from: "user" }),
    ).rejects.toThrow("__exit__");

    expect(fetchSpy).not.toHaveBeenCalled();
    const envelope = JSON.parse(String(stderrSpy.mock.calls[0]![0])) as Record<string, unknown>;
    expect(envelope).toMatchObject({ error: true, error_type: "ArgumentError" });
    expect(envelope.message).toBe(`--type must be one of: ${MODEL_CATEGORIES.join(", ")}.`);
  });

  it("names every protocol category in the --type help of models and check-model", () => {
    const program = makeProgram();
    for (const commandName of ["models", "check-model"]) {
      const help = typeOptionHelp(program, commandName);
      for (const category of MODEL_CATEGORIES) {
        expect(help).toContain(category);
      }
    }
  });
});
