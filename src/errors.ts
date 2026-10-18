/**
 * Client-safe error taxonomy — the SDK's exception classes, exported from a
 * module whose graph has NO Node-only dependencies, so it can be imported from a
 * browser/client bundle. Published as the `mthds/errors` subpath.
 *
 * Why a separate entry: the top-level barrel (`mthds`) statically re-exports
 * `MthdsApiClient`, whose graph pulls `config/` → `node:fs` at module load. A
 * client bundler (e.g. Next.js / Turbopack) cannot externalize `node:fs` and
 * fails the build — even when the consumer only wanted an error class for an
 * `instanceof` check. Code that needs to classify an error on the client (e.g.
 * `err instanceof ApiResponseError`) imports the classes from here instead of
 * the top-level barrel.
 *
 * These are the same error classes the top-level barrel exports; the two cannot
 * drift because both re-export from the same source modules. The graph here is
 * `protocol/exceptions` (zero imports), `problems/` (the problem document, the
 * generated core registry and its readers, importing only `protocol/exceptions`)
 * and `runners/api/exceptions` (importing only those), so it stays free of Node
 * built-ins.
 */

// ── Protocol-base error (pure protocol layer — no Node deps) ──
export { PipelineRequestError } from "./protocol/exceptions.js";

// ── Problems: `ProblemError`, the problem types, the core registry and its readers ──
export * from "./problems/index.js";

// ── API-runner errors (runners/api/exceptions — graph is protocol and problems only) ──
export {
  ApiResponseError,
  ApiTransportError,
  RunStillRunningError,
} from "./runners/api/exceptions.js";
export type { ApiAnswerFacts } from "./runners/api/exceptions.js";
