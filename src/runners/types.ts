import type { MTHDSProtocol } from "../protocol/protocol.js";
import type { InputForm } from "../protocol/input_form.js";
import type { OutputForm } from "../protocol/output_form.js";
import type { PipeIOContracts } from "../protocol/pipe_io_contracts.js";
import type { DictPipeOutput, ValidationErrorItem } from "./api/models.js";

// ── Runner type ─────────────────────────────────────────────────────

export const Runners = {
  API: "api",
  PIPELEX: "pipelex",
} as const;

export type RunnerType = (typeof Runners)[keyof typeof Runners];

export const RUNNER_NAMES: RunnerType[] = Object.values(Runners);

// ── Shared enums / literals ─────────────────────────────────────────

/** Encoding of a `/v1/build/inputs` template. Decides which field carries it back. */
export type InputsTemplateFormat = "json" | "toml";

// ── Shared crate envelope (`/v1/build/*`, `/v1/pipe-io`) ────────────

/**
 * One MTHDS file in a closure. `source` is an optional provenance label
 * (a filename, a URI) that the server threads onto every diagnostic it raises
 * from this file, so an invalid verdict can point at the file that caused it.
 */
export interface MthdsFileItem {
  content: string;
  source?: string;
}

/**
 * The closure selector every crate-family route shares — `/v1/build/*` and
 * `/v1/pipe-io`.
 *
 * Supply the closure EITHER as inline `files` OR as a `method_ref` — never both.
 * An **address-form** `method_ref` (`github.com/<owner>/<repo>[/<selector>][@<tag>]`)
 * is resolved by the API (pipelex-api >= 0.21.0): the repository is fetched at the
 * tag, the package is located by manifest identity, and its `.mthds` files feed the
 * closure with their real relative paths as per-file sources. The **registry form**
 * (any non-address reference) stays reserved and answers `501` until a method
 * registry exists.
 *
 * Either form is API-only. The local `pipelex` runner materializes its closure from
 * `files` on disk and rejects a `method_ref` outright rather than fetching one.
 *
 * The exclusivity is the server's to enforce: neither or both is a request-shape
 * `422`, which this client surfaces as an `ApiResponseError` rather than checking it
 * first.
 */
export interface CrateRequestBase {
  files?: MthdsFileItem[];
  method_ref?: string;
}

/** The closure + pipe selector of the per-pipe `/v1/build/inputs` route. */
export interface BuildRequestBase extends CrateRequestBase {
  /**
   * The pipe to project, as a QUALIFIED `domain.pipe_code` ref. Omit it to default
   * the way a run by address does: to the fetched package manifest's `main_pipe` on
   * a `method_ref` request, else to the closure's declared `main_pipe` — which fails
   * (422) when the closure declares none, or declares several across its domains.
   *
   * That manifest arm needs a server NEWER than pipelex-api 0.21.0. 0.21.0 resolves
   * the address form but drops the manifest on the tooling path, falling straight
   * through to the closure's own domain-level declarations — so a package whose
   * `METHODS.toml` names an entry pipe that its domains do not answers `422` there.
   * Send `pipe_ref` explicitly to be portable across both.
   */
  pipe_ref?: string;
}

// ── Request types ───────────────────────────────────────────────────

export interface BuildInputsRequest extends BuildRequestBase {
  /** `json` (default) puts the parsed template in `inputs`; `toml` puts raw text in `inputs_toml`. */
  format?: InputsTemplateFormat;
  /** Emit the ceremonial `{concept, content}` envelope per input. Defaults to the light shape. */
  explicit?: boolean;
}

/**
 * `POST /v1/pipe-io` request — a method's three I/O artifacts, with no dry run.
 *
 * The closure selector is the crate envelope's `files` XOR `method_ref`, plus a
 * third selector a hosted API accepts: the catalog id `method_id`, which the
 * hosted platform resolves against the caller's organization and forwards as
 * `files` before the runner sees the request. It is posted as given; a bare runner
 * has no catalog and refuses a request whose only selector is a `method_id`.
 * Exactly one of the three, and the server enforces it.
 *
 * There is no `views` field: the valid arm always carries all three artifacts.
 */
