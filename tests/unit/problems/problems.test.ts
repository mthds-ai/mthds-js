/**
 * Reading, building and rendering a problem: the fallbacks a reader applies to values it does not
 * know, the problem a client builds from the registry, the JSON reader's limits, the reading of a
 * status the body does not explain, and what a rendering states.
 */

import { describe, expect, it } from "vitest";
import { buildProblem, defaultStepReader, renderTemplate } from "../../../src/problems/build.js";
import { argumentInvalid, problemError, ProblemError } from "../../../src/problems/errors.js";
import {
  MAX_BODY_NESTING,
  isProblem,
  isProblemItem,
  parseJsonBody,
  parseHttpDate,
  readAnswer,
  readErrorAnswer,
  retryAfterSeconds,
} from "../../../src/problems/read.js";
import {
  fixSafety,
  isApplicableFix,
  itemDomain,
  problemDomain,
  problemRetry,
  problemStepKind,
} from "../../../src/problems/reading.js";
import { CORE_REGISTRY } from "../../../src/problems/registry.generated.js";
import { codeFamily, familyEntries } from "../../../src/problems/registry.js";
import { renderProblemLines, renderProblemMarkdown } from "../../../src/problems/render.js";
import type { Problem, ProblemItem, SuggestedFix } from "../../../src/problems/types.js";

/** The families whose known codes all share one domain, and those whose codes disagree. */
function familiesByDomainAgreement(): { unanimous: [string, string][]; mixed: string[] } {
  const families = new Set(Object.keys(CORE_REGISTRY).map(codeFamily));
  const unanimous: [string, string][] = [];
  const mixed: string[] = [];
  for (const family of families) {
    const domains = new Set(familyEntries(family).map((entry) => entry.domain));
    if (domains.size === 1) unanimous.push([family, [...domains][0]!]);
    else mixed.push(family);
  }
  return { unanimous, mixed };
}

const MINIMAL_PROBLEM: Problem = {
  type: "https://mthds.ai/errors/runtime.unexpected",
  title: "An unexpected error",
  detail: "Something failed.",
  code: "runtime.unexpected",
  domain: "runtime",
  retry: "no",
  next_step: { kind: "report", detail: "Report it." },
};

const FIX: SuggestedFix = {
  fix_code: "rename-key",
  description: "Rename the key.",
  safety: "safe",
  ops: [{ kind: "rename_table_key", table_path: ["pipe"], key: "a", new_key: "b" }],
};

describe("reading a value this reader does not know", () => {
  it("reads an unknown domain as its family's when the family's codes agree", () => {
    const { unanimous } = familiesByDomainAgreement();
    expect(unanimous.length).toBeGreaterThan(0);
    for (const [family, domain] of unanimous) {
      expect(problemDomain({ code: `${family}.not_yet_listed`, domain: "galaxy" })).toBe(domain);
    }
  });

  it("reads an unknown domain as runtime when the family's codes disagree or the family is unknown", () => {
    const { mixed } = familiesByDomainAgreement();
    for (const family of mixed) {
      expect(problemDomain({ code: `${family}.not_yet_listed`, domain: "galaxy" })).toBe("runtime");
    }
    expect(problemDomain({ code: "quorum.lost", domain: "galaxy" })).toBe("runtime");
  });

  it("keeps a known domain, whatever the code's family says", () => {
    expect(problemDomain({ code: "quorum.lost", domain: "account" })).toBe("account");
  });

  it("reads an unknown retry as no, never as a repeat", () => {
    expect(problemRetry({ retry: "later" })).toBe("no");
    expect(problemRetry({ retry: "outcome_unknown" })).toBe("outcome_unknown");
  });

  it("reads an unknown step kind as report when the family gives no shared one", () => {
    expect(problemStepKind({ code: "quorum.lost", next_step: { kind: "pray" } })).toBe("report");
    expect(problemStepKind({ code: "quorum.lost", next_step: { kind: "wait" } })).toBe("wait");
  });

  it("reads an item's domain from its code", () => {
    expect(itemDomain({ code: "method.invalid" })).toBe(CORE_REGISTRY["method.invalid"].domain);
    expect(itemDomain({ code: "quorum.lost" })).toBe("runtime");
  });

  it("reads an unknown fix safety as unsafe and refuses a fix holding an unknown operation", () => {
    expect(fixSafety({ safety: "probably" })).toBe("unsafe");
    expect(isApplicableFix(FIX)).toBe(true);
    const unknownOp = { ...FIX, ops: [{ kind: "rewrite_reference", to: "x" }] } as SuggestedFix;
    expect(isApplicableFix(unknownOp)).toBe(false);
  });
});

