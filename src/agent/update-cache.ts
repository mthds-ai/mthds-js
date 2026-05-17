/**
 * Cache for update-check results, plus the just-upgraded marker.
 *
 * Primary location: ~/.mthds/state/.
 * Fallback location: $TMPDIR/mthds-agent-<uid>/ — used when the primary
 * location is not writable (e.g. Codex's workspaceWrite sandbox permits writes
 * only under cwd / configured roots / $TMPDIR, not under the user's home dir).
 * The fallback path is predictable, so it is validated against symlink/TOCTOU
 * tampering before use — see `ensureFallbackDir`.
 *
 * Two files live in each location:
 *
 * 1. `last-update-check` — TTL'd cache of update-check results.
 *    Two-line format: aggregate status, then JSON payload of per-binary results.
 *    Split TTL: 60 min for UP_TO_DATE, 720 min for UPGRADE_AVAILABLE.
 *
 * 2. `just-upgraded-from` — one-shot marker written by `mthds-agent upgrade`
 *    (and bootstrap) so the next update-check can announce what was upgraded.
 *    Consumed within the same skill flow, so a short TTL is enough; older
 *    markers are treated as stuck (sandbox blocked cleanup last time) and
 *    ignored to stop the announcement from replaying forever.
 *
 * TTL is based on file mtime (like gstack), not an embedded timestamp.
 */

import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import {
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  statSync,
  lstatSync,
  openSync,
  closeSync,
  constants as fsConstants,
} from "node:fs";
import type { VersionStatus } from "../installer/runtime/version-check.js";

// ── Types ──────────────────────────────────────────────────────────

export type AggregateStatus = "UP_TO_DATE" | "UPGRADE_AVAILABLE";

export interface BinaryCheckEntry {
  /** Version status: "ok", "outdated", "missing", "unparseable" */
  s: VersionStatus;
  /** Installed version, or null */
  v: string | null;
  /** Required constraint (present when s !== "ok") */
  r?: string;
}

export interface CachePayload {
  mthds_agent: BinaryCheckEntry;
  pipelex_agent?: BinaryCheckEntry; // optional — skipped when runner !== "pipelex"
  plxt: BinaryCheckEntry;
  plugin?: BinaryCheckEntry; // optional — skipped when not running inside a known host
}

export interface CacheResult {
  aggregate: AggregateStatus;
  payload: CachePayload;
}

/** Why the fallback directory is or isn't usable. The `symlink`,
 *  `foreign-owner`, `not-a-dir`, and `insecure-tmp` reasons are *suspicious*
 *  (possible tampering) and trigger a one-shot warning; `absent`/`error` are
 *  benign (the dir simply isn't there yet, or a transient FS error). */
export type FallbackDirReason =
  | "ok"
  | "absent"
  | "symlink"
  | "foreign-owner"
  | "not-a-dir"
  | "insecure-tmp"
  | "error";

export interface FallbackDirStatus {
  usable: boolean;
  reason: FallbackDirReason;
}

// ── Constants ──────────────────────────────────────────────────────

/** One minute in milliseconds. Base unit for the TTLs below and for the
 *  clock-skew tolerance applied when comparing file mtimes to the wall clock. */
export const MS_PER_MINUTE = 60_000;

/** Primary state directory (~/.mthds/state). Exported so snooze.ts shares the
 *  same dual-path layout from a single source of truth. */
export const STATE_DIR = join(homedir(), ".mthds", "state");

/** uid of the current process, or null on Windows where `process.getuid` is
 *  absent. The /tmp symlink/TOCTOU hardening is POSIX-specific; on Windows the
 *  fallback keeps the legacy unsuffixed name and skips the strict checks. */
const FALLBACK_UID: number | null =
  typeof process.getuid === "function" ? process.getuid() : null;

/** Fallback state directory, used when STATE_DIR is not writable (Codex's
 *  workspaceWrite sandbox). The name carries the current uid so that multiple
 *  users on a shared host never collide on ownership — an unsuffixed name
 *  created by user A would fail user B's ownership check and permanently deny
 *  them the fallback. Exported for snooze.ts. */
export const FALLBACK_DIR = join(
  tmpdir(),
  FALLBACK_UID === null ? "mthds-agent" : `mthds-agent-${FALLBACK_UID}`,
);

