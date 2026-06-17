import { describe, expect, it } from "vitest";
import type {
  ValidationResult,
} from "../../../src/protocol/models.js";
import type {
  PipelexValidationResult,
  ValidationErrorCategory,
  ValidationErrorItem,
} from "../../../src/runners/api/models.js";

/**
 * Contract round-trip for the 200-diagnostic `/validate` response union.
 *
 * The discriminated `ValidationResult` (protocol) / `PipelexValidationResult`
 * (Pipelex narrowing) must parse the spec's example bodies (`ValidReport` /
 * `InvalidReport` in docs/specs/pipelex-mthds-protocol.md) and narrow on the one
 * mandatory `is_valid` field — never a status code, never an exception. This pins
 * the TS types against the wire so the SDK can't drift from the contract the
 * conformance HTTP arm verifies on the live server.
 *
 * `JSON.parse(...) as ...` models the wire boundary (the client casts the parsed
 * body to the union); the asserts then exercise the discriminant + typed access.
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
    const result = JSON.parse(VALID_BODY) as PipelexValidationResult;

    expect(result.is_valid).toBe(true);
    if (result.is_valid === false) throw new Error("expected the valid arm");

    // Structural artifacts are typed and present on the valid arm.
    expect(result.bundle_blueprint).toMatchObject({ source: "contracts.mthds" });
    expect(result.validated_pipes[0]).toEqual({
      pipe_ref: "legal_contracts.summarize",
      status: "SUCCESS",
    });
    expect(result.pending_signatures).toEqual([]);
    expect(result.is_runnable).toBe(true);
    expect(result.graph_spec).not.toBeNull();
    expect(result.mthds_contents).toEqual(["<verbatim submitted source>"]);
    expect(result.message).toBe("Validation succeeded.");
  });

  it("parses the InvalidReport example and narrows on is_valid: false", () => {
    const result = JSON.parse(INVALID_BODY) as PipelexValidationResult;

    expect(result.is_valid).toBe(false);
    if (result.is_valid !== false) throw new Error("expected the invalid arm");

    // The invalid arm carries the structured list + runnability facts, no artifacts.
    expect(result.is_runnable).toBe(false);
    expect(result.validation_errors).toHaveLength(1);
    const item = result.validation_errors[0]!;
    expect(item.category).toBe("pipe_validation");
    expect(item.pipe_code).toBe("summarize");
    expect(item.source).toBe("contracts.mthds");
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
    ) as PipelexValidationResult;

    if (result.is_valid !== false) throw new Error("expected the invalid arm");
    const item = result.validation_errors[0]!;
    expect(item.category).toBe("dry_run");
    expect(item.error_type).toBe("DryRunError");
    // A graph-level residual carries no source.
    expect(item.source).toBeUndefined();
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
    ) as PipelexValidationResult;

    if (result.is_valid !== false) throw new Error("expected the invalid arm");
    expect(result.validation_errors).toHaveLength(1);
    expect(result.validation_errors[0]!.category).toBe("blueprint_validation");
    expect(result.validation_errors[0]!.source).toBeUndefined();
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
    ) as PipelexValidationResult;

    expect(result.is_valid).toBe(true);
    if (result.is_valid === false) throw new Error("expected the valid arm");
    // Pending signatures are a runnability fact on the valid arm — not an error item.
    expect(result.pending_signatures).toEqual(["pending_sig.draft_step"]);
    expect(result.is_runnable).toBe(false);
    expect("validation_errors" in result).toBe(false);
  });

  it("narrows the protocol-level ValidationResult union too", () => {
    const result = JSON.parse(INVALID_BODY) as ValidationResult;
    if (result.is_valid !== false) throw new Error("expected the invalid arm");
    // Protocol-level diagnostics expose the neutral category + message.
    expect(result.validation_errors[0]!.category).toBe("pipe_validation");
    expect(result.validation_errors[0]!.message).toContain("unknown concept");
  });

  it("admits dry_run in the closed ValidationErrorCategory vocabulary", () => {
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
