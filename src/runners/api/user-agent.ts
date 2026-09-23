/**
 * Client identification — the `User-Agent` header `MthdsApiClient` sends on
 * every request to an MTHDS runner or the hosted API.
 *
 * The contract is the Pipelex workspace spec `docs/specs/client-identification.md`:
 * product tokens outermost first, the integrator's `appInfo` (if any), then this
 * library (`mthds-js/<version>`), then the runtime (`node/<v> (<os>; <arch>)`).
 * In a browser no header is produced at all, because a browser either ignores
 * it or turns it into a CORS preflight the API refuses.
 *
 * The header is self-declared analytics metadata; it never carries a secret, a
 * user identifier, an email or a hostname.
 */

import { MTHDS_JS_VERSION } from "../../version.js";

/** This library's token name in the spec's closed registry. */
export const MTHDS_JS_TOKEN_NAME = "mthds-js";

/** Upper bound the spec puts on the whole header value. */
export const USER_AGENT_MAX_LENGTH = 512;

/**
 * The integrator's identity, placed in front of the SDK's own tokens —
 * shaped like Stripe's `appInfo`. Renders as `name/version (<details>; +url)`.
 */
export interface AppInfo {
  /** An RFC 9110 `token`, lowercase kebab-case by convention (e.g. `acme-invoicer`). */
  name: string;
  /** An RFC 9110 `token` (e.g. `1.4.0`). */
  version?: string;
  /** A URL, rendered in the comment as `+url`. */
  url?: string;
  /** Comment parameters, each a `token` or `token=value`, rendered before `+url`. */
  details?: string[];
}

