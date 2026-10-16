/**
 * The problems of failures the mthds-agent commands share: a local file the system refused, a
 * method the resolver could not use, and a publish mthds.sh listed nothing of. Each is coded from
 * the core registry (docs/errors.md), with the command's own sentence in `message`.
 */

import { agentProblem } from "./output.js";
import {
  describeUnusableMethod,
  findSkippedMethod,
  skippedMethodReports,
} from "../installer/resolver/skipped.js";
import type { SkippedMethodReport } from "../installer/resolver/skipped.js";
import type { MethodRegistration, RegistrationAnswer } from "../installer/registry/client.js";
import type { ResolvedRepo } from "../package/manifest/types.js";
import type { StepReader } from "../problems/build.js";
import type { Problem, ProblemItem } from "../problems/types.js";

/**
 * The reason a file could not be read or written, from the system's error code: `ENOENT` reads
 * `enoent`. An error with no such code reads as `fallback`: `unreadable` for a read, by default,
 * and `unwritable` for a write.
 */
export function fileErrorReason(err: unknown, fallback = "unreadable"): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code.toLowerCase() : fallback;
}

/** The path a file system error names, else `fallback`. */
export function errorPath(err: unknown, fallback: string): string {
  const path = (err as { path?: unknown } | null)?.path;
  return typeof path === "string" && path !== "" ? path : fallback;
}

/**
 * The faults of the methods the resolver refused, as a problem's items: one per reason, coded
 * `method.package_invalid`, since every check the resolver makes is a rule of the method's
 * package, its `METHODS.toml` among them.
 */
function skippedItems(skipped: readonly SkippedMethodReport[]): ProblemItem[] {
  return skipped.flatMap((method) =>
    method.errors.map((reason) => ({
      code: "method.package_invalid",
      detail: `Method '${method.name}': ${reason}`,
    })),
  );
}

/**
 * The problem of a `--method` the resolved repository cannot give: `method.invalid` holding the
 * reasons the resolver refused it for, when it found the method, else `method.not_found`.
 * `reader` is whose step the problem carries: the method's author's (`actor`) or someone else's.
 */
export function unusableMethodProblem(
  resolved: ResolvedRepo,
  name: string,
  reader: StepReader = "other",
): Problem {
  const message = describeUnusableMethod(resolved, name);
  if (findSkippedMethod(resolved, name) !== undefined) {
    const refused = skippedMethodReports(resolved).filter((method) => method.name === name);
    return agentProblem("method.invalid", {}, message, { reader, errors: skippedItems(refused) });
  }
  return agentProblem("method.not_found", { method_ref: name }, message);
}

/**
 * The problem of a repository with no method a command can use: `method.invalid` holding the
 * reasons the resolver refused each of its methods for, else, when it refused none,
 * `method.not_found` naming the repository.
 */
export function noUsableMethodProblem(
  resolved: ResolvedRepo,
  ref: string,
  message: string,
  reader: StepReader = "other",
): Problem {
  const refused = skippedMethodReports(resolved);
  if (refused.length > 0) {
    return agentProblem("method.invalid", {}, message, { reader, errors: skippedItems(refused) });
  }
  return agentProblem("method.not_found", { method_ref: ref }, message);
}

/** The problem one answer of mthds.sh's registry route reads as, when it lists nothing. */
function registrationProblem(
  answer: RegistrationAnswer,
  facts: { hubUrl: string; orgRepo: string; message: string },
): Problem {
  const { hubUrl, orgRepo, message } = facts;
  if (answer.outcome === "refused") {
    switch (answer.reason) {
      case "repository_not_found":
        return agentProblem("method.not_found", { method_ref: orgRepo }, message);
      case "method_not_found":
        return agentProblem("method.not_found", { method_ref: orgRepo }, message);
      case "repository_not_public":
        return agentProblem(
          "client.argument_invalid",
          { argument: "address", reason: "private_repository" },
          message,
        );
      case "manifest_invalid":
        return agentProblem("method.package_invalid", { reason: "manifest_invalid" }, message, {
          reader: "other",
        });
      default:
        return agentProblem("runtime.unexpected", {}, message);
    }
  }
  if (answer.outcome === "error") {
    if (answer.error.code === "unreachable") {
      return agentProblem("client.unreachable", { base_url: hubUrl }, message);
    }
    if (answer.error.retryable) {
      return agentProblem("runtime.unavailable", {}, message);
    }
  }
  return agentProblem("runtime.unexpected", {}, message);
}

/**
 * The problem of a publish mthds.sh listed none of the methods of: the code every answer reads as
 * when they agree, such as `runtime.unavailable` when every one is an error worth retrying, else
 * `runtime.unexpected`. `message` lists the answers, method by method.
 */
export function registrationsProblem(
  registrations: MethodRegistration[],
  facts: { hubUrl: string; orgRepo: string; message: string },
): Problem {
  const problems = registrations.map((registration) =>
    registrationProblem(registration.answer, facts),
  );
  const first = problems[0];
  if (first !== undefined && problems.every((problem) => problem.code === first.code)) {
    return first;
  }
  return agentProblem("runtime.unexpected", {}, facts.message);
}