describe("building a problem from the registry", () => {
  it("fills the templates, carries the caller's step and writes no status for a client code", () => {
    const params = { argument: "--type", reason: "unknown_value" };
    const entry = CORE_REGISTRY["client.argument_invalid"];
    const problem = buildProblem("client.argument_invalid", params);
    expect(problem).toEqual({
      type: "https://mthds.ai/errors/client.argument_invalid",
      title: entry.title,
      detail: renderTemplate(entry.detail, params),
      code: "client.argument_invalid",
      domain: "input",
      retry: "no",
      next_step: {
        kind: entry.steps.actor.kind,
        detail: renderTemplate(entry.steps.actor.detail, params),
      },
      params,
    });
    expect(Object.keys(problem)).toEqual([
      "type",
      "title",
      "detail",
      "code",
      "domain",
      "retry",
      "next_step",
      "params",
    ]);
  });

  it("chooses the step of the domain's reader, unless the caller names one", () => {
    expect(defaultStepReader("input")).toBe("actor");
    expect(defaultStepReader("runtime")).toBe("actor");
    expect(defaultStepReader("method")).toBe("other");
    expect(defaultStepReader("account")).toBe("other");
    expect(defaultStepReader("operator")).toBe("other");
    const forAuthor = buildProblem("method.invalid", {}, { reader: "actor" });
    expect(forAuthor.next_step.detail).toBe(CORE_REGISTRY["method.invalid"].steps.actor.detail);
  });

  it("leaves an operator-only parameter out, so a code declaring parameters may carry none", () => {
    const problem = buildProblem("runtime.unavailable", { dependency: "the database" });
    expect(problem.params).toEqual({});
    expect(JSON.stringify(problem)).not.toContain("the database");
  });

  it("writes no params member for a code that declares none", () => {
    expect(buildProblem("method.invalid", {})).not.toHaveProperty("params");
  });

  it("keeps retry_after only beside a retry of yes", () => {
    expect(buildProblem("runtime.unavailable", {}, { retryAfter: 5 }).retry_after).toBe(5);
    expect(buildProblem("method.invalid", {}, { retryAfter: 5 })).not.toHaveProperty("retry_after");
  });

  it("writes extras after the core members and never over them", () => {
    const problem = buildProblem(
      "method.invalid",
      {},
      { extra: { message: "Own words.", code: "x" } },
    );
    expect(problem.code).toBe("method.invalid");
    expect(problem.message).toBe("Own words.");
    expect(Object.keys(problem).at(-1)).toBe("message");
  });

  it("joins a list parameter and keeps a doubled brace literal", () => {
    expect(renderTemplate("Pick {candidates}.", { candidates: ["a", "b"] })).toBe("Pick a, b.");
    expect(renderTemplate("A {{literal}} and {name}.", { name: "x" })).toBe("A {literal} and x.");
  });

  it("refuses a lone brace, opening or closing, and an unclosed placeholder", () => {
    expect(() => renderTemplate("A lone } here.", {})).toThrow(/lone brace/);
    expect(() => renderTemplate("A lone { here.", {})).toThrow(/lone brace/);
    expect(() => renderTemplate("An {unclosed", { unclosed: "x" })).toThrow(/lone brace/);
  });

  it("refuses a template naming a parameter the occurrence does not give", () => {
    expect(() => renderTemplate("A {missing} one.", {})).toThrow(/'missing', which is not given/);
    expect(() => renderTemplate("A {gone} one.", { gone: undefined })).toThrow(/not given/);
  });

  it("builds every core code with its required parameters, so no template names an optional one", () => {
    for (const entry of Object.values(CORE_REGISTRY)) {
      const params = Object.fromEntries(
        Object.entries(entry.params)
          .filter(([, spec]) => spec.optional !== true && spec.operator_only !== true)
          .map(([name]) => [name, "x"]),
      );
      expect(() => buildProblem(entry.code as never, params as never), entry.code).not.toThrow();
    }
  });
});

