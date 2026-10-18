/**
 * The closed lists of the MTHDS Protocol's problem document (mthds/docs/spec/protocol.md,
 * "Errors"), as its OpenAPI document enumerates them: who must act (`domain`), whether a repeat
 * can succeed (`retry`), what to do next (`next_step.kind`), whether a suggested fix may be
 * applied without asking (`safety`) and the operations a fix is made of.
 *
 * These lists are the emitter's contract. A reader widens each field to any string and reads a
 * value it does not know by the fallback rules of `reading.ts`, so the problem types of this
 * module type those fields as `string` and these unions are what the readers return.
 */

/** Who must act on a problem: the caller, the method's author, the account's owner, whoever runs the runtime, or nobody beforehand. */
export const PROBLEM_DOMAINS = ["input", "method", "account", "operator", "runtime"] as const;
export type ProblemDomain = (typeof PROBLEM_DOMAINS)[number];

/**
 * Whether repeating the operation that produced a problem can succeed: `no`, `yes` (after
 * `retry_after` seconds when given), or `outcome_unknown`, the operation may already have taken
 * effect, so a client never repeats it automatically.
 */
export const RETRY_VERDICTS = ["no", "yes", "outcome_unknown"] as const;
export type RetryVerdict = (typeof RETRY_VERDICTS)[number];

/** The closed list of next steps, as the table under "Next steps" on the protocol page defines them. */
export const STEP_KINDS = [
  "retry",
  "wait",
  "read_run",
  "refresh",
  "change_input",
  "change_method",
  "change_model",
  "check_credentials",
  "request_access",
  "check_account",
  "fix_configuration",
  "upgrade",
  "contact_owner",
  "report",
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** Whether a suggested fix may be applied without asking anyone (`safe`) or needs a confirmation (`unsafe`). */
export const FIX_SAFETIES = ["safe", "unsafe"] as const;
export type FixSafety = (typeof FIX_SAFETIES)[number];

/** The operation kinds a suggested fix may hold; any other kind is an `UnknownFixOp`. */
export const FIX_OP_KINDS = [
  "set_key",
  "ensure_table",
  "delete_key",
  "delete_table",
  "rename_table_key",
  "move_key",
  "remap_value",
] as const;
export type FixOpKind = (typeof FIX_OP_KINDS)[number];

/** How a registry entry is raised: as a runner's problem, by a client itself, or as a validation warning. */
export type RaisedAs = "problem" | "client" | "warning";

/**
 * The types a registry parameter takes (mthds/docs/spec/error-registry.md, "Parameters"). A
 * `list` names the type of its items.
 */
export type RegistryParamType =
  | "identifier"
  | "enum"
  | "caller_text"
  | "integer"
  | "seconds"
  | "bytes"
  | "sha256"
  | "list";