/** RFC 9110 §5.6.2 `token` = 1*tchar. */
const TOKEN_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** A detail's `value` = token / ( name "/" version ). */
const DETAIL_VALUE_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+(\/[!#$%&'*+\-.^_`|~0-9A-Za-z]+)?$/;
/** A URL inside a comment: visible ASCII only, which also excludes whitespace. */
const URL_VISIBLE_ASCII_RE = /^[!-~]+$/;
/** Characters that would close the comment or split it into another parameter. */
const URL_COMMENT_BREAKERS_RE = /[()\\;]/;

function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

function isValidDetail(detail: unknown): detail is string {
  if (typeof detail !== "string") return false;
  const eq = detail.indexOf("=");
  if (eq === -1) return isToken(detail);
  return isToken(detail.slice(0, eq)) && DETAIL_VALUE_RE.test(detail.slice(eq + 1));
}

/**
 * Refuse an `appInfo` the header grammar cannot carry. Throws `TypeError` —
 * a client never silently drops or rewrites an invalid value. An empty
 * `version`, `url` or `details` counts as absent, not as invalid.
 */
export function validateAppInfo(appInfo: AppInfo): void {
  if (appInfo === null || typeof appInfo !== "object") {
    throw new TypeError("appInfo must be an object with at least a `name`.");
  }
  if (!isToken(appInfo.name)) {
    throw new TypeError(
      `Invalid appInfo.name ${JSON.stringify(appInfo.name)}: must be a non-empty RFC 9110 token ` +
        "(letters, digits and !#$%&'*+-.^_`|~ only; no spaces or slashes).",
    );
  }
  if (appInfo.version !== undefined && appInfo.version !== "" && !isToken(appInfo.version)) {
    throw new TypeError(
      `Invalid appInfo.version ${JSON.stringify(appInfo.version)}: must be a non-empty RFC 9110 token ` +
        "(e.g. 1.4.0; no spaces or slashes).",
    );
  }
  if (appInfo.url !== undefined && appInfo.url !== "") {
    if (
      typeof appInfo.url !== "string" ||
      !URL_VISIBLE_ASCII_RE.test(appInfo.url) ||
      URL_COMMENT_BREAKERS_RE.test(appInfo.url)
    ) {
      throw new TypeError(
        `Invalid appInfo.url ${JSON.stringify(appInfo.url)}: must be visible ASCII with no whitespace, ` +
          "parentheses, backslash or semicolons.",
      );
    }
  }
  if (appInfo.details !== undefined) {
    if (!Array.isArray(appInfo.details)) {
      throw new TypeError("Invalid appInfo.details: must be an array of strings.");
    }
    for (const detail of appInfo.details) {
      if (!isValidDetail(detail)) {
        throw new TypeError(
          `Invalid appInfo.details entry ${JSON.stringify(detail)}: must be a token or token=value, where ` +
            "value is a token or name/version (e.g. `workshop`, `host=claude-code/2.1.4`).",
        );
      }
    }
  }
}

/** Render `appInfo` as `name/version (<details>; +url)`, dropping empty parts. */
export function renderAppInfo(appInfo: AppInfo): string {
  const product = appInfo.version ? `${appInfo.name}/${appInfo.version}` : appInfo.name;
  const params = [...(appInfo.details ?? [])];
  if (appInfo.url) params.push(`+${appInfo.url}`);
  return params.length > 0 ? `${product} (${params.join("; ")})` : product;
}

/** The runtime the code is executing in, as far as the header needs it. */
export interface RuntimeInfo {
  /** `node`, `bun` or `deno`; `undefined` when the version cannot be read. */
  name?: string;
  version?: string;
  os?: string;
  arch?: string;
  /** True in a browser or a web worker — no `User-Agent` is set there. */
  isBrowser: boolean;
}

interface DenoGlobal {
  version?: { deno?: string };
  build?: { os?: string; arch?: string };
}

/**
 * Read the current runtime from globals. Never throws. A browser (a window with
 * a document, or a web worker) is detected first, because an Electron renderer
 * or a bundle that polyfills `process` also exposes `process.versions.node`.
 */
export function detectRuntime(
  g: Record<string, unknown> = globalThis as Record<string, unknown>,
): RuntimeInfo {
  const win = g.window as { document?: unknown } | undefined;
  if (
    (win !== undefined && win !== null && win.document !== undefined) ||
    typeof g.importScripts === "function"
  ) {
    return { isBrowser: true };
  }
  const deno = g.Deno as DenoGlobal | undefined;
  if (deno?.version?.deno) {
    return {
      name: "deno",
      version: deno.version.deno,
      os: deno.build?.os,
      arch: deno.build?.arch,
      isBrowser: false,
    };
  }
  const proc = g.process as
    | { versions?: Record<string, string | undefined>; platform?: string; arch?: string }
    | undefined;
  const versions = proc?.versions;
  if (versions?.bun) {
    return {
      name: "bun",
      version: versions.bun,
      os: proc?.platform,
      arch: proc?.arch,
      isBrowser: false,
    };
  }
  if (versions?.node) {
    return {
      name: "node",
      version: versions.node,
      os: proc?.platform,
      arch: proc?.arch,
      isBrowser: false,
    };
  }
  return { isBrowser: false };
}

/**
 * Build the full `User-Agent` value, or `undefined` when none must be sent
 * (a browser). Throws `TypeError` on an invalid `appInfo` and `RangeError`
 * when the result would exceed the spec's 512-character bound.
 */
export function buildUserAgent(
  appInfo?: AppInfo,
  runtime: RuntimeInfo = detectRuntime(),
  libraryVersion: string = MTHDS_JS_VERSION,
): string | undefined {
  if (appInfo !== undefined) validateAppInfo(appInfo);

  const parts: string[] = [];
  if (appInfo !== undefined) parts.push(renderAppInfo(appInfo));
  parts.push(`${MTHDS_JS_TOKEN_NAME}/${libraryVersion}`);
  if (!runtime.isBrowser && runtime.name && runtime.version && isToken(runtime.version)) {
    let token = `${runtime.name}/${runtime.version}`;
    if (runtime.os && runtime.arch && isToken(runtime.os) && isToken(runtime.arch)) {
      token += ` (${runtime.os}; ${runtime.arch})`;
    }
    parts.push(token);
  }
  const header = parts.join(" ");
  if (header.length > USER_AGENT_MAX_LENGTH) {
    throw new RangeError(
      `The User-Agent built from appInfo is ${header.length} characters; the limit is ` +
        `${USER_AGENT_MAX_LENGTH}. Shorten appInfo.details or appInfo.url.`,
    );
  }
  // Checked before the browser return, so an `appInfo` refused on a server is refused
  // in a browser too: the refusal is a property of the `appInfo`, not of the runtime.
  if (runtime.isBrowser) return undefined;
  return header;
}