export interface PipeIORequest extends CrateRequestBase {
  /** A stored method's catalog id (`mt_…`): resolved by a hosted API only. */
  method_id?: string;
  /**
   * The pipe to describe, as a QUALIFIED `domain.pipe_code` ref. Omit it and the
   * server's selection chain decides: a fetched package's manifest `main_pipe`,
   * else the closure's single `main_pipe` declaration. A ref that names no pipe,
   * and (without `all_pipes`) a chain that finds no entry pipe or several, are
   * input `422`s typed by {@link PIPE_SELECTION_ERROR_TYPES}, not malformed requests.
   */
  pipe_ref?: string;
  /**
   * Describe every pipe the closure loads instead of the selected one. The maps
   * are then keyed by every pipe, and the route never refuses for want of an entry
   * pipe. Defaults to `false` server-side.
   */
  all_pipes?: boolean;
  /**
   * Echo the resolved closure's `.mthds` files on the valid arm as `files`.
   * Defaults to `false` server-side, and the field is then absent from the answer.
   */
  include_files?: boolean;
}

/**
 * The `error_type` values a `/v1/pipe-io` (or per-pipe route) `422` carries when
 * the request's pipe SELECTION failed, as opposed to its shape:
 * `EntryPipeNotFoundError` for a `pipe_ref` that names no pipe, a manifest
 * `main_pipe` the closure lacks, or no `pipe_ref` and no `main_pipe`;
 * `EntryPipeAmbiguousError` for a bare code that matches pipes in several domains,
 * or no `pipe_ref` and several `main_pipe` declarations. A malformed request keeps
 * `ValidationError`. Branch on these two strings, never on the message, which is
 * the only place the runner lists the candidates.
 */
export const PIPE_SELECTION_ERROR_TYPES: ReadonlySet<string> = new Set([
  "EntryPipeNotFoundError",
  "EntryPipeAmbiguousError",
]);

export interface ConceptRequest {
  spec: Record<string, unknown>;
}

export interface PipeSpecRequest {
  pipe_type: string;
  spec: Record<string, unknown>;
}

/** Request for `PipelexRunner.checkModel` — a LOCAL CLI capability only (no API route). */
export interface CheckModelRequest {
  reference: string;
  type: string;
  format?: string;
}

// ── Response types ──────────────────────────────────────────────────

/**
 * The `is_valid: false` arm shared by the per-pipe build route `/v1/build/inputs`
 * and `/v1/pipe-io`. The spec-to-TOML routes
 * (`/v1/build/concept`, `/v1/build/pipe-spec`) have no such arm: they refuse an
 * invalid spec with a 422.
 *
 * These routes follow `/validate`'s discipline: an unresolvable closure is
 * the *successful product* of the call (the request was well-formed, the library
 * was not), so it rides a **200** discriminated on `is_valid` — never a 4xx.
 * Only a no-verdict condition (an unknown `pipe_ref`, auth, a server fault)
 * throws. Branch on `is_valid`, never on the transport.
 */
export interface CrateInvalidReport {
  is_valid: false;
  validation_errors: ValidationErrorItem[];
  message: string;
}

/** Fields the `/v1/build/inputs` valid arm carries beside its template. */
interface BuildValidReportBase {
  is_valid: true;
  /** The qualified pipe that was projected — the RESOLVED selector, always `domain.pipe_code`. */
  pipe_ref: string;
  /** The `pipe_ref` as submitted. Absent when it was omitted and defaulted to `main_pipe`. */
  requested_pipe_ref?: string;
  message: string;
}

/**
 * The `/v1/build/inputs` valid arm. The template rides ONE of two fields, chosen
 * by `format`: `inputs` (a parsed object) for `json`, `inputs_toml` (raw text)
 * for `toml`. TOML cannot be carried as a parsed object without losing what makes
 * it worth asking for — its concept comments and key order — so the two are
 * separate fields and the unused one is absent from the body entirely.
 *
 * That "absent entirely" is why this is a union rather than one interface with two
 * optional fields: `format` is a real discriminant, so narrowing on it hands you the
 * field it selected as REQUIRED and makes the other one statically unreachable.
 */
