/**
 * Dict-serialized wire models — the SDK's concrete JSON materialization of the
 * protocol's domain shapes. The single home (parity D8) for `DictStuff` /
 * `DictWorkingMemory` / `DictPipeOutput` and the default `RunResultExecute`
 * binding. Mirrors `mthds/runners/api/models.py`.
 *
 * These are the JSON forms the runners deal in: each `Stuff` reduced to
 * `{ concept: <ref>, content }`, working memory as a flat root + aliases, the
 * pipe-output as that working memory + a run id, and `DictRunResultExecute` as
 * the protocol's `RunResultExecute` carrying a `DictPipeOutput`.
 */

import type { RunResultExecute } from "../../protocol/models.js";

export interface DictStuff {
  concept: string;
  content: unknown;
}

export interface DictWorkingMemory {
  root: Record<string, DictStuff>;
  aliases: Record<string, string>;
}

/**
 * Serialized pipe output — exact mirror of python's `DictPipeOutputAbstract`
 * (`{working_memory, pipeline_run_id}`). NOTE: the inner `pipeline_run_id` is a
 * runtime-internal field produced by the pipelex runtime inside the
 * `pipe_output` payload — it deliberately keeps its name (master plan D1:
 * runtime internals are out of the wire-rename scope, matching mthds-python).
 */
export interface DictPipeOutput {
  working_memory: DictWorkingMemory;
  pipeline_run_id: string;
}

/**
 * The default `RunResultExecute` binding — the concrete execute result with a
 * Dict-serialized output. `RunResultExecute<DictPipeOutput>` is what both
 * runners (API + pipelex CLI) produce; extension fields (e.g.
 * `main_stuff_name`) ride the protocol's extension-open response.
 */
export type DictRunResultExecute = RunResultExecute<DictPipeOutput>;
