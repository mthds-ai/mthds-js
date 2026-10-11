/**
 * The client of mthds.sh's registry route, `POST https://mthds.sh/api/v1/registry/methods`, which
 * lists a method on the hub, or refreshes one it lists, from its public GitHub repository.
 *
 * The contract is the hub's `docs/registry-api.md`: the client names one method per request, by
 * its repository's address and its `[package].name`, and branches on the answer's `outcome` alone,
 * never on the HTTP status, which is presentation. Publishing goes through this route and nothing
 * else, so it works whatever the publisher's telemetry setting.
 */

/** The hub this CLI publishes to. */
export const DEFAULT_HUB_URL = "https://mthds.sh";
export const REGISTRY_PATH = "/api/v1/registry/methods";

/**
 * Points the client at another hub, for tests: only a loopback `http` origin, such as
 * `http://127.0.0.1:8787`, is accepted, so no setting can send a publish anywhere but mthds.sh or
 * this machine.
 */
export const HUB_URL_ENV = "MTHDS_HUB_URL";

/** How long one request may take: the hub reads GitHub, with ten seconds per read, before it answers. */
export const REQUEST_TIMEOUT_MS = 30_000;
/** How many requests a method gets when the hub answers `rate_limited`, the first included. */
export const MAX_ATTEMPTS = 3;
/** The longest wait a `retry_after_seconds` is honoured for; a longer one is reported, not waited out. */
export const MAX_RETRY_WAIT_SECONDS = 60;

const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?\/?$/;

export type HubUrlResolution = { ok: true; url: string } | { ok: false; message: string };

/** The hub to publish to: mthds.sh, or the loopback origin `MTHDS_HUB_URL` names. */
export function resolveHubUrl(env: NodeJS.ProcessEnv = process.env): HubUrlResolution {
  const raw = env[HUB_URL_ENV]?.trim();
  if (raw === undefined || raw === "") return { ok: true, url: DEFAULT_HUB_URL };
  const match = LOOPBACK_ORIGIN.exec(raw);
  const port = match?.[1] === undefined ? undefined : Number(match[1]);
  if (match === null || (port !== undefined && (port < 1 || port > 65535))) {
    return {
      ok: false,
      message: `${HUB_URL_ENV} is set to something other than a loopback http origin (such as http://127.0.0.1:8787). Unset it to publish to mthds.sh.`,
    };
  }
  return { ok: true, url: raw.replace(/\/$/, "") };
}

// ── The route's answers ─────────────────────────────────────────────

export const ACCEPTED_OUTCOMES = ["registered", "updated", "unchanged"] as const;
export type AcceptedOutcome = (typeof ACCEPTED_OUTCOMES)[number];

export interface ListedMethod {
  /** The address the hub lists the method under, which can differ from the one sent. */
  address: string;
  name: string;
  /** `[package].version` as the hub read it from the repository. */
  version: string;
  commit_sha: string;
  /** The method's page on the hub. */
  url: string;
}

export type ValidationState = "queued" | "up_to_date" | "unavailable";

export interface AcceptedAnswer {
  outcome: AcceptedOutcome;
  method: ListedMethod;
  validation: ValidationState;
}

export type RefusalReason =
  | "repository_not_found"
  | "repository_not_public"
  | "repository_blocked"
  | "method_not_found"
  | "manifest_invalid";

export interface RefusedAnswer {
  outcome: "refused";
  reason: RefusalReason | string;
  message: string;
  errors: string[];
}

/**
 * The hub's error codes, and two of this client's: `unreachable`, when no answer came (a network
 * failure or the timeout), and `unexpected_response`, when the answer was not one the route defines.
 */
export interface RegistryError {
  code: string;
  message: string;
  retryable: boolean;
  retry_after_seconds?: number;
  issues?: Array<{ path: string; message: string }>;
}

export interface ErrorAnswer {
  outcome: "error";
  error: RegistryError;
}

export type RegistrationAnswer = AcceptedAnswer | RefusedAnswer | ErrorAnswer;

