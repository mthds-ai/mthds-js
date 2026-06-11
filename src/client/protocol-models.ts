/**
 * Wire models for the MTHDS Protocol discovery + validation surfaces.
 *
 * Mirrors `mthds-protocol.openapi.yaml` (the standard's normative artifact):
 *   POST /validate -> ValidationReport
 *   GET  /models   -> ModelDeck
 *   GET  /version  -> VersionInfo
 */

/** The MTHDS Protocol version this SDK implements. */
export const MTHDS_PROTOCOL_VERSION = "0.1.0";

/** Model categories accepted by the protocol's `GET /models?type=` filter. */
export type ModelCategory = "llm" | "extract" | "img_gen" | "search";

export const MODEL_CATEGORIES: readonly ModelCategory[] = [
  "llm",
  "extract",
  "img_gen",
  "search",
];

/** One entry of the model deck (`ModelDeck.models[]`). */
export interface ModelInfo {
  name: string;
  type?: ModelCategory | null;
}

/**
 * The model deck a runner can route to — `GET /models`.
 *
 * Mirrors the protocol's `ModelDeck`: presets (`models`), `aliases`, and
 * routing `waterfalls`. Implementations may enrich the deck with extra fields;
 * consumers should tolerate unknown properties.
 */
export interface ModelDeck {
  models: ModelInfo[];
  aliases: Record<string, string>;
  waterfalls: Record<string, string[]>;
}

/**
 * Structural artifacts returned by `POST /validate` when the bundle is valid.
 *
 * Failures never reach this shape — they are RFC 7807 problems (HTTP 422,
 * surfaced as `ApiResponseError`). All artifacts are optional: the protocol
 * marks none of them required, and implementations fill what they can produce.
 */
export interface ValidationReport {
  blueprint?: unknown;
  graph_spec?: unknown;
  pipe_structures?: unknown;
}

/**
 * Protocol + implementation versions — `GET /version` (always public).
 *
 * The handshake clients use for feature detection: `implementation`
 * identifies the runner (`pipelex-api` = bare open-source runner,
 * `pipelex-hosted` = the hosted MTHDS API), and hosted extensions (durable
 * runs) light up based on what the server advertises.
 */
export interface VersionInfo {
  protocol_version: string;
  implementation: string;
  implementation_version: string;
  runtime_version?: string | null;
}