/** O_NOFOLLOW makes a write refuse a symlink as the final path component
 *  (throws ELOOP) rather than following it. Undefined on Windows — `?? 0`
 *  makes it a no-op there. */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
/** Flags for a create-or-truncate write — equivalent to the default `"w"`
 *  (O_WRONLY|O_CREAT|O_TRUNC) plus O_NOFOLLOW, so a hijacked leaf symlink is
 *  rejected instead of followed. */
const WRITE_FLAGS =
  fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | O_NOFOLLOW;

const PRIMARY_CACHE_PATH = join(STATE_DIR, "last-update-check");
const PRIMARY_MARKER_PATH = join(STATE_DIR, "just-upgraded-from");
const FALLBACK_CACHE_PATH = join(FALLBACK_DIR, "last-update-check");
const FALLBACK_MARKER_PATH = join(FALLBACK_DIR, "just-upgraded-from");

const TTL_UP_TO_DATE_MS = 60 * MS_PER_MINUTE; // 60 min
const TTL_UPGRADE_AVAILABLE_MS = 720 * MS_PER_MINUTE; // 720 min (12 hours)
// Real markers are consumed within seconds (skill flow re-runs preamble
// immediately after upgrade). Anything markedly older is almost certainly
// stuck because the sandbox blocked cleanup last time — ignore it instead of
// replaying the announcement on every update-check.
const MARKER_TTL_MS = 60 * MS_PER_MINUTE; // 60 min

const VALID_AGGREGATES: ReadonlySet<string> = new Set([
  "UP_TO_DATE",
  "UPGRADE_AVAILABLE",
]);

export const SANDBOX_WRITE_ERRORS: ReadonlySet<string> = new Set([
  "EPERM",
  "EACCES",
  "EROFS",
]);

/** Fallback-dir refusal reasons that indicate possible tampering (as opposed
 *  to a benign "not there yet" / transient error). These get a one-shot
 *  warning and a `unsafe:` prefix in the write-failure detail. */
const SUSPICIOUS_REASONS: ReadonlySet<FallbackDirReason> = new Set([
  "symlink",
  "foreign-owner",
  "not-a-dir",
  "insecure-tmp",
]);

// ── Validation ──────────────────────────────────────────────────────

function isValidPayload(p: unknown): p is CachePayload {
  if (!p || typeof p !== "object") return false;
  const obj = p as Record<string, unknown>;
  // mthds_agent and plxt are always required
  for (const key of ["mthds_agent", "plxt"]) {
    const entry = obj[key];
    if (!entry || typeof entry !== "object") return false;
    if (typeof (entry as Record<string, unknown>).s !== "string") return false;
  }
  // pipelex_agent is optional, but if present must be valid
  if (obj.pipelex_agent !== undefined) {
    const entry = obj.pipelex_agent;
    if (!entry || typeof entry !== "object") return false;
    if (typeof (entry as Record<string, unknown>).s !== "string") return false;
  }
  // plugin is optional, but if present must be valid
  if (obj.plugin !== undefined) {
    const entry = obj.plugin;
    if (!entry || typeof entry !== "object") return false;
    if (typeof (entry as Record<string, unknown>).s !== "string") return false;
  }
  return true;
}

// ── Per-process warning latches ────────────────────────────────────

let warnedAboutCacheWrite = false;
let warnedAboutMarkerWrite = false;
let warnedAboutMarkerClear = false;
let warnedAboutFallbackUnsafe = false;

// ── Functions ──────────────────────────────────────────────────────

/** Compute aggregate status from a payload. */
export function computeAggregate(payload: CachePayload): AggregateStatus {
  const entries: BinaryCheckEntry[] = [payload.mthds_agent, payload.plxt];
  if (payload.pipelex_agent) entries.push(payload.pipelex_agent);
  if (payload.plugin) entries.push(payload.plugin);
  // Treat "unparseable" same as "ok" — the binary exists, we just can't parse
  // its version. Treating it as UPGRADE_AVAILABLE would cause an infinite loop:
  // preamble says upgrade available -> upgrade skips unparseable -> repeat.
  return entries.every((e) => e.s === "ok" || e.s === "unparseable")
    ? "UP_TO_DATE"
    : "UPGRADE_AVAILABLE";
}

