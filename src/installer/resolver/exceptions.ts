/**
 * The error a resolver throws when it cannot read a method source, GitHub's or a local
 * directory's, with the reason it failed for, so that a command reports a method that does not
 * exist apart from a source it could not reach or read. Its message is the sentence the `mthds`
 * CLI prints.
 */

/**
 * Why a source could not be resolved:
 *
 * - `not_found`: the repository, its `methods/` folder or the directory does not exist, or holds
 *   no method;
 * - `fetch_failed`: GitHub could not be reached, refused for now (a rate limit, a `403`), failed
 *   (a `5xx`) or answered something the resolver cannot read, so a later attempt may succeed;
 * - `not_configured`: GitHub refused the credential (`401`), named by `setting`;
 * - `unreadable`: the system refused to read a local path (`path`), for the reason `fsCode` names.
 */
export type ResolveFailureReason = "not_found" | "fetch_failed" | "not_configured" | "unreadable";

export class MethodResolveError extends Error {
  /** Why the source could not be resolved. */
  public readonly reason: ResolveFailureReason;
  /** The local path the system refused, on an `unreadable` failure. */
  public readonly path: string | undefined;
  /** The system's error code, such as `EACCES`, on an `unreadable` failure. */
  public readonly fsCode: string | undefined;
  /** The setting GitHub refused, such as `GITHUB_TOKEN`, on a `not_configured` failure. */
  public readonly setting: string | undefined;

  constructor(
    message: string,
    reason: ResolveFailureReason,
    options: { cause?: unknown; path?: string; fsCode?: string; setting?: string } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "MethodResolveError";
    this.reason = reason;
    this.path = options.path;
    this.fsCode = options.fsCode;
    this.setting = options.setting;
  }
}

/**
 * The system's error code of `err`, such as `ENOENT` or `EACCES`, when it carries one written as
 * such a code, else `undefined`. The one reader of a file system error's code, which a resolver
 * keeps as `fsCode` and `fileErrorReason` turns into a problem's reason.
 */
export function systemErrorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code) ? code : undefined;
}

/** Whether `err` is a resolve failure for `reason`. */
export function isResolveFailure(err: unknown, reason: ResolveFailureReason): boolean {
  return err instanceof MethodResolveError && err.reason === reason;
}

/** A failure carried on with a new sentence, keeping its reason and facts, or else `fallback`. */
export function rewordResolveFailure(
  err: unknown,
  message: string,
  fallback: ResolveFailureReason,
): MethodResolveError {
  if (err instanceof MethodResolveError) {
    return new MethodResolveError(message, err.reason, {
      cause: err,
      path: err.path,
      fsCode: err.fsCode,
      setting: err.setting,
    });
  }
  return new MethodResolveError(message, fallback, { cause: err });
}
