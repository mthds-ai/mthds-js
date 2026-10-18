/**
 * The problems of failures the mthds-agent commands share: a local file the system refused, a
 * method source the resolver could not read, a method it could not use, and a publish mthds.sh
 * listed nothing of. Each is coded from the core registry (docs/errors.md), with the command's own
 * sentence in `message`.
 */

import { agentProblem } from "./output.js";
import {
  describeUnusableMethod,
  findSkippedMethod,
  skippedMethodReports,
} from "../installer/resolver/skipped.js";
import type { SkippedMethodReport } from "../installer/resolver/skipped.js";
import { MethodResolveError, systemErrorCode } from "../installer/resolver/exceptions.js";
import { ToolInstallError } from "../installer/runtime/exceptions.js";
import type { MethodRegistration, RegistrationAnswer } from "../installer/registry/client.js";
import type { ResolvedRepo } from "../package/manifest/types.js";
import type { StepReader } from "../problems/build.js";
import type { Problem, ProblemItem } from "../problems/types.js";

/**
 * The reason a file could not be read or written, from the system's error code (`systemErrorCode`):
 * `ENOENT` reads `enoent`. An error with no such code reads as `fallback`: `unreadable` for a read,
 * by default, and `unwritable` for a write.
 */
export function fileErrorReason(err: unknown, fallback = "unreadable"): string {
  return systemErrorCode(err)?.toLowerCase() ?? fallback;
}

/** The path a file system error names, else `fallback`. */
export function errorPath(err: unknown, fallback: string): string {
  const path = (err as { path?: unknown } | null)?.path;
  return typeof path === "string" && path !== "" ? path : fallback;
}

/**
 * The problem of a tool `tool` that could not be installed: `client.tool_missing`, as the core
 * registry reads a tool that is missing, cannot be spawned or failed to install, naming `uv` when
 * uv itself is missing, and the tool when the install ran and failed or succeeded with the tool
 * still not on the PATH. `tool` is the program a command runs, such as `plxt`, which the problem's
 * message and recovery talk about, never the package uv installs it from, `pipelex-tools`. The
 * command's sentence in `message` says which.
 */
export function toolInstallProblem(err: unknown, tool: string, message: string): Problem {
  const missing = err instanceof ToolInstallError && err.reason === "uv_missing" ? err.tool : tool;
  return agentProblem("client.tool_missing", { tool: missing }, message);
}

/**
 * The problem of a method source the resolver could not read, `ref` being the address or the
 * directory the command was given: `method.not_found` when nothing is there, `method.fetch_failed`
 * when GitHub could not be reached, refused for now or failed, which a later attempt may get past,
 * `client.not_configured` when GitHub refused the token, and `client.file_unreadable` when the
 * system refused a local path. A failure the resolver did not read is `runtime.unexpected`.
 */
export function resolveFailureProblem(err: unknown, ref: string, message: string): Problem {
  if (!(err instanceof MethodResolveError)) {
    return agentProblem("runtime.unexpected", {}, message);
  }
  switch (err.reason) {
    case "not_found":
      return agentProblem("method.not_found", { method_ref: ref }, message);
    case "fetch_failed":
      return agentProblem("method.fetch_failed", { method_ref: ref }, message);
    case "not_configured":
      return agentProblem(
        "client.not_configured",
        { setting: err.setting ?? "GITHUB_TOKEN" },
        message,
      );
    case "unreadable":
      return agentProblem(
        "client.file_unreadable",
        {
          path: err.path ?? ref,
          reason: fileErrorReason({ code: err.fsCode }),
        },
        message,
      );
  }
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

/**
 * The problem one answer of mthds.sh's registry route reads as, when it lists nothing: a missing
 * repository names the repository, and a missing method the method, by its address in the
 * repository (`<owner>/<repo>/<method>`).
 */
function registrationProblem(
  registration: MethodRegistration,
  facts: { hubUrl: string; orgRepo: string; message: string },
): Problem {
  const { hubUrl, orgRepo, message } = facts;
  const answer: RegistrationAnswer = registration.answer;
  if (answer.outcome === "refused") {
    switch (answer.reason) {
      case "repository_not_found":
        return agentProblem("method.not_found", { method_ref: orgRepo }, message);
      case "method_not_found":
        return agentProblem(
          "method.not_found",
          { method_ref: `${orgRepo}/${registration.name}` },
          message,
        );
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
 * The problem of a publish mthds.sh listed none of the methods of: the problem every answer reads
 * as when they agree, such as `runtime.unavailable` when every one is an error worth retrying, and
 * `method.not_found` naming the repository when every one is missing but they name different
 * methods, `runtime.unavailable` when they disagree but every one is worth retrying, such as a hub
 * unreachable for one method and rate limited for another, else `runtime.unexpected`. `message`
 * lists the answers, method by method.
 */
export function registrationsProblem(
  registrations: MethodRegistration[],
  facts: { hubUrl: string; orgRepo: string; message: string },
): Problem {
  const problems = registrations.map((registration) => registrationProblem(registration, facts));
  const first = problems[0];
  if (first !== undefined && problems.every((problem) => problem.code === first.code)) {
    const sameParams = problems.every(
      (problem) => JSON.stringify(problem.params) === JSON.stringify(first.params),
    );
    if (sameParams) return first;
    if (first.code === "method.not_found") {
      return agentProblem("method.not_found", { method_ref: facts.orgRepo }, facts.message);
    }
  }
  if (first !== undefined && problems.every((problem) => problem.retry === "yes")) {
    return agentProblem("runtime.unavailable", {}, facts.message);
  }
  return agentProblem("runtime.unexpected", {}, facts.message);
}