// ── Fallback directory hardening ────────────────────────────────────
//
// $TMPDIR/mthds-agent-<uid> is a predictable path on a shared, world-writable
// /tmp. A *different-uid* local attacker could pre-create it as a symlink, or
// as a directory they own, so that our writes land somewhere they control or
// our chmod follows a symlink. `ensureFallbackDir` closes this: once we hold a
// real directory we own at mode 0o700 under a sticky parent, that attacker can
// neither rename/delete/swap it (sticky bit) nor enter it (0o700) — so it
// stays safe for the rest of the process, and the result is memoized.
//
// NOT defended: a *same-uid* attacker (a compromised sibling process). POSIX
// permissions cannot defend a uid against itself. O_NOFOLLOW on every fallback
// file write (see `writeFileNoFollow`) is the per-operation backstop there.

/** Memoized sticky outcome: a validated-safe directory or a suspicious
 *  refusal. A benign `absent`/`error` is never memoized — a later call may
 *  legitimately create the directory, or the transient error may clear. */
let fallbackDirMemo: FallbackDirStatus | null = null;

function memoizeFallback(status: FallbackDirStatus): FallbackDirStatus {
  fallbackDirMemo = status;
  return status;
}

function refuseFallback(reason: FallbackDirReason): FallbackDirStatus {
  emitFallbackUnsafeWarning(reason);
  return memoizeFallback({ usable: false, reason });
}

function emitFallbackUnsafeWarning(reason: FallbackDirReason): void {
  if (warnedAboutFallbackUnsafe) return;
  warnedAboutFallbackUnsafe = true;
  const why: Partial<Record<FallbackDirReason, string>> = {
    symlink: "it is a symlink (possible tampering)",
    "foreign-owner": "it is owned by another user (possible tampering)",
    "not-a-dir": "it exists but is not a directory",
    "insecure-tmp": `its parent ${tmpdir()} is world-writable without the sticky bit`,
  };
  process.stderr.write(
    `Warning: refusing fallback state directory ${FALLBACK_DIR} — ${why[reason] ?? reason}. Update state will not be cached this run.\n`
  );
}

/** Validate an already-existing FALLBACK_DIR via `lstatSync` (which does not
 *  follow a symlinked leaf). Owned-but-loose permissions are corrected in
 *  place; anything else suspicious is refused. */
function validateExistingFallbackDir(): FallbackDirStatus {
  let st;
  try {
    st = lstatSync(FALLBACK_DIR);
  } catch (err) {
    // ENOENT on a read-only (create:false) probe just means "nothing cached".
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { usable: false, reason: "absent" };
    }
    return { usable: false, reason: "error" };
  }

  if (st.isSymbolicLink()) return refuseFallback("symlink");
  if (!st.isDirectory()) return refuseFallback("not-a-dir");
  if (st.uid !== FALLBACK_UID) return refuseFallback("foreign-owner");

  // Owned by us but group/other have access (e.g. created by a version before
  // the 0o700 hardening). chmod it back and re-check rather than refuse.
  if ((st.mode & 0o077) !== 0) {
    try {
      chmodSync(FALLBACK_DIR, 0o700);
      if ((lstatSync(FALLBACK_DIR).mode & 0o077) !== 0) {
        return { usable: false, reason: "error" };
      }
    } catch {
      return { usable: false, reason: "error" };
    }
  }

  return memoizeFallback({ usable: true, reason: "ok" });
}

/**
 * Validate — and, when `create` is true, create — the per-uid fallback
 * directory. Returns whether it is safe to read or write state files inside
 * it; callers skip the fallback path entirely on `{usable: false}`.
 *
 * Exported so snooze.ts gates its own fallback access through the same check.
 */
