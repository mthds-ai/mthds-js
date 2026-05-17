/**
 * Cache for update-check results, plus the just-upgraded marker.
 *
 * Primary location: ~/.mthds/state/.
 * Fallback location: $TMPDIR/mthds-agent/ — used when the primary location is
 * not writable (e.g. Codex's workspaceWrite sandbox permits writes only under
 * cwd / configured roots / $TMPDIR, not under the user's home dir).
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
  readFileSync,
  writeFileSync,
  unlinkSync,
  statSync,
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

// ── Constants ──────────────────────────────────────────────────────

/** One minute in milliseconds. Base unit for the TTLs below and for the
 *  clock-skew tolerance applied when comparing file mtimes to the wall clock. */
export const MS_PER_MINUTE = 60_000;

/** Primary state directory (~/.mthds/state). Exported so snooze.ts shares the
 *  same dual-path layout from a single source of truth. */
export const STATE_DIR = join(homedir(), ".mthds", "state");
/** Fallback state directory ($TMPDIR/mthds-agent), used when STATE_DIR is not
 *  writable (Codex's workspaceWrite sandbox). Exported for snooze.ts. */
export const FALLBACK_DIR = join(tmpdir(), "mthds-agent");

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
  const fallback = readCacheAt(FALLBACK_CACHE_PATH);
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
 * Best-effort `mkdir -p` + `writeFile`. Returns `{ok: true}` on success, or
 * `{ok: false, code}` on any failure (errno code if available, else stringified
 * error). Callers decide whether to retry on a fallback path based on `code`
 * — see `SANDBOX_WRITE_ERRORS` for the sandbox-fallback predicate.
 */
export function writeFileAt(dir: string, file: string, content: string): WriteAttempt {
  try {
    // mode 0o700 keeps the fallback dir ($TMPDIR/mthds-agent on a possibly
    // world-writable /tmp) private to the current user. No-op on dirs that
    // already exist; harmless and equally appropriate for ~/.mthds/state.
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, content, "utf-8");
    return { ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? String(err);
    return { ok: false, code };
  }
}

/**
 * Write `content` to `primaryPath`; on a sandbox/permission failure (see
 * `SANDBOX_WRITE_ERRORS`) retry once at `fallbackPath`. Other failure classes
 * (ENOSPC, IO errors) are not improved by retrying elsewhere, so they are
 * reported without a fallback attempt. The single owner of the
 * try-primary-then-fallback policy shared by the cache, marker, and snooze
 * writers — callers only supply their own one-shot warning text.
 */
export function writeWithFallback(
  primaryDir: string,
  primaryPath: string,
  fallbackDir: string,
  fallbackPath: string,
  content: string,
): WriteAttempt & { fallbackCode?: string } {
  const primary = writeFileAt(primaryDir, primaryPath, content);
  if (primary.ok) return { ok: true };

  if (primary.code && SANDBOX_WRITE_ERRORS.has(primary.code)) {
    const fallback = writeFileAt(fallbackDir, fallbackPath, content);
    if (fallback.ok) return { ok: true };
    return { ok: false, code: primary.code, fallbackCode: fallback.code };
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
    FALLBACK_DIR,
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
  for (const p of [PRIMARY_CACHE_PATH, FALLBACK_CACHE_PATH]) {
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
    FALLBACK_DIR,
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
 * rejected by the single-line snooze parser). Returns true when the file is
 * either gone or guaranteed unparseable.
 */
export function invalidateFileAt(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    // fall through
  }
  try {
    writeFileSync(path, "", "utf-8");
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
  const primary = readMarkerAt(PRIMARY_MARKER_PATH);
  const fallback = readMarkerAt(FALLBACK_MARKER_PATH);

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
