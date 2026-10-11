/**
 * The vendored usage-statistics schema, `tests/fixtures/usage-statistics.json`, byte-identical to
 * `conformance/specs/usage-statistics.json`, and a checker that reads an event the way the
 * project's gate does: every property declared, of its type, within its bounds, among its values,
 * matching its pattern, present only when its condition holds, and every required one present.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface PropertySpec {
  type: "integer" | "number" | "boolean" | "enum" | "pattern" | "secret";
  required: boolean;
  values?: string[];
  values_by?: { property: string; values: Record<string, string[]> };
  min?: number;
  max?: number;
  pattern?: string;
  when?: { property: string; equals: unknown };
}

export interface UsageStatsSchema {
  schema_version: number;
  destination: {
    capture_host: string;
    batch_path: string;
    project_token: string;
  };
  notice: {
    version: number;
    details_url: string;
    text: string;
    disable_commands: Record<string, string>;
  };
  patterns: Record<string, { regex: string; max_length: number }>;
  envelope: { fields: Record<string, { pattern: string }>; empty_fields: Record<string, string> };
  common_properties: Record<string, PropertySpec>;
  events: Record<
    string,
    {
      tools: string[];
      common: boolean;
      person_profile: string;
      properties: Record<string, PropertySpec>;
    }
  >;
  person_profile_property: string;
  switch_values: Record<string, string[]>;
  switches: Array<{ token: string; tools: string[] }>;
  environment: Record<string, string>;
  state: Record<string, string>;
  spool: Record<string, number>;
  budgets_ms: Record<string, number>;
  ci_variables: string[];
  container_markers: { files: string[]; environment: string[]; cgroup_words: string[] };
  project_markers: string[];
}

export const SCHEMA_PATH = fileURLToPath(
  new URL("../../fixtures/usage-statistics.json", import.meta.url),
);

export const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8")) as UsageStatsSchema;

function matchesPattern(name: string, value: unknown): boolean {
  const pattern = SCHEMA.patterns[name];
  if (pattern === undefined || typeof value !== "string") return false;
  return value.length <= pattern.max_length && new RegExp(pattern.regex).test(value);
}

function conditionHolds(spec: PropertySpec, properties: Record<string, unknown>): boolean {
  return spec.when === undefined || properties[spec.when.property] === spec.when.equals;
}

function propertyProblem(
  name: string,
  spec: PropertySpec,
  value: unknown,
  properties: Record<string, unknown>,
): string | undefined {
  switch (spec.type) {
    case "boolean":
      return typeof value === "boolean" ? undefined : `${name} is not a boolean`;
    case "integer":
    case "number": {
      if (typeof value !== "number" || (spec.type === "integer" && !Number.isInteger(value))) {
        return `${name} is not a ${spec.type}`;
      }
      if (spec.min !== undefined && value < spec.min) return `${name} is below ${spec.min}`;
      if (spec.max !== undefined && value > spec.max) return `${name} is above ${spec.max}`;
      return undefined;
    }
    case "enum": {
      const values =
        spec.values ?? spec.values_by?.values[String(properties[spec.values_by.property])] ?? [];
      return typeof value === "string" && values.includes(value)
        ? undefined
        : `${name}=${JSON.stringify(value)} is not among its values`;
    }
    case "pattern":
      return matchesPattern(spec.pattern!, value)
        ? undefined
        : `${name} does not match ${spec.pattern}`;
    default:
      return `${name} is a ${spec.type}, which no sender sends`;
  }
}

/** Every reason the gate would drop `event` as sent by `tool`; empty when it passes. */
export function gateProblems(event: Record<string, unknown>, tool: string): string[] {
  const problems: string[] = [];
  const name = event["event"];
  const declaration = typeof name === "string" ? SCHEMA.events[name] : undefined;
  if (declaration === undefined) return [`event ${JSON.stringify(name)} is not declared`];
  if (!declaration.tools.includes(tool)) problems.push(`${tool} does not send ${String(name)}`);

  for (const [field, spec] of Object.entries(SCHEMA.envelope.fields)) {
    if (!matchesPattern(spec.pattern, event[field]))
      problems.push(`envelope ${field} does not match ${spec.pattern}`);
  }
  for (const field of Object.keys(SCHEMA.envelope.empty_fields)) {
    if (event[field] !== undefined && event[field] !== null && event[field] !== "") {
      problems.push(`envelope ${field} is set`);
    }
  }
  const allowedEnvelope = new Set(["event", "properties", ...Object.keys(SCHEMA.envelope.fields)]);
  for (const key of Object.keys(event)) {
    if (!allowedEnvelope.has(key)) problems.push(`envelope carries ${key}`);
  }

  const properties = event["properties"];
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return [...problems, "properties is not an object"];
  }
  const props = properties as Record<string, unknown>;
  if (props[SCHEMA.person_profile_property] !== false) {
    problems.push(`${SCHEMA.person_profile_property} is not false`);
  }

  const declared: Record<string, PropertySpec> = {
    ...(declaration.common ? SCHEMA.common_properties : {}),
    ...declaration.properties,
  };
  for (const [key, value] of Object.entries(props)) {
    if (key === SCHEMA.person_profile_property) continue;
    const spec = declared[key];
    if (spec === undefined) {
      problems.push(`${key} is not declared`);
      continue;
    }
    if (!conditionHolds(spec, props)) {
      problems.push(`${key} is present while its condition does not hold`);
      continue;
    }
    const problem = propertyProblem(key, spec, value, props);
    if (problem !== undefined) problems.push(problem);
  }
  for (const [key, spec] of Object.entries(declared)) {
    if (spec.required && conditionHolds(spec, props) && !(key in props)) {
      problems.push(`${key} is required`);
    }
  }
  return problems;
}

/** The notice as `tool` prints it. */
export function noticeFor(tool: string): string {
  return SCHEMA.notice.text
    .replace("{disable_command}", SCHEMA.notice.disable_commands[tool]!)
    .replace("{details_url}", SCHEMA.notice.details_url);
}
