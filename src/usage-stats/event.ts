/**
 * The events of the usage-statistics contract this tool sends: the envelope, the common
 * properties every event carries, and `command_completed`.
 *
 * No property is free text: every value is an enum value of the contract, a boolean, a bounded
 * integer, or a version or identifier matching one of its patterns. Nothing a person typed, no
 * argument, path, name or message, ever reaches an event.
 */

import { randomUUID } from "node:crypto";
import {
  COMMANDS,
  ENV,
  HOST_VALUES,
  PERSON_PROFILE_PROPERTY,
  SCHEMA_VERSION,
  TOOL,
} from "./contract.js";
import type { CommandOutcome, ErrorDomain, HostValue, Surface } from "./contract.js";
import { archFamily, isCi, isContainer, languageRuntime, osFamily } from "./environment.js";
import { isInternalMachine, noticeVersionSeen } from "./state.js";
import type { Installation } from "./state.js";

/** One event as it is posted, spooled and printed under the debug variable. */
export interface Envelope {
  event: string;
  distinct_id: string;
  uuid: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

/** `PIPELEX_USAGE_STATS_HOST` as the `host` property: one of its values, `other` for any other, absent when unset. */
export function hostFromEnvironment(env: NodeJS.ProcessEnv = process.env): HostValue | undefined {
  const raw = env[ENV.host]?.trim().toLowerCase();
  if (!raw) return undefined;
  return (HOST_VALUES as readonly string[]).includes(raw) ? (raw as HostValue) : "other";
}

/** The `command` a surface sends for a command path: the path when the contract lists it, `other` otherwise. */
export function commandValue(surface: Surface, path: string): string {
  return COMMANDS[surface].includes(path) ? path : "other";
}

export interface CommonContext {
  surface: Surface;
  toolVersion: string;
  installation: Installation;
  env?: NodeJS.ProcessEnv;
}

/** The properties every event carries, in the order the contract lists them. */
export function commonProperties(context: CommonContext): Record<string, unknown> {
  const env = context.env ?? process.env;
  const properties: Record<string, unknown> = {
    schema: SCHEMA_VERSION,
    tool: TOOL,
    tool_version: context.toolVersion,
    surface: context.surface,
  };
  const host = hostFromEnvironment(env);
  if (host !== undefined) properties["host"] = host;
  properties["id_new"] = context.installation.idNew;
  properties["os"] = osFamily();
  properties["arch"] = archFamily();
  properties["language_runtime"] = languageRuntime();
  properties["ci"] = isCi(env);
  properties["container"] = isContainer(env);
  properties["internal"] = isInternalMachine();
  properties["notice_version"] = noticeVersionSeen();
  return properties;
}

export interface CommandCompleted {
  /** The command's path in the CLI's command tree, its words separated by one space. */
  command: string;
  outcome: CommandOutcome;
  errorDomain?: ErrorDomain;
  durationMs: number;
  hosted?: boolean;
}

/** Wrap properties in the envelope, its `uuid` and `timestamp` fixed now and never changed by a resend. */
export function envelope(
  event: string,
  distinctId: string,
  properties: Record<string, unknown>,
): Envelope {
  return {
    event,
    distinct_id: distinctId,
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    properties: { ...properties, [PERSON_PROFILE_PROPERTY]: false },
  };
}

export function buildCommandCompleted(context: CommonContext, command: CommandCompleted): Envelope {
  const properties = commonProperties(context);
  properties["command"] = commandValue(context.surface, command.command);
  properties["outcome"] = command.outcome;
  if (command.outcome === "failed" && command.errorDomain !== undefined) {
    properties["error_domain"] = command.errorDomain;
  }
  properties["duration_ms"] = Math.max(0, Math.min(2_592_000_000, Math.round(command.durationMs)));
  if (command.hosted !== undefined) properties["hosted"] = command.hosted;
  return envelope("command_completed", context.installation.id, properties);
}
