/**
 * Cache for update-check results.
 *
 * Primary location: ~/.mthds/state/last-update-check.
 * Fallback location: $TMPDIR/mthds-agent/last-update-check — used when the
 * primary location is not writable (e.g. Codex's workspaceWrite sandbox
 * permits writes only under cwd / configured roots / $TMPDIR, not under the
 * user's home dir).
 *
 * Two-line format:
 *   Line 1: aggregate status (UP_TO_DATE or UPGRADE_AVAILABLE)
 *   Line 2: JSON payload with per-binary check results
 *
 * TTL is based on file mtime (like gstack), not an embedded timestamp.
 * Split TTL: 60 min for UP_TO_DATE, 720 min for UPGRADE_AVAILABLE.
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

export const STATE_DIR = join(homedir(), ".mthds", "state");
const PRIMARY_CACHE_PATH = join(STATE_DIR, "last-update-check");

const FALLBACK_DIR = join(tmpdir(), "mthds-agent");
const FALLBACK_CACHE_PATH = join(FALLBACK_DIR, "last-update-check");

const TTL_UP_TO_DATE_MS = 60 * 60 * 1000; // 60 min
const TTL_UPGRADE_AVAILABLE_MS = 720 * 60 * 1000; // 720 min (12 hours)

const VALID_AGGREGATES: ReadonlySet<string> = new Set([
  "UP_TO_DATE",
  "UPGRADE_AVAILABLE",
]);

const SANDBOX_WRITE_ERRORS: ReadonlySet<string> = new Set([
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

// ── Per-process warning latch ──────────────────────────────────────

let warnedAboutCacheWrite = false;

// ── Functions ──────────────────────────────────────────────────────

/** Ensure the state directory exists. */
export function ensureStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true });
}

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
  if (age < -60_000 || age > ttl) return null;

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

interface WriteAttempt {
  ok: boolean;
  code?: string;
}

function writeCacheAt(dir: string, file: string, content: string): WriteAttempt {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, content, "utf-8");
    return { ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? String(err);
    return { ok: false, code };
  }
}

/**
 * Write cache. Tries the primary path first; on sandbox / permission failures
 * falls back to $TMPDIR. Both failing emits at most one warning per process.
 */
export function writeCache(result: CacheResult): void {
  const content =
    result.aggregate + "\n" + JSON.stringify(result.payload) + "\n";

  const primary = writeCacheAt(STATE_DIR, PRIMARY_CACHE_PATH, content);
  if (primary.ok) return;

  // Only fall back for the sandbox/perm family of errors. Other failures
  // (ENOSPC, IO errors, ...) are not improved by retrying in $TMPDIR, so we
  // surface them via the same one-shot warning path.
  if (primary.code && SANDBOX_WRITE_ERRORS.has(primary.code)) {
    const fallback = writeCacheAt(FALLBACK_DIR, FALLBACK_CACHE_PATH, content);
    if (fallback.ok) return;
    emitWriteWarning(primary.code, fallback.code);
    return;
  }

  emitWriteWarning(primary.code);
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
