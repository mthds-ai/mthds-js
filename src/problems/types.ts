/**
 * The problem document of the MTHDS Protocol (mthds/docs/spec/protocol.md, "Errors"): an RFC 9457
 * document carrying the MTHDS core members, the item a problem with several faults lists in
 * `errors` and a validate verdict lists in `errors` and `warnings`, and the suggested fix an item
 * may carry. These are the reader's types: every object is open to members it does not declare,
 * which are kept as received, and every enumerated field is widened to `string`, as the protocol's
 * rules for readers require; `reading.ts` reads a value the closed lists do not hold.
 *
 * Also here, the shape of one entry of the MTHDS core error registry, which the generated module
 * `registry.generated.ts` holds for every core code.
 */

import type {
  RaisedAs,
  RegistryParamType,
  RetryVerdict,
  ProblemDomain,
  StepKind,
} from "./vocabulary.js";

/** What the reader should do next, aimed at whoever reads the problem. */
export interface NextStep {
  /** A step kind of the protocol's closed list (`STEP_KINDS`), or one this reader does not know. */
  kind: string;
  /** The step, in one sentence a person can read. */
  detail: string;
  [member: string]: unknown;
}

/** Where the error happened, in the method, the request or the run. Every member is optional. */
export interface ProblemLocation {
  /** The failing pipe's code. */
  pipe?: string;
  /** The pipe codes from the run's main pipe down to the failing one. */
  path?: string[];
  /** The name of the input the error concerns. */
  input?: string;
  /** A dotted path inside an input or a request body. */
  field?: string;
  /** The index of the batch item that failed, counted from 0. */
  item?: number;
  /** The attempt that failed, counted from 1. */
  attempt?: number;
  /** The tree path of the method's file the error is in. */
  file?: string;
  /** The line in `file`, counted from 1. */
  line?: number;
  /** The column in `line`, counted from 1. */
  column?: number;
  [member: string]: unknown;
}

/**
 * The typed facts a problem's sentences were written from, as its code declares them. The
 * registry types each code's parameters (`ProblemParamsByCode`); the protocol itself types the one
 * a client relies on by shape, `missing_blobs`.
 */
export interface ProblemParams {
  /** Carried by `request.blobs_missing`: every hash of the request the runner does not hold. */
  missing_blobs?: string[];
  [param: string]: unknown;
}

/** A value `set_key` writes: a TOML scalar, or an inline table of scalars. */
export type FixValue = string | number | boolean | Record<string, string | number | boolean>;

/** What every known fix operation carries: the key path of the table it acts in, empty for the root table. */
interface FixOpBase {
  table_path: string[];
  [member: string]: unknown;
}

/** Write `key = value` in the table at `table_path`. */
export interface SetKeyOp extends FixOpBase {
  kind: "set_key";
  key: string;
  value: FixValue;
}

/** Create the table at `table_path` when it is absent; `table_path` names the table itself. */
export interface EnsureTableOp extends FixOpBase {
  kind: "ensure_table";
}

/** Remove `key` from the table at `table_path`. */
export interface DeleteKeyOp extends FixOpBase {
  kind: "delete_key";
  key: string;
}

/** Remove the table at `table_path`, which names the table itself. */
export interface DeleteTableOp extends FixOpBase {
  kind: "delete_table";
}

/** Rename `key` to `new_key` within the table at `table_path`. */
export interface RenameTableKeyOp extends FixOpBase {
  kind: "rename_table_key";
  key: string;
  new_key: string;
}

/** Move `key` from the table at `table_path` into the table at `new_table_path`, under `new_key`. */
export interface MoveKeyOp extends FixOpBase {
  kind: "move_key";
  key: string;
  new_table_path: string[];
  new_key: string;
}

/** Rewrite the string value of `key` through `mapping`, leaving a value it does not name untouched. */
export interface RemapValueOp extends FixOpBase {
  kind: "remap_value";
  key: string;
  mapping: Record<string, string>;
}

/** An operation the protocol lists, discriminated on `kind`. */
export type KnownFixOp =
  | SetKeyOp
  | EnsureTableOp
  | DeleteKeyOp
  | DeleteTableOp
  | RenameTableKeyOp
  | MoveKeyOp
  | RemapValueOp;

/**
 * The reader's catch-all: an operation whose `kind` is none the protocol lists, such as one a later
 * protocol version adds. An applier that meets it applies none of the fix (`isApplicableFix`).
 */
export interface UnknownFixOp {
  kind: string;
  [member: string]: unknown;
}

