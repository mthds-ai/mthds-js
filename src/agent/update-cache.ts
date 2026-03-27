/**
 * Cache for update-check results.
 *
 * Manages ~/.mthds/state/last-update-check — a two-line file:
 *   Line 1: aggregate status (UP_TO_DATE or UPGRADE_AVAILABLE)
 *   Line 2: JSON payload with per-binary check results
 *
 * TTL is based on file mtime (like gstack), not an embedded timestamp.
 * Split TTL: 60 min for UP_TO_DATE, 720 min for UPGRADE_AVAILABLE.
 */

import { join } from "node:path";
import { homedir } from "node:os";
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
}

export interface CacheResult {
  aggregate: AggregateStatus;
  payload: CachePayload;
}

// ── Constants ──────────────────────────────────────────────────────

export const STATE_DIR = join(homedir(), ".mthds", "state");
const CACHE_PATH = join(STATE_DIR, "last-update-check");

const TTL_UP_TO_DATE_MS = 60 * 60 * 1000; // 60 min
const TTL_UPGRADE_AVAILABLE_MS = 720 * 60 * 1000; // 720 min (12 hours)

const VALID_AGGREGATES: ReadonlySet<string> = new Set([
  "UP_TO_DATE",
  "UPGRADE_AVAILABLE",
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
  return true;
}

// ── Functions ──────────────────────────────────────────────────────

/** Ensure the state directory exists. */
export function ensureStateDir(): void {
  mkdirSync(STATE_DIR, { recursive: true });
}

/** Compute aggregate status from a payload. */
export function computeAggregate(payload: CachePayload): AggregateStatus {
  const entries: BinaryCheckEntry[] = [payload.mthds_agent, payload.plxt];
  if (payload.pipelex_agent) entries.push(payload.pipelex_agent);
  return entries.every((e) => e.s === "ok") ? "UP_TO_DATE" : "UPGRADE_AVAILABLE";
}

/**
 * Read the update-check cache.
 * Returns null if the file is missing, corrupt, or expired.
 */
export function readCache(): CacheResult | null {
  // Stat first so worst-case TOCTOU treats fresh data as stale (safe direction)
  let mtimeMs: number;
  let content: string;
  try {
    mtimeMs = statSync(CACHE_PATH).mtimeMs;
    content = readFileSync(CACHE_PATH, "utf-8");
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

  // Check TTL based on file mtime
  const ttl =
    aggregate === "UP_TO_DATE"
      ? TTL_UP_TO_DATE_MS
      : TTL_UPGRADE_AVAILABLE_MS;
  const age = Date.now() - mtimeMs;
  // Negative age beyond 1 minute means clock skew — treat as expired
  if (age < -60_000 || age > ttl) return null;

  return { aggregate: aggregate as AggregateStatus, payload };
}

/** Write cache. Creates state directory if needed. */
export function writeCache(result: CacheResult): void {
  ensureStateDir();
  const content =
    result.aggregate + "\n" + JSON.stringify(result.payload) + "\n";
  try {
    writeFileSync(CACHE_PATH, content, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    process.stderr.write(
      `Warning: could not write update-check cache (${code ?? String(err)}). Check will run again next time.\n`
    );
  }
}

/** Delete cache file (used by --force and after upgrade). */
export function clearCache(): void {
  try {
    unlinkSync(CACHE_PATH);
  } catch {
    // File may not exist — that's fine
  }
}
