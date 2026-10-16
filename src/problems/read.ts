/**
 * Reading a runtime's answers as problems (mthds/docs/spec/protocol.md, "Errors"). Every answer a
 * client cannot use as the route's result reads as exactly one problem with a registered code:
 *
 * - a body that is a problem document reads as received, every member it carries kept, those this
 *   reader does not know included, its `status` taken from the answer when the body leaves it out,
 *   and its `retry_after` from the `Retry-After` header when it has none and its `retry` is `yes`;
 * - a body that is not one, such as a proxy's HTML page or an empty body, reads as the one core
 *   code raised as a problem with the answer's status, when exactly one is and a caller can state
 *   it, which takes no parameter only the runtime knows: today a `405` reads as
 *   `request.method_not_allowed` and a `503` as `runtime.unavailable`. On a route that creates a
 *   run, an answer that is no problem document never invites a repeat, so a code whose `retry` is
 *   `yes` is not read that way there;
 * - anything else reads as `client.response_unreadable`, naming the answer's status.
 *
 * A body is a problem document when it is JSON, nested no deeper than `MAX_BODY_NESTING`, that
 * validates against the protocol's `Problem` schema with its enumerated fields widened to any
 * string: a core member of the wrong JSON type makes it unreadable, while a member the schema
 * does not declare is kept whatever it holds.
 */

import { CORE_REGISTRY } from "./registry.generated.js";
import { buildProblem, buildProblemFromEntry } from "./build.js";
import { PROBLEM_CODE_PATTERN } from "./registry.js";
import type { Problem, ProblemItem, RegistryEntry } from "./types.js";
import { FIX_OP_KINDS } from "./vocabulary.js";

/**
 * The deepest nesting of arrays and objects a body may have to be read. No problem document comes
 * near it, and a body nested deeper is refused before it is parsed, so that neither the parser nor
 * the validation that walks the parsed value can run out of stack.
 */
export const MAX_BODY_NESTING = 512;

/** The outcome of parsing a body as JSON. */
export type JsonReading = { ok: true; value: unknown } | { ok: false };

/** Whether `text` nests arrays and objects deeper than `limit`, strings skipped. */
function nestsDeeperThan(text: string, limit: number): boolean {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charCodeAt(index);
    if (inString) {
      if (char === 0x5c) index += 1;
      else if (char === 0x22) inString = false;
      continue;
    }
    if (char === 0x22) inString = true;
    else if (char === 0x5b || char === 0x7b) {
      depth += 1;
      if (depth > limit) return true;
    } else if (char === 0x5d || char === 0x7d) depth -= 1;
  }
  return false;
}

/** Thrown by the reviver of `parseJsonBody` on a number no finite double holds. */
class NonFiniteNumber extends Error {}

/** `JSON.parse`'s reviver refusing a number that overflows a double, such as `1e999`. */
function refuseNonFinite(_key: string, value: unknown): unknown {
  if (typeof value === "number" && !Number.isFinite(value)) throw new NonFiniteNumber();
  return value;
}

/**
 * Parse a body as JSON, refusing one nested deeper than `MAX_BODY_NESTING`. JSON defines no `NaN`
 * or `Infinity`, which `JSON.parse` refuses too, and a number too large for a double, such as
 * `1e999`, which `JSON.parse` would read as `Infinity`, is refused as well. Every body the client
 * reads, a route's result as much as a problem, is parsed here.
 */
export function parseJsonBody(text: string): JsonReading {
  if (nestsDeeperThan(text, MAX_BODY_NESTING)) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text, refuseNonFinite) as unknown };
  } catch {
    return { ok: false };
  }
}

// ── The Problem schema, as a reader validates it ──────────────────────

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isStringArray(value: unknown, minItems = 0): value is string[] {
  return Array.isArray(value) && value.length >= minItems && value.every(isString);
}