/** One operation of a suggested fix. Narrow it with `isKnownFixOp` before reading its members. */
export type FixOp = KnownFixOp | UnknownFixOp;

/** A deterministic fix for one fault: a semantic patch over a bundle, addressed by TOML key path. */
export interface SuggestedFix {
  /** The kebab-case name of the rule that produced the fix, such as `rename-model`. */
  fix_code: string;
  /** What the fix does, in one sentence a person can read. */
  description: string;
  /** `safe` or `unsafe`; a value this reader does not know reads as `unsafe` (`fixSafety`). */
  safety: string;
  /** The tree path of the bundle the operations patch; absent, the file the item's location names. */
  file?: string;
  ops: FixOp[];
  [member: string]: unknown;
}

/**
 * One fault of a problem with several, and the item of a validate verdict's `errors` and
 * `warnings`. An item carries its own code but no verdict: its domain is read from its code
 * (`itemDomain`).
 */
export interface ProblemItem {
  code: string;
  /** This fault, in one or two sentences a person can read. */
  detail: string;
  params?: ProblemParams;
  location?: ProblemLocation;
  /** The names a near miss most likely meant, the likeliest first. */
  suggestions?: string[];
  suggested_fix?: SuggestedFix;
  [member: string]: unknown;
}

/**
 * An RFC 9457 problem document carrying the MTHDS core members. A member with no value is absent,
 * never `null`. A client branches on `code`, and on `domain`, `retry` and `next_step.kind` when it
 * handles several codes alike, read through `problemDomain`, `problemRetry` and `problemStepKind`,
 * which apply the readers' fallbacks; it never parses `title`, `detail` or `next_step.detail`.
 */
export interface Problem {
  /** The code's documentation page: its registry's base URL, a slash and the whole code. */
  type: string;
  /** The code's short title, the same for every occurrence of the code. */
  title: string;
  /**
   * The HTTP status of the response this problem is the body of. A problem the client built
   * itself, or one a CLI writes, has none.
   */
  status?: number;
  /** This occurrence, in one or two sentences a person can read. */
  detail: string;
  /** The registry code, such as `input.missing` or `pipelex.billing.credit_exhausted`. */
  code: string;
  /** Who must act: a value of `PROBLEM_DOMAINS`, or one this reader does not know. */
  domain: string;
  /** Whether repeating the operation can succeed: a value of `RETRY_VERDICTS`, or one this reader does not know. */
  retry: string;
  /** Seconds to wait before repeating the operation, only beside a `retry` of `yes`. */
  retry_after?: number;
  next_step: NextStep;
  /** The code's parameters; present when the code declares any. */
  params?: ProblemParams;
  location?: ProblemLocation;
  /** One item per fault, for a problem with several, such as a method that does not validate. */
  errors?: ProblemItem[];
  /** The run the error belongs to, when a run exists. */
  pipeline_run_id?: string;
  [member: string]: unknown;
}

/** A step template of a registry entry: its kind and the template of its sentence. */
export interface StepTemplate {
  readonly kind: StepKind;
  readonly detail: string;
}

/** How a registry entry types one parameter. */
export interface RegistryParam {
  readonly type: RegistryParamType;
  /** For an `enum`, the values it takes. */
  readonly values?: readonly string[];
  /** For a `list`, the type of its items. */
  readonly items?: { readonly type: RegistryParamType };
  /** A fact an occurrence may lack. */
  readonly optional?: true;
  /** A fact of the runtime's configuration that only its operator reads, left out of every problem a caller reads. */
  readonly operator_only?: true;
}

/**
 * One entry of an error registry, as the generated module holds it: everything a reader or an
 * emitter needs to read or build a problem of the code. The prose written for the code's page,
 * what it means and what to do, is left to that page, at the code's type URI.
 */
export interface RegistryEntry {
  readonly code: string;
  readonly title: string;
  readonly domain: ProblemDomain;
  readonly retry: RetryVerdict;
  readonly raised_as: RaisedAs;
  /** The HTTP status of a code raised as a problem; a client code and a warning have none. */
  readonly status?: number;
  /** The template of the problem's `detail`. */
  readonly detail: string;
  /** The step for the domain's actor, and the step for any other reader. */
  readonly steps: { readonly actor: StepTemplate; readonly other: StepTemplate };
  readonly params: { readonly [name: string]: RegistryParam };
}

/** A prefix registered for extension codes, and the base URL of its codes' type URIs. */
export interface ExtensionPrefix {
  readonly prefix: string;
  readonly owner: string;
  readonly base_url: string;
}
