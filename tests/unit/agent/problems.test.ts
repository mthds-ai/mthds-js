import { describe, expect, it } from "vitest";
import {
  errorPath,
  fileErrorReason,
  noUsableMethodProblem,
  registrationsProblem,
  resolveFailureProblem,
  toolInstallProblem,
  unusableMethodProblem,
} from "../../../src/agent/problems.js";
import { ToolInstallError } from "../../../src/installer/runtime/exceptions.js";
import { MethodResolveError } from "../../../src/installer/resolver/exceptions.js";
import type { MethodRegistration } from "../../../src/installer/registry/client.js";
import type { ResolvedMethod, ResolvedRepo } from "../../../src/package/manifest/types.js";

// The problems the mthds-agent commands share: a file the system refused, a method the resolver
// could not use, and a publish mthds.sh listed nothing of, each coded from the core registry.

function resolvedWith(methods: string[], skipped: ResolvedRepo["skipped"] = []): ResolvedRepo {
  return {
    methods: methods.map((name) => ({ name }) as unknown as ResolvedMethod),
    skipped,
    source: "local",
    repoName: "org/repo",
    isPublic: true,
  };
}

describe("fileErrorReason", () => {
  it("reads a system error code in lower case", () => {
    expect(fileErrorReason(Object.assign(new Error("no"), { code: "ENOENT" }))).toBe("enoent");
    expect(fileErrorReason(Object.assign(new Error("no"), { code: "EACCES" }))).toBe("eacces");
  });

  it("reads an error with no system code, or an odd one, as unreadable", () => {
    expect(fileErrorReason(new Error("no"))).toBe("unreadable");
    expect(fileErrorReason({ code: "not a code" })).toBe("unreadable");
    expect(fileErrorReason({ code: 42 })).toBe("unreadable");
    expect(fileErrorReason(null)).toBe("unreadable");
    expect(fileErrorReason(undefined)).toBe("unreadable");
  });
});

describe("errorPath", () => {
  it("reads the path a file system error names", () => {
    expect(errorPath(Object.assign(new Error("no"), { path: "/tmp/x" }), "fallback")).toBe(
      "/tmp/x",
    );
  });

  it("falls back when the error names no path", () => {
    expect(errorPath(new Error("no"), "fallback")).toBe("fallback");
    expect(errorPath({ path: "" }, "fallback")).toBe("fallback");
    expect(errorPath({ path: 7 }, "fallback")).toBe("fallback");
    expect(errorPath(null, "fallback")).toBe("fallback");
  });
});

describe("toolInstallProblem", () => {
  it("reads an install that ran and failed as runtime.unavailable, worth a retry", () => {
    const err = new ToolInstallError("uv tool install failed", "install_failed", "pipelex");
    expect(toolInstallProblem(err, "pipelex", "Failed")).toMatchObject({
      code: "runtime.unavailable",
      retry: "yes",
      message: "Failed",
    });
  });

  it("reads a missing uv as client.tool_missing naming uv", () => {
    const err = new ToolInstallError("uv is required", "uv_missing", "uv");
    expect(toolInstallProblem(err, "pipelex", "Failed")).toMatchObject({
      code: "client.tool_missing",
      params: { tool: "uv" },
    });
  });

  it("reads a tool still off the PATH, or a failure it did not read, as client.tool_missing", () => {
    const err = new ToolInstallError("not found in PATH", "not_on_path", "pipelex");
    expect(toolInstallProblem(err, "pipelex", "Failed")).toMatchObject({
      code: "client.tool_missing",
      params: { tool: "pipelex" },
    });
    expect(toolInstallProblem(new Error("boom"), "plxt", "Failed")).toMatchObject({
      code: "client.tool_missing",
      params: { tool: "plxt" },
    });
  });
});

describe("resolveFailureProblem", () => {
  it("reads a source with nothing there as method.not_found naming the reference", () => {
    const err = new MethodResolveError("Repository not found.", "not_found");
    expect(resolveFailureProblem(err, "acme/tools", "Failed: gone")).toMatchObject({
      code: "method.not_found",
      params: { method_ref: "acme/tools" },
      retry: "no",
      message: "Failed: gone",
    });
  });

  it("reads GitHub unreachable, rate limited or failing as method.fetch_failed, worth a retry", () => {
    const err = new MethodResolveError("GitHub API error 503.", "fetch_failed");
    expect(resolveFailureProblem(err, "acme/tools", "Failed")).toMatchObject({
      code: "method.fetch_failed",
      params: { method_ref: "acme/tools" },
      domain: "runtime",
      retry: "yes",
    });
  });

  it("reads a refused token as client.not_configured naming its setting", () => {
    const err = new MethodResolveError("401", "not_configured", { setting: "GITHUB_TOKEN" });
    expect(resolveFailureProblem(err, "acme/tools", "Failed")).toMatchObject({
      code: "client.not_configured",
      params: { setting: "GITHUB_TOKEN" },
    });
  });

  it("reads a local path the system refused as client.file_unreadable with its reason", () => {
    const err = new MethodResolveError("Cannot read", "unreadable", {
      path: "/srv/methods",
      fsCode: "EACCES",
    });
    expect(resolveFailureProblem(err, "/srv", "Failed")).toMatchObject({
      code: "client.file_unreadable",
      params: { path: "/srv/methods", reason: "eacces" },
    });
  });

  it("reads a failure the resolver did not read as runtime.unexpected", () => {
    expect(resolveFailureProblem(new TypeError("boom"), "acme/tools", "Failed")).toMatchObject({
      code: "runtime.unexpected",
      message: "Failed",
    });
  });
});

