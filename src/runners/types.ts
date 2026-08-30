import type { MTHDSProtocol } from "../protocol/protocol.js";
import type { DictPipeOutput, ValidationErrorItem } from "./api/models.js";

// ── Runner type ─────────────────────────────────────────────────────

export const Runners = {
  API: "api",
  PIPELEX: "pipelex",
} as const;

export type RunnerType = (typeof Runners)[keyof typeof Runners];

export const RUNNER_NAMES: RunnerType[] = Object.values(Runners);

// ── Shared enums / literals ─────────────────────────────────────────

export type ConceptRepresentationFormat = "json" | "python" | "schema";

/** Encoding of a `/v1/build/inputs` template. Decides which field carries it back. */
export type InputsTemplateFormat = "json" | "toml";

// ── Shared build envelope (`/v1/build/*`) ───────────────────────────

/**
 * One MTHDS file in a build closure. `source` is an optional provenance label
 * (a filename, a URI) that the server threads onto every diagnostic it raises
 * from this file, so an invalid verdict can point at the file that caused it.
 */
export interface MthdsFileItem {
  content: string;
  source?: string;
}

/**
 * The closure + pipe selector every `/v1/build/*` route shares.
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
 */
export interface BuildRequestBase {
  files?: MthdsFileItem[];
  method_ref?: string;
  /**
   * The pipe to project, as a QUALIFIED `domain.pipe_code` ref. Omit it to default
   * the way a run by address does: to the fetched package manifest's `main_pipe` on
   * a `method_ref` request, else to the closure's declared `main_pipe` — which fails
   * (422) when the closure declares none, or declares several across its domains.
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

export interface BuildOutputRequest extends BuildRequestBase {
  /** `schema` (default) and `json` put a parsed object in `output`; `python` puts source in `output_python`. */
  format?: ConceptRepresentationFormat;
}

export interface BuildRunnerRequest extends BuildRequestBase {
  /**
   * Accept unresolved pipe signatures as pending rather than invalid. Alone
   * among the build routes this one still runs the dry-run sweep, and the flag
   * only ever parameterized that sweep.
   *
   * **API runner only.** `pipelex build runner` exposes no `--allow-signatures`
   * flag, so the local runner has nothing to forward and REJECTS the request rather
   * than silently ignoring the flag — a dropped `allow_signatures` would make the
   * same request mean two different things depending on which runner served it.
   */
  allow_signatures?: boolean;
}

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
 * The `is_valid: false` arm shared by every `/v1/build/*` route.
 *
 * The build routes follow `/validate`'s discipline: an unresolvable closure is
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

/** Fields the valid arm of every `/v1/build/*` route carries. */
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
 * The `/v1/build/output` valid arm. Same two-field split as the inputs template,
 * for the same reason: `schema` and `json` are objects, `python` is source text —
 * and so it is a discriminated union for the same reason too.
 */
interface BuildOutputObjectReport extends BuildValidReportBase {
  format: "schema" | "json";
  output: Record<string, unknown>;
  output_python?: never;
}

interface BuildOutputPythonReport extends BuildValidReportBase {
  format: "python";
  output?: never;
  output_python: string;
}

export type BuildOutputValidReport = BuildOutputObjectReport | BuildOutputPythonReport;

export type BuildOutputResponse = BuildOutputValidReport | CrateInvalidReport;

/** One stamped generated file in the structures projection. */
export interface GeneratedArtifact {
  path: string;
  content: string;
}

/**
 * The typed-structures projection the runner script imports from. Write
 * `artifacts` and `lock` (as `lock_filename`) under `directory`, relative to the
 * runner script, and the returned `python_code` runs against them.
 */
export interface RunnerStructures {
  directory: string;
  artifacts: GeneratedArtifact[];
  lock: string;
  lock_filename: string;
}

export interface BuildRunnerValidReport extends BuildValidReportBase {
  python_code: string;
  /**
   * The stamped structures projection. The API always sends one. The LOCAL runner
   * only can when the installed pipelex ships the codegen engine that writes the
   * lock — so treat it as optional and skip writing the projection when it's absent;
   * `python_code` is valid either way.
   */
  structures?: RunnerStructures;
}

export type BuildRunnerResponse = BuildRunnerValidReport | CrateInvalidReport;

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
  buildOutput(request: BuildOutputRequest): Promise<BuildOutputResponse>;
  buildRunner(request: BuildRunnerRequest): Promise<BuildRunnerResponse>;
  concept(request: ConceptRequest): Promise<ConceptResponse>;
  pipeSpec(request: PipeSpecRequest): Promise<PipeSpecResponse>;
}