describe("the JSON reader", () => {
  it("refuses the NaN constant, which JSON does not define", () => {
    expect(parseJsonBody('{"load":NaN}').ok).toBe(false);
  });

  it("scans an unterminated string of escaped quotes in linear time", () => {
    const body = `"${'\\"'.repeat(40_000)}${"[".repeat(MAX_BODY_NESTING * 2)}`;
    const started = Date.now();
    expect(parseJsonBody(body).ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("reads an escaped quote as part of its string, so brackets after it stay inside", () => {
    const text = JSON.stringify({ text: `\\"${"[".repeat(MAX_BODY_NESTING * 2)}` });
    expect(parseJsonBody(text).ok).toBe(true);
    // An escaped backslash ends no string, so the quote after it closes the string.
    const escapedBackslash = String.raw`{"a":"\\","b":[1]}`;
    expect(parseJsonBody(escapedBackslash)).toEqual({ ok: true, value: { a: "\\", b: [1] } });
  });

  it("refuses a body nested deeper than its limit, and counts no bracket inside a string", () => {
    const deep = "[".repeat(MAX_BODY_NESTING + 1) + "]".repeat(MAX_BODY_NESTING + 1);
    expect(parseJsonBody(deep).ok).toBe(false);
    const atLimit = "[".repeat(MAX_BODY_NESTING) + "]".repeat(MAX_BODY_NESTING);
    expect(parseJsonBody(atLimit).ok).toBe(true);
    expect(parseJsonBody(JSON.stringify({ text: "[".repeat(MAX_BODY_NESTING * 2) })).ok).toBe(true);
  });

  it("reads a problem document by the shared schema, refusing a mistyped core member", () => {
    expect(isProblem(MINIMAL_PROBLEM)).toBe(true);
    expect(isProblem({ ...MINIMAL_PROBLEM, status: "422" })).toBe(false);
    expect(isProblem({ ...MINIMAL_PROBLEM, next_step: undefined })).toBe(false);
    expect(isProblem({ ...MINIMAL_PROBLEM, domain: "galaxy", retry: "later" })).toBe(true);
    expect(isProblem({ ...MINIMAL_PROBLEM, errors: [{ code: "method.invalid" }] })).toBe(false);
  });

  it("reads an item with its location and suggested fix, refusing a mistyped location", () => {
    const item: ProblemItem = {
      code: "method.invalid",
      detail: "Broken.",
      location: { file: "a.mthds", line: 3 },
      suggested_fix: FIX,
    };
    expect(isProblemItem(item)).toBe(true);
    expect(isProblemItem({ ...item, location: { line: "3" } })).toBe(false);
  });
});

describe("reading Retry-After", () => {
  it("reads delta-seconds and an HTTP date, never fewer than zero", () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    expect(retryAfterSeconds({ "retry-after": "7" }, now)).toBe(7);
    expect(retryAfterSeconds({ "Retry-After": "Fri, 16 Oct 2026 12:00:30 GMT" }, now)).toBe(30);
    expect(retryAfterSeconds({ "retry-after": "Fri, 16 Oct 2026 11:00:00 GMT" }, now)).toBe(0);
    expect(retryAfterSeconds({ "retry-after": "soon" }, now)).toBeUndefined();
    expect(retryAfterSeconds({}, now)).toBeUndefined();
  });
});

describe("parseHttpDate", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const moment = Date.parse("1994-11-06T08:49:37Z");

  it.each([
    ["the IMF-fixdate", "Sun, 06 Nov 1994 08:49:37 GMT"],
    ["the RFC 850 form", "Sunday, 06-Nov-94 08:49:37 GMT"],
    ["the asctime form", "Sun Nov  6 08:49:37 1994"],
  ])("reads %s", (_form, text) => {
    expect(parseHttpDate(text, now)).toBe(moment);
  });

  it.each([
    ["a numeric zone", "Sun, 06 Nov 1994 08:49:37 +0000"],
    ["no day name", "06 Nov 1994 08:49:37 GMT"],
    ["a lower-case month", "Sun, 06 nov 1994 08:49:37 GMT"],
    ["a lower-case day name", "sun, 06 Nov 1994 08:49:37 GMT"],
    ["a zone other than GMT", "Sun, 06 Nov 1994 08:49:37 UTC"],
    ["a long day name in the IMF-fixdate", "Sunday, 06 Nov 1994 08:49:37 GMT"],
    ["a zone in the asctime form", "Sun Nov  6 08:49:37 1994 GMT"],
    ["a one-digit day in the IMF-fixdate", "Sun, 6 Nov 1994 08:49:37 GMT"],
    ["the 31st of February", "Sun, 31 Feb 1994 08:49:37 GMT"],
    ["the hour 24", "Sun, 06 Nov 1994 24:00:00 GMT"],
    ["the minute 60", "Sun, 06 Nov 1994 08:60:00 GMT"],
    ["the second 61", "Sun, 06 Nov 1994 08:49:61 GMT"],
    ["the year 0", "Sun, 06 Nov 0000 08:49:37 GMT"],
    ["the 29th of February of a common year", "Sun, 29 Feb 1900 08:49:37 GMT"],
    ["surrounding text", "Sun, 06 Nov 1994 08:49:37 GMT, later"],
  ])("refuses %s", (_topic, text) => {
    expect(parseHttpDate(text, now)).toBeUndefined();
  });

  it("does not check the day name against the date", () => {
    expect(parseHttpDate("Mon, 06 Nov 1994 08:49:37 GMT", now)).toBe(moment);
  });

  it("reads the 29th of February of a leap year", () => {
    expect(parseHttpDate("Tue, 29 Feb 2000 00:00:00 GMT", now)).toBe(
      Date.parse("2000-02-29T00:00:00Z"),
    );
  });

  it("counts a second of 60 as the next minute", () => {
    expect(parseHttpDate("Wed, 31 Dec 2025 23:59:60 GMT", now)).toBe(
      Date.parse("2026-01-01T00:00:00Z"),
    );
  });

  it("reads a two-digit year from 49 years before now to 50 years after", () => {
    expect(parseHttpDate("Monday, 01-Jan-76 00:00:00 GMT", now)).toBe(
      Date.parse("2076-01-01T00:00:00Z"),
    );
    expect(parseHttpDate("Friday, 01-Jan-77 00:00:00 GMT", now)).toBe(
      Date.parse("1977-01-01T00:00:00Z"),
    );
    expect(parseHttpDate("Friday, 01-Jan-26 00:00:00 GMT", now)).toBe(
      Date.parse("2026-01-01T00:00:00Z"),
    );
  });

  it("reads a year below 100 as itself", () => {
    expect(new Date(parseHttpDate("Mon, 01 Jan 0099 00:00:00 GMT", now)!).getUTCFullYear()).toBe(
      99,
    );
  });

  it("reads a leap second carrying past the year 9999 as no date, without throwing", () => {
    const header = { "retry-after": "Fri, 31 Dec 9999 23:59:60 GMT" };
    expect(() => retryAfterSeconds(header, now)).not.toThrow();
    expect(retryAfterSeconds(header, now)).toBeUndefined();
    expect(parseHttpDate("Fri, 31 Dec 9999 23:59:59 GMT", now)).toBe(
      Date.parse("9999-12-31T23:59:59Z"),
    );
  });
});

describe("readAnswer", () => {
  it("says the problem is the body's own when the body is a problem document", () => {
    const reading = readAnswer({ status: 503, headers: {}, body: JSON.stringify(MINIMAL_PROBLEM) });
    expect(reading.fromBody).toBe(true);
    expect(reading.problem.code).toBe(MINIMAL_PROBLEM.code);
  });

  it("says the problem is the client's reading when the body is none", () => {
    const reading = readAnswer({ status: 502, headers: {}, body: "<html>Bad gateway</html>" });
    expect(reading).toEqual({
      problem: expect.objectContaining({ code: "client.response_unreadable" }),
      fromBody: false,
    });
  });

  it("decides where the problem came from once, whatever the Retry-After date reads as", () => {
    const body = JSON.stringify({ ...MINIMAL_PROBLEM, retry: "yes" });
    const headers = { "retry-after": "Sun, 06 Nov 1994 08:49:37 GMT" };
    expect(readAnswer({ status: 503, headers, body }).fromBody).toBe(true);
  });

  it.each([999, 42])(
    "leaves the status out of a problem body that omits it when the answer's %s is no HTTP status",
    (status) => {
      const { status: _omitted, ...withoutStatus } = MINIMAL_PROBLEM as Record<string, unknown>;
      const read = () => readAnswer({ status, headers: {}, body: JSON.stringify(withoutStatus) });
      expect(read).not.toThrow();
      expect(read().problem.status).toBeUndefined();
      expect(read().fromBody).toBe(true);
    },
  );

  it("reads a body that is no problem, on a status that is no HTTP status, as unreadable", () => {
    const read = () => readAnswer({ status: 999, headers: {}, body: "" });
    expect(read).not.toThrow();
    expect(read().problem).toMatchObject({
      code: "client.response_unreadable",
      params: { status: 999 },
    });
  });
});

describe("reading an answer that is not the route's result", () => {
  it("keeps a problem's own retry_after over the header's", () => {
    const body = JSON.stringify({ ...MINIMAL_PROBLEM, retry: "yes", retry_after: 3 });
    const problem = readErrorAnswer({ status: 503, headers: { "retry-after": "60" }, body });
    expect(problem.retry_after).toBe(3);
  });

  it("writes the answer's status after the title when the problem leaves it out", () => {
    const problem = readErrorAnswer({
      status: 500,
      headers: {},
      body: JSON.stringify(MINIMAL_PROBLEM),
    });
    expect(Object.keys(problem).slice(0, 3)).toEqual(["type", "title", "status"]);
    expect(problem.status).toBe(500);
  });

  it("reads a status with one core code as that code, except a repeatable one on a route creating a run", () => {
    expect(readErrorAnswer({ status: 503, headers: {}, body: "" }).code).toBe(
      "runtime.unavailable",
    );
    expect(readErrorAnswer({ status: 503, headers: {}, body: "" }, { createsRun: true }).code).toBe(
      "client.outcome_unknown",
    );
    expect(readErrorAnswer({ status: 405, headers: {}, body: "" }, { createsRun: true }).code).toBe(
      "request.method_not_allowed",
    );
    expect(readErrorAnswer({ status: 418, headers: {}, body: "" })).toMatchObject({
      code: "client.response_unreadable",
      params: { status: 418 },
    });
  });

  it.each([500, 502, 503, 504, 599])(
    "reads a %i that is no problem document as client.outcome_unknown on a route creating a run",
    (status) => {
      const answer = { status, headers: {}, body: '{"message":"Endpoint request timed out"}' };
      expect(readErrorAnswer(answer, { createsRun: true })).toEqual(
        buildProblem("client.outcome_unknown", {}),
      );
      // A route that creates nothing keeps the reading by status.
      expect(readErrorAnswer(answer).code).toBe(
        status === 503 ? "runtime.unavailable" : "client.response_unreadable",
      );
    },
  );

  it("keeps a server error's problem document as received on a route creating a run", () => {
    const problem = buildProblem("runtime.unexpected", {}, { status: 500 });
    const answer = { status: 500, headers: {}, body: JSON.stringify(problem) };
    expect(readErrorAnswer(answer, { createsRun: true })).toEqual(problem);
  });

  it("reads a 4xx that is no problem document on a route creating a run by its status", () => {
    expect(
      readErrorAnswer({ status: 404, headers: {}, body: "Not Found" }, { createsRun: true }),
    ).toEqual(buildProblem("client.response_unreadable", { status: 404 }));
  });
});

describe("ProblemError", () => {
  it("takes its message from the problem's message member, else its detail, then its next step", () => {
    expect(new ProblemError(MINIMAL_PROBLEM).message).toBe("Something failed. Report it.");
    expect(new ProblemError({ ...MINIMAL_PROBLEM, message: "Own words." }).message).toBe(
      "Own words. Report it.",
    );
  });

  it("reads the code, domain, retry, step and request id of its problem", () => {
    const err = new ProblemError({
      ...MINIMAL_PROBLEM,
      domain: "galaxy",
      retry: "later",
      next_step: { kind: "pray", detail: "Hope." },
      retry_after: 4,
      request_id: "req_1",
    });
    expect(err.code).toBe("runtime.unexpected");
    expect(err.domain).toBe(problemDomain({ code: "runtime.unexpected", domain: "galaxy" }));
    expect(err.retry).toBe("no");
    expect(err.nextStep).toEqual({ kind: "report", detail: "Hope." });
    expect(err.retryAfter).toBe(4);
    expect(err.requestId).toBe("req_1");
  });

  it("is built for a client code with its message and cause", () => {
    const cause = new Error("root");
    const err = problemError(
      "client.tool_missing",
      { tool: "plxt" },
      { message: "No plxt.", cause },
    );
    expect(err.problem).toMatchObject({
      code: "client.tool_missing",
      params: { tool: "plxt" },
      message: "No plxt.",
    });
    expect(err.cause).toBe(cause);
    expect(argumentInvalid("files", "empty").problem.params).toEqual({
      argument: "files",
      reason: "empty",
    });
  });

  it("ends every message with the problem's next step, a refusal's and a configuration's included", () => {
    const refusal = argumentInvalid("files", "empty", "No files were given.");
    expect(refusal.message.endsWith(refusal.problem.next_step.detail)).toBe(true);
    expect(refusal.message.startsWith("No files were given.")).toBe(true);
    const unconfigured = problemError("client.not_configured", { setting: "api_key" });
    expect(unconfigured.message.endsWith(unconfigured.problem.next_step.detail)).toBe(true);
  });

  it("appends the next step to a sentence that holds it anywhere but at its end", () => {
    const problem = buildProblem("runtime.unexpected", {});
    const step = problem.next_step.detail;
    const err = new ProblemError({ ...problem, message: `${step} Then something else.` });
    expect(err.message).toBe(`${step} Then something else. ${step}`);
    const ending = new ProblemError({ ...problem, message: `It failed. ${step}` });
    expect(ending.message).toBe(`It failed. ${step}`);
  });
});

describe("rendering a problem", () => {
  const problem: Problem = {
    ...buildProblem("method.invalid", {}, { reader: "actor" }),
    message: "The bundle does not validate.",
    request_id: "req_9",
    pipeline_run_id: "run_1",
    errors: [
      {
        code: "method.syntax",
        detail: "Unclosed table.",
        location: { file: "a.mthds", line: 2 },
        suggested_fix: FIX,
      },
    ],
  };

  it("states the title, detail, message, next step, code, request id, run and items in Markdown", () => {
    const markdown = renderProblemMarkdown(problem);
    expect(markdown).toContain(`## ${problem.title}`);
    expect(markdown).toContain(problem.detail);
    expect(markdown).toContain("The bundle does not validate.");
    expect(markdown).toContain(
      `**Next step** (\`${problem.next_step.kind}\`): ${problem.next_step.detail}`,
    );
    expect(markdown).toContain("- Code: `method.invalid`");
    expect(markdown).toContain("Request id: `req_9`");
    expect(markdown).toContain("Run: `run_1`");
    expect(markdown).toContain("- `method.syntax`: Unclosed table. (file 'a.mthds', line 2)");
    expect(markdown).toContain("Suggested fix (safe, rename-key): Rename the key.");
  });

  it("states the same facts as plain lines", () => {
    const lines = renderProblemLines(problem);
    expect(lines[0]).toBe(`${problem.title}: ${problem.detail}`);
    expect(lines).toContain("The bundle does not validate.");
    expect(lines).toContain(`Next step: ${problem.next_step.detail}`);
    expect(lines).toContain("- method.syntax: Unclosed table. (file 'a.mthds', line 2)");
    expect(lines).toContain("  Suggested fix (safe, rename-key): Rename the key.");
  });
});