describe("unusableMethodProblem", () => {
  it("is method.invalid holding one item per reason for a method the resolver refused", () => {
    const resolved = resolvedWith(
      ["good"],
      [
        { dirName: "legacy", errors: ["Too old.", "No main pipe."] },
        { dirName: "other", errors: ["Broken."] },
      ],
    );
    const problem = unusableMethodProblem(resolved, "legacy");
    expect(problem).toMatchObject({ code: "method.invalid", domain: "method" });
    expect(problem).not.toHaveProperty("params");
    expect(problem.errors).toEqual([
      { code: "method.package_invalid", detail: "Method 'legacy': Too old." },
      { code: "method.package_invalid", detail: "Method 'legacy': No main pipe." },
    ]);
    expect(problem.message).toContain('Method "legacy" was found but skipped');
    expect(problem.message).toContain("Too old.");
    // By default the person running the command is not the method's author.
    expect(problem.next_step.kind).toBe("contact_owner");
  });

  it("carries the author's step when the reader is the method's author", () => {
    const resolved = resolvedWith([], [{ dirName: "legacy", errors: ["Too old."] }]);
    expect(unusableMethodProblem(resolved, "legacy", "actor").next_step.kind).toBe("change_method");
  });

  it("is method.not_found naming the method for a name in neither list, listing the others", () => {
    const problem = unusableMethodProblem(resolvedWith(["alpha", "beta"]), "gamma");
    expect(problem).toMatchObject({
      code: "method.not_found",
      domain: "input",
      params: { method_ref: "gamma" },
    });
    expect(problem).not.toHaveProperty("errors");
    expect(problem.message).toBe('Method "gamma" not found. Available methods: alpha, beta');
  });
});

describe("noUsableMethodProblem", () => {
  it("is method.invalid holding the reasons of every refused method", () => {
    const resolved = resolvedWith(
      [],
      [
        { dirName: "a", errors: ["Too old."] },
        { dirName: "b", errors: ["Broken."] },
      ],
    );
    const problem = noUsableMethodProblem(resolved, "org/repo", "No valid methods to install.");
    expect(problem).toMatchObject({
      code: "method.invalid",
      message: "No valid methods to install.",
      errors: [
        { code: "method.package_invalid", detail: "Method 'a': Too old." },
        { code: "method.package_invalid", detail: "Method 'b': Broken." },
      ],
    });
    expect(problem.next_step.kind).toBe("contact_owner");
    expect(noUsableMethodProblem(resolved, "org/repo", "x", "actor").next_step.kind).toBe(
      "change_method",
    );
  });

  it("is method.not_found naming the repository when the resolver refused nothing", () => {
    expect(noUsableMethodProblem(resolvedWith([]), "org/repo", "Nothing here.")).toMatchObject({
      code: "method.not_found",
      params: { method_ref: "org/repo" },
      message: "Nothing here.",
    });
  });
});

describe("registrationsProblem", () => {
  const facts = {
    hubUrl: "http://127.0.0.1:8787",
    orgRepo: "org/repo",
    message: "Nothing was published.",
  };

  function refused(name: string, reason: string): MethodRegistration {
    return { name, answer: { outcome: "refused", reason, message: reason, errors: [] } };
  }

  function failed(name: string, code: string, retryable: boolean): MethodRegistration {
    return { name, answer: { outcome: "error", error: { code, message: code, retryable } } };
  }

  it("reads every answer alike when they agree", () => {
    expect(
      registrationsProblem(
        [refused("a", "method_not_found"), refused("b", "repository_not_found")],
        facts,
      ),
    ).toMatchObject({
      code: "method.not_found",
      params: { method_ref: "org/repo" },
      message: "Nothing was published.",
    });
  });

  it.each([
    ["repository_not_public", "client.argument_invalid"],
    ["manifest_invalid", "method.package_invalid"],
    ["repository_blocked", "runtime.unexpected"],
  ] as const)("reads a refusal for %s as %s", (reason, code) => {
    expect(registrationsProblem([refused("a", reason)], facts).code).toBe(code);
  });

  it("reads a hub that could not be reached as client.unreachable at the hub's URL", () => {
    expect(registrationsProblem([failed("a", "unreachable", true)], facts)).toMatchObject({
      code: "client.unreachable",
      params: { base_url: "http://127.0.0.1:8787" },
    });
  });

  it("reads errors worth retrying as runtime.unavailable", () => {
    const problem = registrationsProblem(
      [failed("a", "rate_limited", true), failed("b", "internal", true)],
      facts,
    );
    expect(problem).toMatchObject({ code: "runtime.unavailable", retry: "yes", params: {} });
  });

  it("reads an error not worth retrying as runtime.unexpected", () => {
    expect(registrationsProblem([failed("a", "unexpected_response", false)], facts).code).toBe(
      "runtime.unexpected",
    );
  });

  it("falls back to runtime.unexpected when the answers disagree", () => {
    const problem = registrationsProblem(
      [refused("a", "method_not_found"), failed("b", "unreachable", true)],
      facts,
    );
    expect(problem).toMatchObject({
      code: "runtime.unexpected",
      message: "Nothing was published.",
    });
  });

  it("falls back to runtime.unexpected when there is no answer at all", () => {
    expect(registrationsProblem([], facts).code).toBe("runtime.unexpected");
  });
});