interface BuildInputsJsonReport extends BuildValidReportBase {
  format: "json";
  explicit: boolean;
  inputs: Record<string, unknown>;
  inputs_toml?: never;
}

interface BuildInputsTomlReport extends BuildValidReportBase {
  format: "toml";
  explicit: boolean;
  inputs?: never;
  inputs_toml: string;
}

export type BuildInputsValidReport = BuildInputsJsonReport | BuildInputsTomlReport;

export type BuildInputsResponse = BuildInputsValidReport | CrateInvalidReport;

/**
 * The `/v1/pipe-io` valid arm — a method's three I/O artifacts, with the selection
 * and the runnability facts beside them.
 *
 * The artifacts are the MTHDS standard's own types from `mthds/protocol`, carried
 * here by a Pipelex API extension route. The three maps share one key set: the
 * resolved `pipe_ref` alone by default, every pipe the closure loads under
 * `all_pipes`. `is_valid: true` means the closure parsed, loaded and passed static
 * validation; no dry run ran, so that verdict stays `validate`'s.
 */
export interface PipeIOValidReport {
  is_valid: true;
  /**
   * The qualified ref the selection resolved, read off the resolved pipe and never
   * echoed from the request. `null` only under `all_pipes` when no pipe was
   * requested and the method declares no single entry pipe.
   */
  pipe_ref: string | null;
  /** The standard's pipe I/O contracts, keyed by qualified `pipe_ref`. */
  pipe_io_contracts: PipeIOContracts;
  /** The standard's input-form descriptors, keyed by qualified `pipe_ref`. */
  input_form: InputForm;
  /** The standard's output-form descriptors, keyed by qualified `pipe_ref`. */
  output_form: OutputForm;
  /**
   * The method's own entry pipe: the selection chain without the request's
   * `pipe_ref`. A request that omits `pipe_ref` answers `pipe_ref === default_pipe_ref`;
   * a stated `null` when the chain finds none or several. Not `validate`'s field of
   * the same name, which is the run default.
   */
  default_pipe_ref: string | null;
  /** Qualified refs of every pipe of the closure still declared as a signature. */
  pending_signatures: string[];
  /** `pending_signatures` is empty. No dry run backs it. */
  is_runnable: boolean;
  /**
   * The resolved closure's `.mthds` files, in the request's `files` shape. Present
   * only when the request passed `include_files: true`.
   */
  files?: MthdsFileItem[];
}

/** The `POST /v1/pipe-io` 200 response — pattern-match `is_valid` before reading the arm. */
export type PipeIOResponse = PipeIOValidReport | CrateInvalidReport;

export interface ConceptResponse {
  success: boolean;
  concept_code: string;
  toml: string;
}

export interface PipeSpecResponse {
  success: boolean;
  pipe_code: string;
  pipe_type: string;
  toml: string;
}

/** Response of `PipelexRunner.checkModel` — a LOCAL CLI capability only (no API route). */
export interface CheckModelResponse {
  success: boolean;
  valid: boolean;
  reference: string;
  suggestions?: string[];
  [key: string]: unknown;
}

// ── Runner interface ────────────────────────────────────────────────
// Every runtime (API, local pipelex CLI, …) implements the MTHDS Protocol
// (execute / start / validate / models / version) plus the Pipelex build
// extensions. The durable run-lifecycle (poll a run by id) is NOT part of this
// interface — it now lives in the Pipelex runtime SDK (`@pipelex/sdk`).

export interface Runner extends MTHDSProtocol<DictPipeOutput> {
  readonly type: RunnerType;

  // Health — origin-level `/health` on the API runner, local doctor on pipelex.
  health(): Promise<Record<string, unknown>>;

  // Build extensions (Pipelex API layer 2 — `/v1/build/*`). Each returns a
  // discriminated 200 verdict: pattern-match `is_valid` before reading the arm.
  buildInputs(request: BuildInputsRequest): Promise<BuildInputsResponse>;
  concept(request: ConceptRequest): Promise<ConceptResponse>;
  pipeSpec(request: PipeSpecRequest): Promise<PipeSpecResponse>;
}
