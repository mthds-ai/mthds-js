import type { MTHDSProtocol } from "../protocol/protocol.js";
import type { InputForm } from "../protocol/input_form.js";
import type { OutputForm } from "../protocol/output_form.js";
import type { PipeIOContracts } from "../protocol/pipe_io_contracts.js";
import type { DictPipeOutput } from "./api/models.js";
import type { ProblemItem } from "../problems/types.js";

// ── Runner type ─────────────────────────────────────────────────────

export const Runners = {
  API: "api",
  PIPELEX: "pipelex",
} as const;

export type RunnerType = (typeof Runners)[keyof typeof Runners];

export const RUNNER_NAMES: RunnerType[] = Object.values(Runners);

// ── Crate envelope (`/v1/pipe-io`) ──────────────────────────────────

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
 * The closure selector of the crate-family routes (`/v1/resolve`, `/v1/codegen`,
 * `/v1/pipe-io`), of which this package calls `/v1/pipe-io`.
 *
 * Supply the closure EITHER as inline `files` OR as a `method_ref` — never both.
 * An **address-form** `method_ref` (`github.com/<owner>/<repo>[/<selector>][@<tag>]`)
 * is resolved by the API (pipelex-api >= 0.21.0): the repository is fetched at the
 * tag, the package is located by manifest identity, and its `.mthds` files feed the
 * closure with their real relative paths as per-file sources. The **registry form**
 * (any non-address reference) stays reserved and answers `501` until a method
 * registry exists.
 *
 * The exclusivity is the server's to enforce: neither or both is a request-shape
 * `422`, which this client surfaces as an `ApiResponseError` rather than checking it
 * first.
 */
export interface CrateRequestBase {
  files?: MthdsFileItem[];
  method_ref?: string;
}

// ── Request types ───────────────────────────────────────────────────

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
   * input `422`s typed by {@link PIPE_SELECTION_CODES}, not malformed requests.
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
 * The codes of a refused pipe selection: the selected pipe is not in the method, the selection
 * matches several pipes, or the request selects none and the method gives no main pipe. Each is
 * the caller's to fix, by selecting another pipe. Branch on these codes, never on the message:
 * the problem's parameters list the candidates.
 */
export const PIPE_SELECTION_CODES: ReadonlySet<string> = new Set([
  "request.pipe_not_found",
  "request.pipe_ambiguous",
  "request.pipe_unspecified",
]);

/** Request for `PipelexRunner.checkModel` — a LOCAL CLI capability only (no API route). */
export interface CheckModelRequest {
  reference: string;
  type: string;
  format?: string;
}

// ── Response types ──────────────────────────────────────────────────

/**
 * The `is_valid: false` arm of `/v1/pipe-io`, which the crate-family routes share.
 *
 * They follow `/validate`'s discipline: an unresolvable closure is
 * the *successful product* of the call (the request was well-formed, the library
 * was not), so it rides a **200** discriminated on `is_valid` — never a 4xx.
 * Only a no-verdict condition (an unknown `pipe_ref`, auth, a server fault)
 * throws. Branch on `is_valid`, never on the transport. Its faults are problem
 * items, as the invalid arm of `/validate` lists them.
 */
export interface CrateInvalidReport {
  is_valid: false;
  /** One problem item per fault, non-empty. */
  errors: ProblemItem[];
  /** Advisory findings in the same item schema. */
  warnings?: ProblemItem[];
  message?: string;
  [extension: string]: unknown;
}

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
// (execute / start / validate / models / version) plus `health`. The durable
// run-lifecycle (poll a run by id) is NOT part of this interface — it now lives
// in the Pipelex runtime SDK (`@pipelex/sdk`).

export interface Runner extends MTHDSProtocol<DictPipeOutput> {
  readonly type: RunnerType;

  // Health — origin-level `/health` on the API runner, local doctor on pipelex.
  health(): Promise<Record<string, unknown>>;
}