function isIntegerAtLeast(value: unknown, minimum: number, maximum = Infinity): boolean {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

/** A member the schema declares optional: absent, or of its type. */
function optional(object: Json, name: string, check: (value: unknown) => boolean): boolean {
  return !(name in object) || check(object[name]);
}

function isCode(value: unknown): boolean {
  return isString(value) && PROBLEM_CODE_PATTERN.test(value);
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isParams(value: unknown): boolean {
  if (!isObject(value)) return false;
  return optional(
    value,
    "missing_blobs",
    (blobs) =>
      Array.isArray(blobs) && blobs.every((hash) => isString(hash) && SHA256_PATTERN.test(hash)),
  );
}

function isLocation(value: unknown): boolean {
  if (!isObject(value)) return false;
  return (
    optional(value, "pipe", isString) &&
    optional(value, "path", (path) => isStringArray(path)) &&
    optional(value, "input", isString) &&
    optional(value, "field", isString) &&
    optional(value, "item", (item) => isIntegerAtLeast(item, 0)) &&
    optional(value, "attempt", (attempt) => isIntegerAtLeast(attempt, 1)) &&
    optional(value, "file", isString) &&
    optional(value, "line", (line) => isIntegerAtLeast(line, 1)) &&
    optional(value, "column", (column) => isIntegerAtLeast(column, 1))
  );
}

function isScalar(value: unknown): boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isTomlValue(value: unknown): boolean {
  return isScalar(value) || (isObject(value) && Object.values(value).every(isScalar));
}

const KNOWN_OP_KINDS: ReadonlySet<string> = new Set(FIX_OP_KINDS);

/** One operation of a fix: a known kind with its variant's members, or any other kind (`UnknownFixOp`). */
function isFixOp(value: unknown): boolean {
  if (!isObject(value) || !isString(value.kind)) return false;
  if (!KNOWN_OP_KINDS.has(value.kind)) return true;
  const tablePath = (minItems: number): boolean => isStringArray(value.table_path, minItems);
  const key = isString(value.key);
  switch (value.kind) {
    case "set_key":
      return tablePath(0) && key && "value" in value && isTomlValue(value.value);
    case "ensure_table":
    case "delete_table":
      return tablePath(1);
    case "delete_key":
      return tablePath(0) && key;
    case "rename_table_key":
      return tablePath(0) && key && isString(value.new_key);
    case "move_key":
      return tablePath(0) && key && isStringArray(value.new_table_path) && isString(value.new_key);
    case "remap_value":
      return (
        tablePath(0) &&
        key &&
        isObject(value.mapping) &&
        Object.keys(value.mapping).length > 0 &&
        Object.values(value.mapping).every(isString)
      );
    default:
      return false;
  }
}

const FIX_CODE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function isSuggestedFix(value: unknown): boolean {
  return (
    isObject(value) &&
    isString(value.fix_code) &&
    FIX_CODE_PATTERN.test(value.fix_code) &&
    isString(value.description) &&
    isString(value.safety) &&
    optional(value, "file", isString) &&
    Array.isArray(value.ops) &&
    value.ops.length > 0 &&
    value.ops.every(isFixOp)
  );
}

/** Whether a value is a problem item: of a problem's `errors`, or of a validate verdict's `errors` and `warnings`. */
export function isProblemItem(value: unknown): value is ProblemItem {
  return (
    isObject(value) &&
    isCode(value.code) &&
    isString(value.detail) &&
    optional(value, "params", isParams) &&
    optional(value, "location", isLocation) &&
    optional(value, "suggestions", (suggestions) => isStringArray(suggestions)) &&
    optional(value, "suggested_fix", isSuggestedFix)
  );
}

function isNextStep(value: unknown): boolean {
  return isObject(value) && isString(value.kind) && isString(value.detail);
}

/**
 * Whether a value is a problem document: the protocol's `Problem` schema, its domain, retry
 * verdict, step kinds and fix safeties widened to any string, and every object in it open to
 * members it does not declare.
 */
export function isProblem(value: unknown): value is Problem {
  return (
    isObject(value) &&
    isString(value.type) &&
    isString(value.title) &&
    isString(value.detail) &&
    isCode(value.code) &&
    isString(value.domain) &&
    isString(value.retry) &&
    isNextStep(value.next_step) &&
    optional(value, "status", (status) => isIntegerAtLeast(status, 100, 599)) &&
    optional(value, "retry_after", (seconds) => typeof seconds === "number" && seconds >= 0) &&
    optional(value, "params", isParams) &&
    optional(value, "location", isLocation) &&
    optional(
      value,
      "errors",
      (errors) => Array.isArray(errors) && errors.length > 0 && errors.every(isProblemItem),
    ) &&
    optional(value, "pipeline_run_id", isString)
  );
}

/** A body read as a problem document, or `undefined` when it is not one. */
export function readProblemBody(body: string): Problem | undefined {
  const reading = parseJsonBody(body);
  return reading.ok && isProblem(reading.value) ? reading.value : undefined;
}

// ── Answers ──────────────────────────────────────────────────────────

/** The headers of an answer, as fetch gives them or as a plain map of lower-case names. */
export type AnswerHeaders = Headers | Readonly<Record<string, string>>;

/** An answer a runtime gave: its status, its headers and its body as text. */
export interface Answer {
  status: number;
  headers: AnswerHeaders;
  body: string;
}

function header(headers: AnswerHeaders, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const map = headers as Readonly<Record<string, string>>;
  const found = Object.keys(map).find((key) => key.toLowerCase() === name);
  return found === undefined ? undefined : map[found];
}

/** The start of an HTTP date (RFC 9110, "Date/Time Formats"): a day name, in each of its three forms. */
const HTTP_DATE_START = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,? /;

/**
 * The seconds a `Retry-After` header asks to wait: its delta-seconds, ASCII digits only, or the
 * seconds from `now` until its HTTP date, never fewer than zero. `undefined` when the header is
 * absent or unreadable, a number too large to hold exactly included; it never throws.
 */
export function retryAfterSeconds(
  headers: AnswerHeaders,
  now: number = Date.now(),
): number | undefined {
  const raw = header(headers, "retry-after")?.trim();
  if (!raw) return undefined;
  if (/^[0-9]+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  if (!HTTP_DATE_START.test(raw)) return undefined;
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

/** The core codes raised as a problem with a status, by status, each kept when it is the only one. */
let soleCodesByStatus: Map<number, RegistryEntry> | undefined;

/**
 * The one core code raised as a problem with `status`, when exactly one is and a caller can state
 * it: every parameter it declares that a caller sees is optional, so a problem of it needs no fact
 * only the runtime knows.
 */
function soleCodeOfStatus(status: number): RegistryEntry | undefined {
  if (soleCodesByStatus === undefined) {
    const byStatus = new Map<number, RegistryEntry[]>();
    for (const entry of Object.values(CORE_REGISTRY)) {
      if (entry.raised_as !== "problem" || entry.status === undefined) continue;
      byStatus.set(entry.status, [...(byStatus.get(entry.status) ?? []), entry]);
    }
    soleCodesByStatus = new Map();
    for (const [code, entries] of byStatus) {
      const [only] = entries;
      if (entries.length !== 1 || only === undefined) continue;
      const callerStatable = Object.values(only.params).every(
        (param) => param.optional === true || param.operator_only === true,
      );
      if (callerStatable) soleCodesByStatus.set(code, only);
    }
  }
  return soleCodesByStatus.get(status);
}

/** The problem of an answer the client cannot read, naming its status. */
export function unreadableAnswer(status: number): Problem {
  return buildProblem("client.response_unreadable", { status });
}

/** How the route an answer came from is read. */
export interface ReadAnswerOptions {
  /** Whether the route creates a run, such as `POST /execute` and `POST /start`. */
  createsRun?: boolean;
}

/**
 * Read an answer that is not the route's result, a status outside `2xx`, as its problem, by the
 * rules this module's header gives.
 */
export function readErrorAnswer(answer: Answer, options: ReadAnswerOptions = {}): Problem {
  const received = readProblemBody(answer.body);
  if (received !== undefined) {
    let problem = received;
    if (problem.status === undefined) {
      const { type, title, ...rest } = problem;
      problem = { type, title, status: answer.status, ...rest };
    }
    if (problem.retry_after === undefined && problem.retry === "yes") {
      const seconds = retryAfterSeconds(answer.headers);
      if (seconds !== undefined) problem.retry_after = seconds;
    }
    return problem;
  }
  if (answer.status >= 200 && answer.status < 300) return unreadableAnswer(answer.status);
  const entry = soleCodeOfStatus(answer.status);
  if (entry === undefined || (options.createsRun === true && entry.retry === "yes")) {
    return unreadableAnswer(answer.status);
  }
  return buildProblemFromEntry(
    entry,
    {},
    { status: answer.status, retryAfter: retryAfterSeconds(answer.headers) },
  );
}