export function ensureFallbackDir(create: boolean): FallbackDirStatus {
  if (fallbackDirMemo) return fallbackDirMemo;

  // Windows: process.getuid is absent and the /tmp symlink class of attack is
  // POSIX-specific (%TEMP% is per-user). Keep the legacy behavior — create on
  // demand, no strict checks — and do not memoize, so a later create:true
  // still makes the directory after an earlier create:false probe.
  if (FALLBACK_UID === null) {
    if (create) {
      try {
        mkdirSync(FALLBACK_DIR, { recursive: true, mode: 0o700 });
        return { usable: true, reason: "ok" };
      } catch {
        return { usable: false, reason: "error" };
      }
    }
    try {
      lstatSync(FALLBACK_DIR);
      return { usable: true, reason: "ok" };
    } catch {
      return { usable: false, reason: "absent" };
    }
  }

  // Parent check: a world-writable $TMPDIR without the sticky bit lets a
  // different-uid attacker rename our directory out from under us; a symlinked
  // $TMPDIR redirects everything. lstatSync (not statSync) so a symlinked
  // tmpdir is seen as a symlink, not as its target.
  try {
    const parent = lstatSync(tmpdir());
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      return refuseFallback("insecure-tmp");
    }
    const worldWritable = (parent.mode & 0o002) !== 0;
    const sticky = (parent.mode & 0o1000) !== 0;
    if (worldWritable && !sticky) return refuseFallback("insecure-tmp");
  } catch {
    return { usable: false, reason: "error" };
  }

  // Atomic create: a non-recursive mkdir either makes a fresh 0o700 directory
  // we own, or throws EEXIST for ANY pre-existing entry (real dir, symlink, or
  // file alike — so an lstat must follow to tell them apart).
  if (create) {
    try {
      mkdirSync(FALLBACK_DIR, { mode: 0o700 });
      return memoizeFallback({ usable: true, reason: "ok" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return { usable: false, reason: "error" };
      }
      // EEXIST — fall through to validate what is already there.
    }
  }

  return validateExistingFallbackDir();
}

interface CacheAttempt {
  result: CacheResult;
  mtimeMs: number;
}

