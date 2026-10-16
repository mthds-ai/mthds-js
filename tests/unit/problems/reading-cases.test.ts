/**
 * The shared reading cases: every answer, and every failure to get one, of
 * tests/fixtures/problem-reading-cases.json put through `MthdsApiClient`, each expected to read as
 * the exact problem the case pins. The file is the Python twin's (mthds-python
 * tests/data/problem-reading-cases.json), copied byte for byte, so both clients read every case
 * the same way. A case may also pin how the problem reads into the closed lists, in `reading`: its
 * domain, retry verdict and step kind as `problemDomain`, `problemRetry` and `problemStepKind`
 * read them, a value the problem was received with that this reader does not know included.
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MthdsApiClient } from "../../../src/runners/api/client.js";
import { ProblemError } from "../../../src/problems/errors.js";
import { isProblem } from "../../../src/problems/read.js";
import { codeFamily, isCoreErrorCode } from "../../../src/problems/registry.js";
import { problemDomain, problemRetry, problemStepKind } from "../../../src/problems/reading.js";
import type { Problem } from "../../../src/problems/types.js";
import {
  EXTENSION_PREFIXES,
  MTHDS_ERROR_REGISTRY_VERSION,
} from "../../../src/problems/registry.generated.js";

// The constructor's environment must not reach the real ~/.mthds/config.
vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/config/config.js")>();
  return { ...original, findLegacyUrlKey: () => undefined, findLegacyApiKeyKey: () => undefined };
});

const DEFAULT_BASE_URL = "http://localhost:8081";

interface ResponseInput {
  kind: "response";
  route: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}
interface UnreachableInput {
  kind: "unreachable";
  base_url: string;
}
interface TimeoutInput {
  kind: "timeout";
  seconds: number;
}
interface LostAfterSendInput {
  kind: "lost_after_send";
  route: string;
}
/** How the problem a case reads as reads into the closed lists, when the case pins it. */
interface ExpectedReading {
  domain?: string;
  retry?: string;
  step_kind?: string;
}
interface ReadingCase {
  name: string;
  description: string;
  input: ResponseInput | UnreachableInput | TimeoutInput | LostAfterSendInput;
  expected: Record<string, unknown>;
  reading?: ExpectedReading;
}

const CASE_FILE = JSON.parse(
  readFileSync(new URL("../../fixtures/problem-reading-cases.json", import.meta.url), "utf-8"),
) as { registry_version: string; cases: ReadingCase[] };

/** Call the client's method for a route the cases name, as `POST /execute`. */
function callRoute(client: MthdsApiClient, route: string): Promise<unknown> {
  switch (route) {
    case "POST /execute":
      return client.execute({ pipe_code: "summarize", mthds_contents: ['domain = "demo"'] });
    case "POST /start":
      return client.start({ pipe_code: "summarize", mthds_contents: ['domain = "demo"'] });
    case "POST /validate":
      return client.validate(['domain = "demo"']);
    case "GET /models":
      return client.models();
    case "GET /version":
      return client.version();
    default:
      throw new Error(`No client method for the route ${route}`);
  }
}

/** What fetch throws when a step of the connection fails, as undici reports it. */
function fetchFailure(cause: { code: string; syscall: string }): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(cause.code), cause) });
}

/** Run a case through the client and return the problem its error carries. */
async function readCase(input: ReadingCase["input"]): Promise<unknown> {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  let call: Promise<unknown>;
  switch (input.kind) {
    case "response": {
      const { status, headers, body } = input;
      fetchSpy.mockImplementation(async () => new Response(body, { status, headers }));
      call = callRoute(new MthdsApiClient({ baseUrl: DEFAULT_BASE_URL }), input.route);
      break;
    }
    case "unreachable":
      fetchSpy.mockRejectedValue(fetchFailure({ code: "ECONNREFUSED", syscall: "connect" }));
      call = callRoute(new MthdsApiClient({ baseUrl: input.base_url }), "GET /models");
      break;
    case "lost_after_send":
      fetchSpy.mockRejectedValue(fetchFailure({ code: "ECONNRESET", syscall: "read" }));
      call = callRoute(new MthdsApiClient({ baseUrl: DEFAULT_BASE_URL }), input.route);
      break;
    case "timeout": {
      vi.useFakeTimers();
      fetchSpy.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      );
      call = callRoute(new MthdsApiClient({ baseUrl: DEFAULT_BASE_URL }), "GET /models");
      const settled = call.catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(input.seconds * 1000);
      const err = await settled;
      expect(err).toBeInstanceOf(ProblemError);
      return (err as ProblemError).problem;
    }
  }
  const err = await call.then(
    () => undefined,
    (failure: unknown) => failure,
  );
  expect(err, "the call must fail").toBeInstanceOf(ProblemError);
  return (err as ProblemError).problem;
}

/** Whether a code is the core registry's or under one of its registered extension prefixes. */
function isRegisteredCode(code: string): boolean {
  return (
    isCoreErrorCode(code) || EXTENSION_PREFIXES.some((ext) => code.startsWith(`${ext.prefix}.`))
  );
}

describe("the shared problem reading cases", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("are written against the vendored registry's version", () => {
    expect(CASE_FILE.registry_version).toBe(MTHDS_ERROR_REGISTRY_VERSION);
  });

  it.each(CASE_FILE.cases.map((c) => [c.name, c] as const))("%s", async (_name, readingCase) => {
    const problem = await readCase(readingCase.input);
    expect(problem).toEqual(readingCase.expected);
    expect(isProblem(problem), "the problem read is a problem document").toBe(true);
    const reading = readingCase.reading;
    if (reading !== undefined) {
      const read = problem as Problem;
      if (reading.domain !== undefined) expect(problemDomain(read), "domain").toBe(reading.domain);
      if (reading.retry !== undefined) expect(problemRetry(read), "retry").toBe(reading.retry);
      if (reading.step_kind !== undefined) {
        expect(problemStepKind(read), "step kind").toBe(reading.step_kind);
      }
    }
  });

  it("expect only problems a client builds with a registered code, or codes received as sent", () => {
    for (const readingCase of CASE_FILE.cases) {
      const code = readingCase.expected.code as string;
      if (readingCase.input.kind === "response" && readingCase.input.body.includes(`"${code}"`)) {
        continue; // read as received, whatever its code
      }
      expect(isRegisteredCode(code), `${readingCase.name}: ${code}`).toBe(true);
      expect(codeFamily(code)).not.toBe("");
    }
  });
});
