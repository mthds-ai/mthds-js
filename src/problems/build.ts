/**
 * Building a problem from the core registry, for an error a client detects itself, such as a
 * runtime it cannot reach, and for an answer it reads by a reading rule rather than from its body
 * (mthds/docs/spec/error-registry.md, "Templates"). Everything a problem of a code carries is the
 * code's entry, and its sentences are the entry's templates filled with the occurrence's
 * parameters, so a client's own callers read every error alike.
 */

import type { CoreErrorCode, ProblemParamsByCode } from "./registry.generated.js";
import { CORE_REGISTRY } from "./registry.generated.js";
import { typeUriOf } from "./registry.js";
import type {
  Problem,
  ProblemItem,
  ProblemLocation,
  ProblemParams,
  RegistryEntry,
} from "./types.js";
import type { ProblemDomain } from "./vocabulary.js";

/**
 * Which of a code's two steps a problem carries: `actor`, for the domain's actor, or `other`, for
 * any other reader (mthds/docs/spec/protocol.md, "Next steps").
 */
export type StepReader = "actor" | "other";

/**
 * The reader of a problem a client builds, when the caller does not say: the client's own caller,
 * who is the actor of an `input` problem, the caller's own request being at fault, and of a
 * `runtime` one, which nobody fixes beforehand, the caller being the one who waits, retries or
 * reports. A `method`, `account` or `operator` problem is someone else's to fix: the method's
 * author, the account's owner or whoever runs the runtime.
 */
export function defaultStepReader(domain: ProblemDomain): StepReader {
  return domain === "input" || domain === "runtime" ? "actor" : "other";
}

/** How one parameter value is written into a sentence: a list as its items joined by a comma and a space. */
function writeValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(writeValue).join(", ");
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

/** A template's tokens: a doubled brace, a placeholder, or a lone brace, which no template may hold. */
const TEMPLATE_TOKEN = /\{\{|\}\}|\{([a-z][a-z0-9_]*)\}|[{}]/g;

/**
 * The parameters a registry template names, in order. A template holding a lone `{` or `}`, one
 * neither doubled nor part of a `{name}` placeholder, is malformed, and this throws on it.
 */
export function templateParams(template: string): string[] {
  const names: string[] = [];
  for (const match of template.matchAll(TEMPLATE_TOKEN)) {
    if (match[1] !== undefined) names.push(match[1]);
    else if (match[0] === "{" || match[0] === "}") {
      throw new Error(`A lone brace at ${match.index} makes the template malformed: ${template}`);
    }
  }
  return names;
}

/**
 * Fill a registry template: each `{name}` becomes the parameter's value, a list written as its
 * items joined by a comma and a space, and a doubled brace is a literal one. A template names only
 * parameters every occurrence gives (mthds/docs/spec/error-registry.md, "Templates"), so this
 * throws on a placeholder naming a parameter `params` does not give, as on a lone `{` or `}`,
 * which makes the template malformed, and on an unclosed placeholder.
 */
export function renderTemplate(
  template: string,
  params: Readonly<Record<string, unknown>>,
): string {
  return template.replace(TEMPLATE_TOKEN, (match, name: string | undefined, offset: number) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    if (name === undefined) {
      throw new Error(`A lone brace at ${offset} makes the template malformed: ${template}`);
    }
    if (params[name] === undefined) {
      throw new Error(
        `The template names the parameter '${name}', which is not given: ${template}`,
      );
    }
    return writeValue(params[name]);
  });
}

/** The members of a problem a builder may set beside the ones its code decides. */
export interface BuildProblemOptions {
  /** Which step the problem carries; by default, `defaultStepReader` of the code's domain. */
  reader?: StepReader;
  /** The HTTP status of the answer the problem reads, for a problem read from an answer; a client code has none. */
  status?: number;
  /** Seconds to wait before a repeat, kept only beside a `retry` of `yes`. */
  retryAfter?: number;
  location?: ProblemLocation;
  errors?: ProblemItem[];
  pipeline_run_id?: string;
  /**
   * Members of the implementation's own, written after the core members, such as the request's
   * `request_id` or a command's own `message`. A member left `undefined` is not written.
   */
  extra?: Readonly<Record<string, unknown>>;
}

/** Build a problem of a registry entry; `buildProblem` is its typed form for a core code. */
export function buildProblemFromEntry(
  entry: RegistryEntry,
  params: Readonly<Record<string, unknown>>,
  options: BuildProblemOptions = {},
): Problem {
  const step = entry.steps[options.reader ?? defaultStepReader(entry.domain)];
  // Members are written in the protocol's order, `status` beside `title` where RFC 9457 lists it.
  const problem = { type: typeUriOf(entry.code) ?? entry.code, title: entry.title } as Problem;
  if (options.status !== undefined) problem.status = options.status;
  problem.detail = renderTemplate(entry.detail, params);
  problem.code = entry.code;
  problem.domain = entry.domain;
  problem.retry = entry.retry;
  if (options.retryAfter !== undefined && entry.retry === "yes")
    problem.retry_after = options.retryAfter;
  problem.next_step = { kind: step.kind, detail: renderTemplate(step.detail, params) };
  const declared = Object.entries(entry.params);
  if (declared.length > 0) {
    const visible: ProblemParams = {};
    for (const [name, spec] of declared) {
      if (spec.operator_only === true || params[name] === undefined) continue;
      visible[name] = params[name];
    }
    problem.params = visible;
  }
  if (options.location !== undefined) problem.location = options.location;
  if (options.errors !== undefined && options.errors.length > 0) problem.errors = options.errors;
  if (options.pipeline_run_id !== undefined) problem.pipeline_run_id = options.pipeline_run_id;
  for (const [name, value] of Object.entries(options.extra ?? {})) {
    if (value !== undefined && !(name in problem)) problem[name] = value;
  }
  return problem;
}

/**
 * Build the problem of a core code with its parameters: its type, title, domain, retry verdict
 * and step from its entry, its detail and its step's sentence from the entry's templates, and its
 * parameters when the code declares any, an operator-only one left out.
 */
export function buildProblem<Code extends CoreErrorCode>(
  code: Code,
  params: ProblemParamsByCode[Code],
  options: BuildProblemOptions = {},
): Problem {
  return buildProblemFromEntry(CORE_REGISTRY[code], params as Record<string, unknown>, options);
}