export function isAccepted(answer: RegistrationAnswer): answer is AcceptedAnswer {
  return (ACCEPTED_OUTCOMES as readonly string[]).includes(answer.outcome);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unexpected(detail: string, retryable = false): ErrorAnswer {
  return {
    outcome: "error",
    error: {
      code: "unexpected_response",
      message: `mthds.sh answered in a way this CLI does not understand (${detail}).`,
      retryable,
    },
  };
}

/** Read the route's answer by its `outcome`, checking the fields this client uses. */
export function readAnswer(body: unknown): RegistrationAnswer {
  if (!isRecord(body)) return unexpected("not a JSON object");
  const outcome = body["outcome"];
  if (typeof outcome !== "string") return unexpected("no outcome");
  if ((ACCEPTED_OUTCOMES as readonly string[]).includes(outcome)) {
    const method = body["method"];
    if (
      !isRecord(method) ||
      typeof method["address"] !== "string" ||
      typeof method["name"] !== "string" ||
      typeof method["version"] !== "string" ||
      typeof method["url"] !== "string"
    ) {
      return unexpected(`an ${outcome} answer without its method`);
    }
    const validation = body["validation"];
    return {
      outcome: outcome as AcceptedOutcome,
      method: {
        address: method["address"],
        name: method["name"],
        version: method["version"],
        commit_sha: typeof method["commit_sha"] === "string" ? method["commit_sha"] : "",
        url: method["url"],
      },
      validation:
        validation === "queued" || validation === "up_to_date" || validation === "unavailable"
          ? validation
          : "unavailable",
    };
  }
  if (outcome === "refused") {
    const errors = Array.isArray(body["errors"])
      ? body["errors"].filter((entry): entry is string => typeof entry === "string")
      : [];
    return {
      outcome: "refused",
      reason: typeof body["reason"] === "string" ? body["reason"] : "unknown",
      message:
        typeof body["message"] === "string" ? body["message"] : "mthds.sh refused the method.",
      errors,
    };
  }
  if (outcome === "error") {
    const error = body["error"];
    if (!isRecord(error) || typeof error["code"] !== "string")
      return unexpected("an error without its code");
    const answer: ErrorAnswer = {
      outcome: "error",
      error: {
        code: error["code"],
        message: typeof error["message"] === "string" ? error["message"] : error["code"],
        retryable: error["retryable"] === true,
      },
    };
    if (typeof error["retry_after_seconds"] === "number") {
      answer.error.retry_after_seconds = error["retry_after_seconds"];
    }
    if (Array.isArray(error["issues"])) {
      answer.error.issues = error["issues"].filter(isRecord).map((issue) => ({
        path: String(issue["path"] ?? ""),
        message: String(issue["message"] ?? ""),
      }));
    }
    return answer;
  }
  return unexpected(`outcome "${outcome}"`);
}

// ── The request ─────────────────────────────────────────────────────

export interface RegistrationRequest {
  /** The repository: `owner/repo` or `github.com/owner/repo`. */
  address: string;
  /** The method's `[package].name`, its directory under `methods/`. */
  name: string;
}

export interface RegistryClientOptions {
  hubUrl: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Told before each wait a `rate_limited` answer asks for. */
  onRateLimited?: (waitSeconds: number) => void;
  timeoutMs?: number;
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function postOnce(
  request: RegistrationRequest,
  options: RegistryClientOptions,
): Promise<RegistrationAnswer> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${options.hubUrl}${REGISTRY_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ address: request.address, name: request.name }),
      signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      outcome: "error",
      error: {
        code: "unreachable",
        message: `mthds.sh could not be reached: ${(err as Error).message}`,
        retryable: true,
      },
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // A gateway's error page in front of the hub, say: worth a retry when it is a server error.
    return unexpected(
      `HTTP ${response.status} with a body that is not JSON`,
      response.status >= 500,
    );
  }
  return readAnswer(body);
}

/**
 * Ask the hub to list one method. A `rate_limited` answer is waited out, for the
 * `retry_after_seconds` it gives, and retried, up to {@link MAX_ATTEMPTS} requests in all; every
 * other answer is returned as it came.
 */
export async function registerMethod(
  request: RegistrationRequest,
  options: RegistryClientOptions,
): Promise<RegistrationAnswer> {
  const sleep = options.sleep ?? defaultSleep;
  let answer = await postOnce(request, options);
  for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) {
    if (answer.outcome !== "error" || answer.error.code !== "rate_limited") return answer;
    const waitSeconds = Math.max(1, answer.error.retry_after_seconds ?? 1);
    if (waitSeconds > MAX_RETRY_WAIT_SECONDS) return answer;
    options.onRateLimited?.(waitSeconds);
    await sleep(waitSeconds * 1000);
    answer = await postOnce(request, options);
  }
  return answer;
}

// ── Several methods ─────────────────────────────────────────────────

/** What the route answered for one method, by the name this CLI sent. */
export interface MethodRegistration {
  name: string;
  answer: RegistrationAnswer;
}

/** One request per method, one after the other, as the route asks. */
export async function registerMethods(
  requests: RegistrationRequest[],
  options: RegistryClientOptions & { onMethod?: (name: string) => void },
): Promise<MethodRegistration[]> {
  const registrations: MethodRegistration[] = [];
  for (const request of requests) {
    options.onMethod?.(request.name);
    registrations.push({ name: request.name, answer: await registerMethod(request, options) });
  }
  return registrations;
}

/** A registration as the agent CLI reports it: the method's name and the route's answer, whole. */
export function registrationReport(registration: MethodRegistration): Record<string, unknown> {
  return { name: registration.name, ...registration.answer };
}

/** One line saying what the route answered for a method, for a person or an agent's error message. */
export function describeRegistration(registration: MethodRegistration): string {
  const { name, answer } = registration;
  if (isAccepted(answer)) {
    const verb =
      answer.outcome === "registered"
        ? "registered"
        : answer.outcome === "updated"
          ? "updated"
          : "already up to date";
    return `${name}: ${verb} on mthds.sh at ${answer.method.url} (version ${answer.method.version})`;
  }
  if (answer.outcome === "refused") {
    const details = answer.errors.length > 0 ? ` ${answer.errors.join(" ")}` : "";
    return `${name}: refused by mthds.sh (${answer.reason}): ${answer.message}${details}`;
  }
  const issues =
    answer.error.issues && answer.error.issues.length > 0
      ? ` ${answer.error.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`
      : "";
  return `${name}: not published (${answer.error.code}): ${answer.error.message}${issues}`;
}
