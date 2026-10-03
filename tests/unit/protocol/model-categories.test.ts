import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { MODEL_CATEGORIES, MTHDS_PROTOCOL_VERSION } from "../../../src/protocol/models.js";
import type { ModelCategory, ModelDeck, ModelInfo } from "../../../src/protocol/models.js";
import { MthdsApiClient } from "../../../src/runners/api/client.js";

/**
 * The protocol's model categories, as MTHDS Protocol 0.7.0 states them
 * (`mthds/docs/spec/protocol.md`, "Discovery"): a category is a settings family
 * of the language, `judgment` is the fifth, and a client reading a model list
 * MUST NOT fail it because an entry carries a category it does not recognize; it
 * keeps that entry with its raw value or leaves it out. This SDK keeps it.
 */

const BASE_URL = "http://localhost:8081";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MODEL_CATEGORIES", () => {
  it("lists the protocol's categories, judgment among them, in the protocol's order", () => {
    expect(MODEL_CATEGORIES).toEqual(["llm", "extract", "img_gen", "search", "judgment"]);
  });

  it("is the tuple ModelCategory is derived from, so the list and the type cannot drift", () => {
    expectTypeOf<ModelCategory>().toEqualTypeOf<(typeof MODEL_CATEGORIES)[number]>();
    expectTypeOf<ModelCategory>().toEqualTypeOf<
      "llm" | "extract" | "img_gen" | "search" | "judgment"
    >();
  });

  it("keeps ModelCategory closed while a deck entry's type stays open", () => {
    const judgment: ModelCategory = "judgment";
    // @ts-expect-error -- a category the protocol does not define is not a ModelCategory
    const invented: ModelCategory = "vendor_family";
    const entry: ModelInfo = { name: "future-model", type: "vendor_family" };
    expect([judgment, invented, entry.type]).toEqual([
      "judgment",
      "vendor_family",
      "vendor_family",
    ]);
  });
});

describe("MTHDS_PROTOCOL_VERSION", () => {
  it("is the protocol release that defines the judgment category", () => {
    expect(MTHDS_PROTOCOL_VERSION).toBe("0.7.0");
  });
});

describe("MthdsApiClient.models reads any category", () => {
  it("returns a deck carrying judgment and an unknown category unchanged", async () => {
    const served: ModelDeck = {
      models: [
        { name: "gpt-4o", type: "llm" },
        { name: "judge-small", type: "judgment" },
        { name: "future-model", type: "vendor_family" },
      ],
      aliases: { llm: { best: "gpt-4o" }, vendor_family: { default: "future-model" } },
      waterfalls: {},
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(200, served));
    const client = new MthdsApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });

    const deck = await client.models();

    expect(deck).toEqual(served);
    expect(deck.models.map((entry) => entry.type)).toEqual(["llm", "judgment", "vendor_family"]);
  });

  it("sends the judgment filter as ?type=judgment", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse(200, { models: [{ name: "judge-small", type: "judgment" }] }),
      );
    const client = new MthdsApiClient({ baseUrl: BASE_URL, apiKey: "test-token" });

    await client.models("judgment");

    expect(fetchSpy.mock.calls[0]![0]).toBe(`${BASE_URL}/v1/models?type=judgment`);
  });
});
