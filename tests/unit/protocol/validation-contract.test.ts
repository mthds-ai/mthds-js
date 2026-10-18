import { describe, expect, it } from "vitest";
import type { ValidationResult } from "../../../src/protocol/models.js";
import { isProblemItem } from "../../../src/problems/read.js";
import { itemDomain } from "../../../src/problems/reading.js";
import type { ProblemItem } from "../../../src/problems/types.js";

/**
 * Contract round-trip for the 200-diagnostic `/validate` response union — at the
 * standard's neutral `ValidationResult` level (the type `MthdsApiClient.validate()`
 * returns).
 *
 * The discriminated `ValidationResult` must parse the protocol's verdict bodies
 * (`ValidationReport` / `InvalidValidationReport` in mthds/docs/spec/protocol.md,
 * "Validate") and narrow on the one mandatory `is_valid` field — never a status code,
 * never an exception. The neutral union guarantees only the standard fields: the valid
 * arm's `is_valid: true` and runnability facts (any structural artifacts ride the
 * extension index signature, preserved but untyped here), the invalid arm's non-empty
 * `errors[]` of problem items, each with its own `code`, `detail`, `params` and
 * `location`, `is_runnable: false` and an optional `message`, and `warnings[]` in the
 * same item schema on either arm.
 *
 * `JSON.parse(...) as ...` models the wire boundary (the client casts the parsed
 * body to the union once its shape check passed); the asserts then exercise the
 * discriminant and neutral access, and `toMatchObject` confirms the server's
 * extension fields survive the parse.
 */

// A valid verdict, as it arrives on the wire.
const VALID_BODY = JSON.stringify({
  is_valid: true,
  bundle_blueprint: { source: "contracts.mthds", domain: "legal_contracts" },
  pipe_io_contracts: {
    "legal_contracts.summarize": {
      inputs: { contract: { concept_ref: "legal_contracts.Contract", json_schema: {} } },
      output: { concept_ref: "legal_contracts.Summary", multiplicity: "single" },
    },
  },
  validated_pipes: [{ pipe_ref: "legal_contracts.summarize", status: "SUCCESS" }],
  pending_signatures: [],
  is_runnable: true,
  graph_spec: { nodes: [], edges: [] },
  mthds_contents: ["<verbatim submitted source>"],
  message: "Validation succeeded.",
});

// An invalid verdict: one problem item per fault.
const INVALID_BODY = JSON.stringify({
  is_valid: false,
  errors: [
    {
      code: "method.concept_unresolved",
      detail: "The output concept 'Contractt' of pipe 'summarize' is not declared.",
      params: { concept_ref: "legal_contracts.Contractt" },
      location: { pipe: "summarize", field: "output", file: "contracts.mthds", line: 7 },
      suggestions: ["Contract"],
      rule_version: 2,
    },
  ],
  warnings: [
    {
      code: "method.input_unused",
      detail: "The input 'notes' of pipe 'summarize' is never read.",
      location: { pipe: "summarize", input: "notes" },
    },
  ],
  pending_signatures: [],
  is_runnable: false,
  message: "Validation found errors.",
});

describe("validate contract round-trip", () => {
  it("parses a valid verdict and narrows on is_valid: true", () => {
    const result = JSON.parse(VALID_BODY) as ValidationResult;

    expect(result.is_valid).toBe(true);
    if (result.is_valid === false) throw new Error("expected the valid arm");

    // The neutral arm guarantees the discriminant and the runnability facts; the
    // server's structural artifacts ride the extension index signature — preserved
    // through the parse, but typed `unknown` here.
    expect(result.is_runnable).toBe(true);
    expect(result.pending_signatures).toEqual([]);
    expect(result).toMatchObject({
      bundle_blueprint: { source: "contracts.mthds" },
      validated_pipes: [{ pipe_ref: "legal_contracts.summarize", status: "SUCCESS" }],
      mthds_contents: ["<verbatim submitted source>"],
      message: "Validation succeeded.",
    });
    expect(result.graph_spec).not.toBeNull();
  });

  it("parses an invalid verdict and narrows on is_valid: false", () => {
    const result = JSON.parse(INVALID_BODY) as ValidationResult;

    expect(result.is_valid).toBe(false);
    if (result.is_valid !== false) throw new Error("expected the invalid arm");

    // The invalid arm carries its problem items and runnability facts, no artifacts.
    expect(result.is_runnable).toBe(false);
    expect(result.errors).toHaveLength(1);
    const item: ProblemItem = result.errors[0]!;
    expect(isProblemItem(item)).toBe(true);
    expect(item.code).toBe("method.concept_unresolved");
    expect(item.location).toEqual({
      pipe: "summarize",
      field: "output",
      file: "contracts.mthds",
      line: 7,
    });
    expect(item.suggestions).toEqual(["Contract"]);
    // A member of the runner's own rides the item and survives the parse.
    expect(item).toMatchObject({ rule_version: 2 });
    expect(result.message).toBe("Validation found errors.");
    expect("bundle_blueprint" in result).toBe(false);
  });

  it("reads an item's domain from its code, since an item carries no verdict", () => {
    const result = JSON.parse(INVALID_BODY) as ValidationResult;
    if (result.is_valid !== false) throw new Error("expected the invalid arm");
    expect("domain" in result.errors[0]!).toBe(false);
    expect(itemDomain(result.errors[0]!)).toBe("method");
  });

  it("carries warnings in the same item schema, which do not make the verdict", () => {
    const result = JSON.parse(INVALID_BODY) as ValidationResult;
    if (result.is_valid !== false) throw new Error("expected the invalid arm");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings!.every(isProblemItem)).toBe(true);
    expect(result.warnings![0]!.code).toBe("method.input_unused");
  });

  it("parses an item that names no location (a parse-level fault)", () => {
    const result = JSON.parse(
      JSON.stringify({
        is_valid: false,
        errors: [
          {
            code: "method.syntax",
            detail: "Invalid TOML at line 3.",
            params: { finding: "Invalid TOML at line 3." },
          },
        ],
        is_runnable: false,
        message: "MTHDS validation found errors",
      }),
    ) as ValidationResult;

    if (result.is_valid !== false) throw new Error("expected the invalid arm");
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe("method.syntax");
    expect("location" in result.errors[0]!).toBe(false);
  });

  it("reports a strict-signature bundle as runnable: false, never an error", () => {
    const result = JSON.parse(
      JSON.stringify({
        is_valid: true,
        bundle_blueprint: { source: "draft.mthds" },
        pipe_io_contracts: {},
        validated_pipes: [],
        pending_signatures: ["pending_sig.draft_step"],
        is_runnable: false,
        graph_spec: null,
        mthds_contents: ["..."],
        message: "Validation succeeded.",
      }),
    ) as ValidationResult;

    expect(result.is_valid).toBe(true);
    if (result.is_valid === false) throw new Error("expected the valid arm");
    // Pending signatures are a runnability fact on the valid arm — not an error item.
    expect(result).toMatchObject({
      pending_signatures: ["pending_sig.draft_step"],
      is_runnable: false,
    });
    expect("errors" in result).toBe(false);
  });

  it("refuses an item of the shape before the error registry as no problem item", () => {
    // `category` and `message` were the items of protocol 1.x; an item now names a code.
    expect(isProblemItem({ category: "pipe_validation", message: "boom" })).toBe(false);
    expect(isProblemItem({ code: "method.syntax", detail: "boom" })).toBe(true);
  });
});
