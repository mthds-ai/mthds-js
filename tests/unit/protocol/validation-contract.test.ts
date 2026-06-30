import { describe, expect, it } from "vitest";
import type { ValidationResult } from "../../../src/protocol/models.js";
import type {
  ValidationErrorCategory,
  ValidationErrorItem,
} from "../../../src/runners/api/models.js";

/**
 * Contract round-trip for the 200-diagnostic `/validate` response union — at the
 * standard's neutral `ValidationResult` level (the type `MthdsApiClient.validate()`
 * returns).
 *
 * The discriminated `ValidationResult` must parse the spec's example bodies
 * (`ValidReport` / `InvalidReport` in docs/specs/pipelex-mthds-protocol.md) and
 * narrow on the one mandatory `is_valid` field — never a status code, never an
 * exception. The neutral union guarantees only the standard fields: the valid arm's
 * `is_valid: true` (any structural artifacts ride the extension index signature,
 * preserved but untyped here), the invalid arm's typed `validation_errors[]`
 * (`category` + `message`), `pending_signatures`, `is_runnable`, `message`. The
 * Pipelex-API narrowing that types the structural artifacts and the closed-vocabulary
 * error items is verified in `@pipelex/sdk` (its `PipelexValidationResult`), where it
 * now lives.
 *
 * `JSON.parse(...) as ...` models the wire boundary (the client casts the parsed
 * body to the union); the asserts then exercise the discriminant + neutral access,
 * and `toMatchObject` confirms the server's extension fields survive the parse.
 */

// The spec's `ValidReport` example (abridged), as it arrives on the wire.
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

// The spec's `InvalidReport` example (abridged).
const INVALID_BODY = JSON.stringify({
  is_valid: false,
  validation_errors: [
    {
      category: "pipe_validation",
      error_type: "PipeValidationError",
      message: "Pipe references an unknown concept.",
      pipe_code: "summarize",
      concept_code: "Contractt",
      field_name: "output",
      source: "contracts.mthds",
    },
  ],
  pending_signatures: [],
  is_runnable: false,
  message: "Validation found errors.",
});

describe("validate contract round-trip", () => {
  it("parses the ValidReport example and narrows on is_valid: true", () => {
    const result = JSON.parse(VALID_BODY) as ValidationResult;

    expect(result.is_valid).toBe(true);
    if (result.is_valid === false) throw new Error("expected the valid arm");

    // The neutral arm guarantees only the discriminant; the server's structural
    // artifacts ride the extension index signature — preserved through the parse,
    // but typed `unknown` here (the SDK's `PipelexValidationReport` types them).
    expect(result).toMatchObject({
      is_valid: true,
      bundle_blueprint: { source: "contracts.mthds" },
      validated_pipes: [{ pipe_ref: "legal_contracts.summarize", status: "SUCCESS" }],
      pending_signatures: [],
      is_runnable: true,
      mthds_contents: ["<verbatim submitted source>"],
      message: "Validation succeeded.",
    });
    expect(result.graph_spec).not.toBeNull();
  });

  it("parses the InvalidReport example and narrows on is_valid: false", () => {
    const result = JSON.parse(INVALID_BODY) as ValidationResult;

    expect(result.is_valid).toBe(false);
    if (result.is_valid !== false) throw new Error("expected the invalid arm");

    // The invalid arm carries the typed standard list + runnability facts, no artifacts.
    expect(result.is_runnable).toBe(false);
    expect(result.validation_errors).toHaveLength(1);
    const item = result.validation_errors[0]!;
    expect(item.category).toBe("pipe_validation");
    // Locator fields ride the wire but are not on the neutral `ValidationError`
    // (the SDK's `ValidationErrorItem` types them) — assert their preservation.
    expect(item).toMatchObject({ pipe_code: "summarize", source: "contracts.mthds" });
    expect(result.message).toBe("Validation found errors.");
    expect("bundle_blueprint" in result).toBe(false);
  });

  it("parses a dry_run residual item (the graph-level diagnostic)", () => {
    const result = JSON.parse(
      JSON.stringify({
        is_valid: false,
        validation_errors: [
          { category: "dry_run", error_type: "DryRunError", message: "Dry run failed: ..." },
        ],
        pending_signatures: [],
        is_runnable: false,
        message: "MTHDS validation found errors",
      }),
    ) as ValidationResult;

    if (result.is_valid !== false) throw new Error("expected the invalid arm");
    const item = result.validation_errors[0]!;
    expect(item.category).toBe("dry_run");
    // A graph-level residual carries no source.
    expect(item).toMatchObject({ error_type: "DryRunError" });
    expect("source" in item).toBe(false);
  });

  it("parses a parse-level residual (one source-less blueprint_validation item)", () => {
    const result = JSON.parse(
      JSON.stringify({
        is_valid: false,
        validation_errors: [
          { category: "blueprint_validation", message: "Invalid TOML at line 3." },
        ],
        pending_signatures: [],
        is_runnable: false,
        message: "MTHDS validation found errors",
      }),
    ) as ValidationResult;

    if (result.is_valid !== false) throw new Error("expected the invalid arm");
    expect(result.validation_errors).toHaveLength(1);
    expect(result.validation_errors[0]!.category).toBe("blueprint_validation");
    expect("source" in result.validation_errors[0]!).toBe(false);
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
    expect("validation_errors" in result).toBe(false);
  });

  it("exposes the neutral category + message on the invalid arm", () => {
    const result = JSON.parse(INVALID_BODY) as ValidationResult;
    if (result.is_valid !== false) throw new Error("expected the invalid arm");
    // Protocol-level diagnostics expose the neutral category + message.
    expect(result.validation_errors[0]!.category).toBe("pipe_validation");
    expect(result.validation_errors[0]!.message).toContain("unknown concept");
  });

  it("admits dry_run in the closed ValidationErrorCategory vocabulary", () => {
    // `ValidationErrorCategory` / `ValidationErrorItem` remain in `mthds` because
    // they type the build routes' 422 problem bodies (`ApiResponseError.validationErrors`).
    const categories: ValidationErrorCategory[] = [
      "blueprint_validation",
      "pipe_factory",
      "pipe_validation",
      "dry_run",
    ];
    const item: ValidationErrorItem = { category: "dry_run", message: "Dry run failed." };
    expect(categories).toContain(item.category);
  });
});
