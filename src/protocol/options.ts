/**
 * The MTHDS Protocol's request-argument surface — the named arguments of
 * `execute` / `start` / `validate`.
 *
 * The protocol has no request *model*: a runner takes the request's basic
 * arguments as named parameters and serializes the wire body directly, merging
 * any server-specific extension args (`extra`) as top-level properties. These
 * option/request shapes are the TS expression of that argument surface.
 *
 * The method-source predicates below travel with the request shape rather than
 * with any one runner: which source combinations are legal is an invariant of
 * `RunRequest` itself, so every client that builds one — the API runner, the
 * local pipelex runner, `@pipelex/sdk` — enforces it from this single
 * definition instead of re-deriving it and drifting.
 */

import { PipelineRequestError } from "./exceptions.js";
import type { MethodFiles, MethodTreeSource } from "./file_entries.js";
import type { VariableMultiplicity } from "./pipe_output.js";
import type { PipelineInputs } from "./pipeline_inputs.js";

/**
 * Body of the protocol's `POST /execute` — mirrors `RunRequest` in
 * `mthds-protocol.openapi.yaml`. At least one of `pipe_code` / `files` is
 * required. With `files` and no `pipe_code`, the run starts at the manifest's
 * `main_pipe`, or, in a method with no manifest, at the one `main_pipe` its
 * bundles declare.
 */
export interface RunRequest {
  /** Code of the pipe to execute: a pipe the runner already holds, or one defined in a bundle of `files`. */
  pipe_code?: string | null;
  /**
   * The method to load, as its whole method tree: a map from tree path to file
   * entry, each the file's text, `{ base64 }`, or `{ sha256, size }` naming bytes
   * the runner holds in its blob store. Its bundles, its manifest when it has one,
   * and every other file a step may read or that travels with the method.
   */
  files?: MethodFiles | null;
  /** Method inputs: map of input name to content (loose here, strict in the runtime). */
  inputs?: PipelineInputs | Record<string, unknown> | null;
  /** Name of the output slot to return as the main output. */
  output_name?: string | null;
  /** Output multiplicity override (`false`/`true` or an exact count). */
  output_multiplicity?: VariableMultiplicity | null;
  /** Override for the dynamic output concept reference. */
  dynamic_output_concept_ref?: string | null;
}

/**
 * Body of the protocol's `POST /start` — the same basic arguments as `RunRequest`.
 *
 * The protocol declares no start-only request fields. Anything an
 * implementation accepts on top (a client-supplied run id, anything else) is
 * an extension arg — the server that defines it is the one that handles it;
 * callers pass it through the generic `extra` option.
 */
export type StartRequest = RunRequest;

/**
 * The generic extension passthrough: server-specific args merged into the
 * request body as top-level properties — the server you call defines and
 * handles them; this SDK only passes them through. Protocol args inside
 * `extra` are rejected client-side.
 *
 * It also carries the two client-only options, which are never sent as such.
 */
export interface ExtensionOptions {
  extra?: Record<string, unknown> | null;
  /**
   * CLIENT-ONLY — the method as a tree the sender holds, in place of `files`.
   * The client chooses how each file travels: the whole tree inline when the
   * runner keeps no blob store or the tree is small, and otherwise every file by
   * hash, after asking `POST /blobs/missing` which blobs the runner lacks and
   * uploading those. Sent as `files`; mutually exclusive with `files`.
   */
  tree?: MethodTreeSource | null;
  /**
   * CLIENT-ONLY entrypoint hint — NEVER sent on the wire. The tree path of the
   * `.mthds` file a `run` target named, so a local runner points `run bundle` at
   * exactly that file instead of inferring the entry from a tree holding several
   * methods. The API runner ignores it: on the wire, the entry is chosen by
   * `pipe_code` or by the runner.
   */
  bundleMain?: string;
}

/**
 * Options for `MTHDSProtocol.execute` — the `RunRequest` fields plus the
 * generic `extra` extension passthrough and the client-only `tree`. (The
 * options surface and the wire body are intentionally the same shape.)
 */
export type RunOptions = RunRequest & ExtensionOptions;

/**
 * Options for `MTHDSProtocol.start` — the `StartRequest` wire fields (the
 * protocol's basic execution arguments) plus the generic `extra` extension
 * passthrough (server-specific args, merged into the body) and the client-only
 * `tree`.
 */
export type StartOptions = StartRequest & ExtensionOptions;

/**
 * What `MTHDSProtocol.validate` judges: the method's tree, either as the `files`
 * map to send as it is, or as a tree the sender holds, which the client sends
 * inline or by hash as it does for a run.
 */
export type ValidateSource = { files: MethodFiles } | { tree: MethodTreeSource };

/**
 * Enforce that a request names its method at most once: `files` is the map sent
 * as given, `tree` the tree the client turns into that map, so both together
 * would be two methods. Keys off presence, not emptiness: a caller who supplies
 * `files: {}` beside a `tree` still named two. Throws `PipelineRequestError`;
 * the API client, the local runner and `@pipelex/sdk` all call it so they refuse
 * the same combination identically.
 */
export function assertOneMethodSource(options: RunOptions): void {
  if (options.files != null && options.tree != null) {
    throw new PipelineRequestError(
      "files and tree are two forms of the method's tree and are mutually exclusive; provide one.",
    );
  }
}

/**
 * Does the request carry a method to load? A non-empty `files` map or a `tree`
 * holding a file satisfies the "something to run" precondition on its own, since
 * the runner then starts at the method's `main_pipe` when no `pipe_code` is given.
 * Unlike {@link assertOneMethodSource}, this keys off a RUNNABLE payload: an empty
 * map or tree carries no method, so it does not satisfy the precondition.
 */
export function hasMethodSource(options: RunOptions): boolean {
  const hasFiles = options.files != null && Object.keys(options.files).length > 0;
  const hasTree = options.tree != null && options.tree.files.length > 0;
  return hasFiles || hasTree;
}
