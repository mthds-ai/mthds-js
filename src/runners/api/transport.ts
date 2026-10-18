/**
 * Reading a transport failure: whether the request it ended can have left. A failure that names a
 * step of the connection's set-up proves the request never left, so the runtime was not reached
 * (`client.unreachable`); any other failure may have come once the request had left, which on a
 * route that creates a run leaves the outcome unknown (`client.outcome_unknown`).
 *
 * The reading errs on the safe side: a false "may have left" costs the caller a look at the run
 * history, a false "never left" a second paid run, so only a failure that proves nothing was sent
 * counts as one that did not leave.
 */

/**
 * Whether `fetchFailure`, what fetch threw, proves the request never left: undici gives the
 * transport's own failure as the `cause` of fetch's, and that failure names the name lookup or the
 * connection itself failing (the system calls `getaddrinfo` and `connect`: an unknown host, a
 * refused connection, no route, the system's connect time limit), undici's connect time limit,
 * which covers the TLS handshake, or a server certificate the handshake refused. Several
 * addresses each failing so, which Node reports together as an `AggregateError`, prove it too.
 *
 * A reset (`ECONNRESET`), a socket closed by the other side, another TLS failure and anything
 * else may come once the request has left, so none of them proves anything.
 */
export function provesNothingSent(fetchFailure: unknown): boolean {
  return fetchFailure instanceof Error && isConnectionSetupFailure(fetchFailure.cause);
}

/** The network code a transport failure carries, such as `ECONNREFUSED`, when it carries one. */
export function networkErrorCode(fetchFailure: unknown): string | undefined {
  const cause = fetchFailure instanceof Error ? fetchFailure.cause : undefined;
  if (typeof cause !== "object" || cause === null) return undefined;
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isConnectionSetupFailure(failure: unknown): boolean {
  if (failure instanceof AggregateError) {
    return failure.errors.length > 0 && failure.errors.every(isConnectionSetupFailure);
  }
  if (typeof failure !== "object" || failure === null) return false;
  const { code, syscall } = failure as { code?: unknown; syscall?: unknown };
  if (typeof code === "string" && CONNECTION_SETUP_CODES.has(code)) return true;
  return typeof syscall === "string" && CONNECTION_SETUP_CALLS.has(syscall);
}

/** The system calls that resolve the host's name and open the connection. */
const CONNECTION_SETUP_CALLS: ReadonlySet<string> = new Set(["getaddrinfo", "connect"]);

/**
 * The codes only a step of the connection's set-up gives: the name lookup's and the connect
 * call's own, undici's connect time limit, Node's limit on one attempt among several addresses,
 * Node's check of the host's name, and every code Node gives a server certificate the TLS
 * handshake refused (the "X509 certificate error codes" of Node's `tls` documentation, then its
 * default, `UNSPECIFIED`).
 */
const CONNECTION_SETUP_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_TLS_CERT_ALTNAME_FORMAT",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_CRL",
  "UNABLE_TO_DECRYPT_CERT_SIGNATURE",
  "UNABLE_TO_DECRYPT_CRL_SIGNATURE",
  "UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY",
  "CERT_SIGNATURE_FAILURE",
  "CRL_SIGNATURE_FAILURE",
  "CERT_NOT_YET_VALID",
  "CERT_HAS_EXPIRED",
  "CRL_NOT_YET_VALID",
  "CRL_HAS_EXPIRED",
  "ERROR_IN_CERT_NOT_BEFORE_FIELD",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "ERROR_IN_CRL_LAST_UPDATE_FIELD",
  "ERROR_IN_CRL_NEXT_UPDATE_FIELD",
  "OUT_OF_MEM",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_CHAIN_TOO_LONG",
  "CERT_REVOKED",
  "INVALID_CA",
  "PATH_LENGTH_EXCEEDED",
  "INVALID_PURPOSE",
  "CERT_UNTRUSTED",
  "CERT_REJECTED",
  "HOSTNAME_MISMATCH",
  "UNSPECIFIED",
]);
