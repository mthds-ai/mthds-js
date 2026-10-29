/**
 * The switches that turn statistics off. Statistics are on unless any switch says off, and no
 * switch can turn them back on over another that says off.
 *
 * The `mthds` CLI sends two kinds of events, which follow different switches:
 *
 * | Switch                                    | `command_completed` | `method_install`, `method_publish` |
 * | ----------------------------------------- | ------------------- | ---------------------------------- |
 * | `DO_NOT_TRACK`                            | off                 | off                                |
 * | `PIPELEX_USAGE_STATS`                     | off                 | unaffected                         |
 * | `DISABLE_TELEMETRY` (environment)         | off                 | off                                |
 * | `disabled`                                | off                 | off                                |
 * | legacy `DISABLE_TELEMETRY` in the config  | off                 | off                                |
 * | project setting                           | off                 | unaffected                         |
 * | `PIPELEX_USAGE_STATS_ENDPOINT` not loopback | off               | off                                |
 *
 * A loopback `PIPELEX_USAGE_STATS_ENDPOINT` reroutes both kinds to the server it names, so the
 * override a test sets keeps every event the CLIs send on the machine.
 */

import { CAPTURE_HOST, ENV, SWITCH_VALUES } from "./contract.js";
import type { OffByToken } from "./contract.js";
import { isMthdsDisableOn, isSetAndNotFalsy, normalizedValue } from "./environment.js";
import { projectSettingTurnsOff } from "./project.js";
import { isMachineDisabled, legacyOptOutPending } from "./state.js";

/** A loopback `http` origin with a port and no path: the only override the endpoint variable accepts. */
const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/;

export function isDoNotTrack(env: NodeJS.ProcessEnv = process.env): boolean {
  return isSetAndNotFalsy(env[ENV.doNotTrack]);
}

/** Whether `PIPELEX_USAGE_STATS` says off: an off value, or any value it cannot read, which fails closed. */
export function toolSwitchSaysOff(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = normalizedValue(env[ENV.toolSwitch]);
  if (value === undefined) return false;
  return !(SWITCH_VALUES.toolSwitchNoEffect as readonly string[]).includes(value);
}

/** Whether this CLI's own `DISABLE_TELEMETRY` environment variable says off. */
export function disableTelemetryEnvSaysOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return isMthdsDisableOn(env[ENV.mthdsToolSwitch]);
}

/**
 * Where events are posted: the endpoint override when it is a loopback `http` origin, `host` when
 * it is unset (PostHog's capture host unless the caller names another), and nowhere (undefined)
 * when it is set to anything else, which turns every event off for the process.
 */
export function resolveEndpoint(
  env: NodeJS.ProcessEnv = process.env,
  host: string = CAPTURE_HOST,
): string | undefined {
  const override = env[ENV.endpointOverride];
  if (override === undefined) return host;
  const match = LOOPBACK_ORIGIN.exec(override);
  if (!match) return undefined;
  const port = Number(match[1]);
  return port >= 1 && port <= 65535 ? override : undefined;
}

export interface SwitchContext {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** Every switch that turns `command_completed` off, by its `off_by` token, in the contract's order. */
export function usageStatsOffBy(context: SwitchContext = {}): OffByToken[] {
  const env = context.env ?? process.env;
  const offBy: OffByToken[] = [];
  if (isDoNotTrack(env)) offBy.push("do_not_track");
  if (toolSwitchSaysOff(env) || disableTelemetryEnvSaysOff(env)) offBy.push("tool_variable");
  if (isMachineDisabled()) offBy.push("machine_choice");
  if (legacyOptOutPending()) offBy.push("legacy_mthds_choice");
  if (projectSettingTurnsOff(context.cwd ?? process.cwd())) offBy.push("project_setting");
  if (resolveEndpoint(env) === undefined) offBy.push("invalid_endpoint_override");
  return offBy;
}

/**
 * Every switch that turns `method_install` and `method_publish` off. Those events go to the
 * project mthds.sh reads, not the shared one, so `PIPELEX_USAGE_STATS` and the project setting do
 * not reach them. The endpoint override does, as it does every event: a test's loopback override
 * reroutes them, and any other value turns them off.
 */
export function methodEventsOffBy(env: NodeJS.ProcessEnv = process.env): OffByToken[] {
  const offBy: OffByToken[] = [];
  if (isDoNotTrack(env)) offBy.push("do_not_track");
  if (disableTelemetryEnvSaysOff(env)) offBy.push("tool_variable");
  if (isMachineDisabled()) offBy.push("machine_choice");
  if (legacyOptOutPending()) offBy.push("legacy_mthds_choice");
  if (resolveEndpoint(env) === undefined) offBy.push("invalid_endpoint_override");
  return offBy;
}

export function methodEventsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return methodEventsOffBy(env).length === 0;
}
