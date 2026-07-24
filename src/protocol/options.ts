/**
 * The MTHDS Protocol's request-argument surface — the named arguments of
 * `execute` / `start`.
 *
 * The protocol has no request *model*: a runner takes the request's basic
 * arguments as named parameters and serializes the wire body directly, merging
 * any server-specific extension args (`extra`) as top-level properties. These
 * option/request shapes are the TS expression of that argument surface.
 *
 * The run-source predicates below travel with the request shape rather than
 * with any one runner: which source combinations are legal is an invariant of
 * `RunRequest` itself, so every client that builds one — the API runner, the
 * local pipelex runner, `@pipelex/sdk` — enforces it from this single
 * definition instead of re-deriving it and drifting.
 */

import { PipelineRequestError } from "./exceptions.js";
import type { VariableMultiplicity } from "./pipe_output.js";
import type { PipelineInputs } from "./pipeline_inputs.js";

/**
 * Body of the protocol's `POST /execute` — mirrors `RunRequest` in
 * `mthds-protocol.openapi.yaml`. At least one of `pipe_code` /
 * `mthds_contents` is required.
 */
export interface RunRequest {
  /** Code of the pipe to execute (registered, or defined in `mthds_contents`). */
  pipe_code?: string | null;
  /** MTHDS bundle contents to load (always an array, even for one file). */
  mthds_contents?: string[] | null;
  /** Method inputs: map of input name to content (loose here, strict in the runtime). */
  inputs?: PipelineInputs | Record<string, unknown> | null;
  /** Name of the output slot to return as the main output. */
  output_name?: string | null;
  /** Output multiplicity override (`false`/`true` or an exact count). */
  output_multiplicity?: VariableMultiplicity | null;
  /** Override for the dynamic output concept reference. */
  dynamic_output_concept_ref?: string | null;
  /**
   * PIPELEX-API EXTENSION (not part of the pure MTHDS Protocol) — the whole
   * method bundle as a `{ relativePath: text }` map (the `.mthds` plus its
   * `funcs/*.py`, `structures/*.py`, `requirements.txt`). Lets custom PipeFunc
   * Python travel with the method: the runner materializes it into a temporary
   * library directory before the run, rather than only loading the inline
   * `.mthds` text. Mutually exclusive with `bundle_b64` and with `mthds_contents`
   * (a bundle carries its own `.mthds`).
   */
  files?: Record<string, string> | null;
  /**
   * PIPELEX-API EXTENSION — the same method bundle as a base64-encoded zip
   * archive (the compressed equivalent of `files`). Mutually exclusive with
   * `files` and with `mthds_contents`.
   */
  bundle_b64?: string | null;
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
 */
export interface ExtensionOptions {
  extra?: Record<string, unknown> | null;
  /**
   * CLIENT-ONLY entrypoint hint — NEVER sent on the wire. The bundle-relative
   * path of the `.mthds` a `run` target selected, so a local runner points
   * `run bundle` at exactly the file the caller named instead of re-inferring
   * the main from a multi-method directory. Set by `resolveRunBundle`; the API
   * request builders name wire fields explicitly and ignore it.
   */
  bundleMain?: string;
}

/**
 * Options for `MTHDSProtocol.execute` — the `RunRequest` fields plus the
 * generic `extra` extension passthrough. (The options surface and the wire
 * body are intentionally the same shape.)
 */
export type RunOptions = RunRequest & ExtensionOptions;

/**
 * Options for `MTHDSProtocol.start` — the `StartRequest` wire fields (the
 * protocol's basic execution arguments) plus the generic `extra` extension
 * passthrough (server-specific args, merged into the body).
 */
export type StartOptions = StartRequest & ExtensionOptions;

/**
 * Enforce the run-source exclusivity contract shared by every client: a method
 * bundle is self-contained (`files` / `bundle_b64` carry their own `.mthds`),
 * so it cannot be combined with `mthds_contents`, and `files` / `bundle_b64`
 * are two encodings of one bundle. Exclusivity keys off PRESENCE, not emptiness
 * — a caller who supplies `files: {}` alongside `bundle_b64` still expressed two
 * encodings — while `mthds_contents` counts only when non-empty (an empty array
 * is "no contents"). Throws `PipelineRequestError`; the API client, the local
 * runner, and `@pipelex/sdk` all call it so they reject the same combinations
 * identically. Wording mirrors the server's validator.
 */
export function assertExclusiveRunSources(options: RunRequest): void {
  const hasFiles = options.files != null;
  const hasZip = options.bundle_b64 != null;
  const hasContents = options.mthds_contents != null && options.mthds_contents.length > 0;
  if (hasFiles && hasZip) {
    throw new PipelineRequestError(
      "files and bundle_b64 are two encodings of the same bundle and are mutually exclusive; provide one.",
    );
  }
  if ((hasFiles || hasZip) && hasContents) {
    throw new PipelineRequestError(
      "A method bundle (files/bundle_b64) is self-contained; it cannot be combined with mthds_contents.",
    );
  }
}

/**
 * Does the request carry a method bundle (the pipelex-api `files` / `bundle_b64`
 * extension)? A bundle satisfies the "something to run" precondition on its own —
 * it carries its own `.mthds`, so neither `pipe_code` nor `mthds_contents` is
 * required alongside it. Unlike {@link assertExclusiveRunSources}, this keys off
 * a RUNNABLE payload: an empty map / string carries no method, so it does not
 * satisfy the precondition.
 */
export function hasBundlePayload(options: RunRequest): boolean {
  const hasFiles = options.files != null && Object.keys(options.files).length > 0;
  const hasZip = options.bundle_b64 != null && options.bundle_b64.length > 0;
  return hasFiles || hasZip;
}