/** Read a cache file at the given path. Returns null on any failure. */
function readCacheAt(path: string): CacheAttempt | null {
  let mtimeMs: number;
  let content: string;
  try {
    mtimeMs = statSync(path).mtimeMs;
    content = readFileSync(path, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  if (lines.length < 2) return null;

  const aggregate = lines[0]!.trim();
  if (!VALID_AGGREGATES.has(aggregate)) return null;

  let payload: CachePayload;
  try {
    const parsed: unknown = JSON.parse(lines[1]!);
    if (!isValidPayload(parsed)) return null;
    payload = parsed;
  } catch {
    return null;
  }

  const ttl =
    aggregate === "UP_TO_DATE" ? TTL_UP_TO_DATE_MS : TTL_UPGRADE_AVAILABLE_MS;
  const age = Date.now() - mtimeMs;
  // Negative age beyond 1 minute means clock skew — treat as expired
  if (age < -MS_PER_MINUTE || age > ttl) return null;

  return {
    result: { aggregate: aggregate as AggregateStatus, payload },
    mtimeMs,
  };
}

/**
 * Read the update-check cache.
 *
 * Both the primary and the fallback path may hold valid contents — primary
 * from a session where the home dir was writable, fallback from a session
 * where writes had to be redirected (sandbox EPERM). When both exist and
 * have unexpired contents, return whichever was written most recently; the
 * older one is a stale snapshot from before the redirect happened.
 */
export function readCache(): CacheResult | null {
  const primary = readCacheAt(PRIMARY_CACHE_PATH);
  const fallback = ensureFallbackDir(false).usable
    ? readCacheAt(FALLBACK_CACHE_PATH)
    : null;
  if (!primary) return fallback?.result ?? null;
  if (!fallback) return primary.result;
  return fallback.mtimeMs > primary.mtimeMs
    ? fallback.result
    : primary.result;
}

export interface WriteAttempt {
  ok: boolean;
  code?: string;
}

/**
 * Write `content` to `file` without following a symlinked leaf. The file is
 * opened with O_NOFOLLOW (so a symlink planted as the final path component
 * throws `ELOOP` instead of redirecting the write) at an owner-only mode; the
 * write goes through the fd via `writeFileSync` (which handles partial
 * writes), and the fd is always closed.
 */
function writeFileNoFollow(file: string, content: string): void {
  const fd = openSync(file, WRITE_FLAGS, 0o600);
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

/**
 * Best-effort `mkdir -p` + `writeFile` for the PRIMARY state directory
 * (~/.mthds/state, under $HOME — not a shared-/tmp attack surface). Returns
 * `{ok: true}` on success, or `{ok: false, code}` on any failure (errno code
 * if available, else stringified error). Callers decide whether to retry on
 * the fallback path based on `code` — see `SANDBOX_WRITE_ERRORS`. The fallback
 * directory has its own hardened path; see `ensureFallbackDir`.
 */
export function writeFileAt(dir: string, file: string, content: string): WriteAttempt {
  try {
    // mode 0o700 is honored only when mkdirSync creates the directory, so
    // chmodSync re-asserts it on every write — correcting a directory left
    // loose by an older version.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileNoFollow(file, content);
    return { ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? String(err);
    return { ok: false, code };
  }
}

/**
 * Write `content` to `primaryPath`; on a sandbox/permission failure (see
 * `SANDBOX_WRITE_ERRORS`) retry once at `fallbackPath` inside the hardened
 * fallback directory. Other failure classes (ENOSPC, IO errors) are not
 * improved by retrying elsewhere, so they are reported without a fallback
 * attempt. The single owner of the try-primary-then-fallback policy shared by
 * the cache, marker, and snooze writers — callers only supply their own
 * one-shot warning text.
 *
 * `fallbackPath` must be a file inside `FALLBACK_DIR`; the directory is
 * created/validated here via `ensureFallbackDir`.
 */
export function writeWithFallback(
  primaryDir: string,
  primaryPath: string,
  fallbackPath: string,
  content: string,
): WriteAttempt & { fallbackCode?: string } {
  const primary = writeFileAt(primaryDir, primaryPath, content);
  if (primary.ok) return { ok: true };

  if (primary.code && SANDBOX_WRITE_ERRORS.has(primary.code)) {
    const dir = ensureFallbackDir(true);
    if (!dir.usable) {
      const fallbackCode = SUSPICIOUS_REASONS.has(dir.reason)
        ? `unsafe:${dir.reason}`
        : dir.reason;
      return { ok: false, code: primary.code, fallbackCode };
    }
    try {
      writeFileNoFollow(fallbackPath, content);
      return { ok: true };
    } catch (err) {
      const fallbackCode = (err as NodeJS.ErrnoException).code ?? String(err);
      return { ok: false, code: primary.code, fallbackCode };
    }
  }

  return { ok: false, code: primary.code };
}

/**
 * Write cache. Tries the primary path first; on sandbox / permission failures
 * falls back to $TMPDIR. Both failing emits at most one warning per process.
 */
export function writeCache(result: CacheResult): void {
  const content =
    result.aggregate + "\n" + JSON.stringify(result.payload) + "\n";

  const res = writeWithFallback(
    STATE_DIR,
    PRIMARY_CACHE_PATH,
    FALLBACK_CACHE_PATH,
    content,
  );
  if (res.ok) return;
  emitWriteWarning(res.code, res.fallbackCode);
}

function emitWriteWarning(primaryCode?: string, fallbackCode?: string): void {
  if (warnedAboutCacheWrite) return;
  warnedAboutCacheWrite = true;
  const detail = fallbackCode
    ? `primary=${primaryCode ?? "?"}, fallback=${fallbackCode}`
    : (primaryCode ?? "?");
  process.stderr.write(
    `Warning: could not write update-check cache (${detail}). Check will run again next time.\n`
  );
}

/** Delete cache files (used by --force and after upgrade). */
export function clearCache(): void {
  const paths = [PRIMARY_CACHE_PATH];
  // Only touch the fallback path when its directory passes the hardening
  // check — never unlink through a symlinked or foreign-owned directory.
  if (ensureFallbackDir(false).usable) paths.push(FALLBACK_CACHE_PATH);
  for (const p of paths) {
    try {
      unlinkSync(p);
    } catch {
      // File may not exist, or the sandbox blocks the unlink — neither
      // matters here: writeCache also can't have written there, so there's
      // nothing to remove.
    }
  }
}

// ── Upgrade marker ──────────────────────────────────────────────────
//
// The marker is a one-shot hand-off from `mthds-agent upgrade` / `bootstrap`
// to the next `update-check`, so the skill preamble can announce what just
// changed. It uses the same primary/fallback layout as the cache, for the
// same reason: ~/.mthds/state/ is not writable under Codex's workspaceWrite
// sandbox, and the bug we are fixing here is exactly the case where the
// marker was written successfully in a non-sandboxed context and then could
// not be cleaned up later from a sandboxed one, replaying the announcement
// every update-check.

/**
 * Write the just-upgraded marker. Sandbox-aware: falls back to $TMPDIR when
 * ~/.mthds/state/ is not writable. The marker is best-effort — a write
 * failure is warned (once per process) but never thrown.
 */
export function writeUpgradeMarker(data: Record<string, unknown>): void {
  const res = writeWithFallback(
    STATE_DIR,
    PRIMARY_MARKER_PATH,
    FALLBACK_MARKER_PATH,
    JSON.stringify(data),
  );
  if (res.ok) return;
  emitMarkerWriteWarning(res.code, res.fallbackCode);
}

function emitMarkerWriteWarning(primaryCode?: string, fallbackCode?: string): void {
  if (warnedAboutMarkerWrite) return;
  warnedAboutMarkerWrite = true;
  const detail = fallbackCode
    ? `primary=${primaryCode ?? "?"}, fallback=${fallbackCode}`
    : (primaryCode ?? "?");
  process.stderr.write(
    `Warning: could not write upgrade marker (${detail}). The next update-check may not announce the upgrade.\n`
  );
}

interface MarkerReadAttempt {
  data: Record<string, unknown>;
  mtimeMs: number;
}

function readMarkerAt(path: string): MarkerReadAttempt | null {
  let mtimeMs: number;
  let content: string;
  try {
    mtimeMs = statSync(path).mtimeMs;
    content = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return { data: parsed as Record<string, unknown>, mtimeMs };
}

/**
 * Best-effort invalidation. unlinkSync first (the desired outcome); if that
 * fails — typically EPERM under the sandbox — overwrite with empty content so
 * the next read parses as invalid (empty content fails JSON.parse and is also
 * rejected by the single-line snooze parser). The overwrite goes through
 * `writeFileNoFollow`, so a symlink swapped in for the file is rejected
 * (`ELOOP`) and reported as a failed invalidation rather than followed.
 * Returns true when the file is either gone or guaranteed unparseable.
 */
export function invalidateFileAt(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    // fall through
  }
  try {
    writeFileNoFollow(path, "");
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and consume the just-upgraded marker. Returns null when no marker is
 * present, when the most recent marker is older than MARKER_TTL_MS (stale —
 * likely stuck from a session where the sandbox blocked cleanup), or when
 * the content cannot be parsed.
 *
 * Sandbox-aware: inspects both the primary and the fallback path, prefers the
 * newer one, and best-effort cleans up both regardless of whether the marker
 * was honored or rejected — so a stuck marker stops replaying as soon as we
 * regain write access to its directory.
 */
export function readAndClearUpgradeMarker(): Record<string, unknown> | null {
  // Skip the fallback path entirely when its directory fails the hardening
  // check — both the read and the cleanup below stay off a suspicious dir.
  const fallbackUsable = ensureFallbackDir(false).usable;
  const primary = readMarkerAt(PRIMARY_MARKER_PATH);
  const fallback = fallbackUsable ? readMarkerAt(FALLBACK_MARKER_PATH) : null;

  let chosen: MarkerReadAttempt | null;
  if (!primary) chosen = fallback;
  else if (!fallback) chosen = primary;
  else chosen = fallback.mtimeMs > primary.mtimeMs ? fallback : primary;

  if (!chosen) return null;

  // Negative age beyond 1 minute means clock skew — treat as stale so a
  // future-dated marker can't replay the announcement forever.
  const ageMs = Date.now() - chosen.mtimeMs;
  const isStale = ageMs < -MS_PER_MINUTE || ageMs > MARKER_TTL_MS;

  // Clean up both paths whether or not we honor the marker. We only attempt
  // invalidation for paths that actually had content; otherwise an existsSync
  // miss-then-create race could leave a zero-byte file we just created.
  const primaryCleared = primary ? invalidateFileAt(PRIMARY_MARKER_PATH) : true;
  const fallbackCleared = fallback ? invalidateFileAt(FALLBACK_MARKER_PATH) : true;
  if ((!primaryCleared || !fallbackCleared) && !warnedAboutMarkerClear) {
    warnedAboutMarkerClear = true;
    process.stderr.write(
      `Warning: could not clear upgrade marker (primary=${primaryCleared ? "ok" : "blocked"}, fallback=${fallbackCleared ? "ok" : "blocked"}). It will be ignored after ${MARKER_TTL_MS / MS_PER_MINUTE}min.\n`
    );
  }

  if (isStale) return null;
  return chosen.data;
}
