/**
 * Pipe I/O contracts — exact mirror of `mthds/protocol/pipe_io_contracts.py`.
 *
 * Normative page: "Pipe I/O Contracts" (`mthds/docs/spec/pipe-io-contracts.md`,
 * published on mthds.ai with MTHDS v0.9.0). The artifact is the per-pipe map of
 * declared input and output slots: for each input, the concept it expects, its
 * authored presence marker, how many items it takes and the JSON Schema its
 * content must satisfy; for the output, the concept it produces and how many
 * items that is. It is a projection of the resolved library — everything it
 * states is already in the `.mthds` source — keyed by the fully-qualified
 * `pipe_ref` (`domain_path.pipe_code`), and it rides the validate response as
 * the standard's **recommended extension field** `pipe_io_contracts` (see
 * `ValidationReport` in `./models.ts`).
 *
 * Types only, on purpose: an engine owns its emission gate (`pipelex` validates
 * with the `mthds.protocol` pydantic models, `@pipelex/runtime` with its Zod
 * schema), and this module is what both are pinned to. Wire names are the
 * page's snake_case slot names, verbatim.
 *
 * Strictness: every object here is a **closed shape**. A producer MUST NOT emit
 * a member this version of the standard does not define, and a consumer MAY
 * reject one — an unrecognized member is version drift, and catching it where
 * the payload is parsed beats discovering it three layers later. That is the
 * deliberate opposite of the validate *report*, which stays extension-open:
 * the report is the envelope and grows; the artifact is the contract and does
 * not. Growth happens through the standard, as a minor version.
 */

/**
 * How many items a slot takes, or a pipe resolves to. Read together with
 * `item_count`: `"single"` for `Concept` — and for `Concept[1]`, because the
 * language says a count of one is a way of writing `Concept`; `"variable"` for
 * `Concept[]`; `"fixed"` for `Concept[N]` with N ≥ 2. Closed vocabulary.
 */
export type IOMultiplicity = "single" | "variable" | "fixed";

/**
 * The authored presence marker of an input slot, verbatim and three-valued so
 * that `!` survives: `"plain"` (no marker — the caller must supply the slot),
 * `"optional"` (`?` — the caller may omit it; the pipe handles the absence
 * itself), `"force"` (`!` — the caller must supply it, and the author asserted
 * so explicitly). `plain` and `force` are the same requirement on the caller
 * and differ only in what the author asserted; the distinction is kept on the
 * wire because lint and graph surfaces read it. A consumer that only needs
 * "may this be absent?" answers it as `presence === "optional"`, in exactly
 * one place. Closed vocabulary.
 */
export type PresenceMarker = "plain" | "optional" | "force";

/**
 * One declared input slot — an entry of `PipeIOContract.inputs`, keyed by the
 * authored input name (dotted names included). Closed shape.
 */
export interface PipeInputContract {
  /**
   * The fully-qualified concept the slot expects, with any multiplicity suffix
   * stripped — a `Concept[]` slot names `Concept`. Plurality is stated by
   * `multiplicity`, never here.
   */
  concept_ref: string;
  /**
   * The authored presence marker. Markers may not be combined with
   * multiplicity, so a slot whose `multiplicity` is `"variable"` or `"fixed"`
   * always reports `"plain"`.
   */
  presence: PresenceMarker;
  /** How many items the slot takes. */
  multiplicity: IOMultiplicity;
  /**
   * The exact item count, non-`null` exactly when `multiplicity` is `"fixed"`
   * (and then always greater than one). **Always on the wire**, `null` off the
   * fixed arm — the input-form descriptor makes the opposite choice and omits
   * its `item_count` when it does not apply; the two artifacts differ
   * deliberately, and each states its own rule.
   */
  item_count: number | null;
  /**
   * The JSON Schema the slot's *content* must satisfy — what the caller puts in
   * the slot, not the slot's envelope. A plural slot's schema is an array
   * wrapper, `{ type: "array", items: <the element schema> }`, and on the fixed
   * arm only it also carries `minItems` and `maxItems` equal to `item_count`.
   * Concept identity is read from `concept_ref`, never sniffed out of the
   * schema's shape or annotations.
   */
  json_schema: Record<string, unknown>;
}

/**
 * What one pipe resolves to. Deliberately asymmetric with the input side: an
 * output carries a two-valued `optional` where an input carries a three-valued
 * `presence`, because `!` MUST NOT appear on `output` — a force marker is a
 * use-site assertion about an input, so a three-valued output slot would have
 * an arm nothing can ever produce. No output member carries a schema: the
 * payload a run actually produces is the run's own result. Closed shape.
 */
export interface PipeOutputContract {
  /** The fully-qualified concept the pipe produces, multiplicity suffix stripped. */
  concept_ref: string;
  /**
   * How many items the pipe resolves to — the same three values and the same
   * `[1]`-is-single rule as an input.
   */
  multiplicity: IOMultiplicity;
  /** The exact item count, non-`null` exactly when `multiplicity` is `"fixed"`. */
  item_count: number | null;
  /**
   * `true` when the output is declared optional (`?`): a *successful* run may
   * resolve it as a recorded absence instead of a value — not that the run may
   * fail.
   */
  optional: boolean;
}

/**
 * The contract of one pipe — one entry of `PipeIOContracts`. Both members are
 * required: a pipe with no declared inputs carries `inputs: {}`, a stated fact
 * and never an omitted member. `inputs` is a map and **deliberately contracts
 * no order** — where an ordered view is needed (a form, a rendered signature)
 * the input-form descriptor states it, keyed by the same `pipe_ref` set.
 * Closed shape.
 */
export interface PipeIOContract {
  inputs: Record<string, PipeInputContract>;
  output: PipeOutputContract;
}

/**
 * The artifact: fully-qualified `pipe_ref` (`domain_path.pipe_code`) → contract.
 * Every pipe in the resolved library has an entry, contract-only pipe
 * signatures included; a bare or same-domain-implicit key never appears. The
 * input-form descriptor (`InputForm` in `./input_form.ts`) is keyed by the same
 * set.
 */
export type PipeIOContracts = Record<string, PipeIOContract>;
