/**
 * Snooze state for update-check upgrade prompts.
 *
 * Manages a single-line file:
 *   <versionKey> <level> <epoch>
 *
 * Primary location: ~/.mthds/state/update-snoozed.
 * Fallback location: $TMPDIR/mthds-agent-<uid>/update-snoozed — used when the
 * primary location is not writable (Codex `workspaceWrite` sandbox permits
 * writes only under cwd / configured roots / $TMPDIR, not under the user's
 * home dir). Same dual-path policy as the update-check cache and the
 * just-upgraded marker, including the symlink/TOCTOU hardening of the
 * fallback directory — see update-cache.ts.
 *
 * Reads consult both paths and prefer the newer mtime, so escalation
 * (level 1 → 2 → 3+) stays correct as sessions move between sandboxed and
 * non-sandboxed contexts.
 *
 * Version key is a plain concatenation of binary statuses (human-readable).
 * Escalating backoff: level 1 = 24h, level 2 = 48h, level 3+ = 7d.
 * Snooze resets when the version key changes (any binary constraint updated).
 */

import { join } from "node:path";
import { readFileSync, statSync, existsSync } from "node:fs";
import {
  MS_PER_MINUTE,
  STATE_DIR,
  FALLBACK_DIR,
  ensureFallbackDir,
  writeWithFallback,
  invalidateFileAt,
} from "./update-cache.js";
import type { CachePayload } from "./update-cache.js";

// ── Types ──────────────────────────────────────────────────────────

export interface SnoozeState {
  versionKey: string;
  level: number;
  epoch: number; // Unix epoch ms when snooze was written
}

// ── Constants ──────────────────────────────────────────────────────

const PRIMARY_SNOOZE_PATH = join(STATE_DIR, "update-snoozed");
const FALLBACK_SNOOZE_PATH = join(FALLBACK_DIR, "update-snoozed");

const SNOOZE_DURATIONS_MS: Record<number, number> = {
  1: 24 * 60 * 60 * 1000, // 24h
  2: 48 * 60 * 60 * 1000, // 48h
};
const SNOOZE_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000; // 7d for level 3+

// ── Per-process warning latches ────────────────────────────────────

let warnedAboutSnoozeWrite = false;
let warnedAboutSnoozeClear = false;

// ── Functions ──────────────────────────────────────────────────────

/**
 * Compute a human-readable version key from a cache payload.
 * Format: "status1:status2:status3" with constraints appended for non-ok entries.
 * Changes whenever any binary's status or constraint changes.
 */
export function computeVersionKey(payload: CachePayload): string {
  const parts = [
    payload.mthds_agent.s + (payload.mthds_agent.r ?? ""),
  ];
  if (payload.pipelex_agent) {
    parts.push(payload.pipelex_agent.s + (payload.pipelex_agent.r ?? ""));
  }
  parts.push(payload.plxt.s + (payload.plxt.r ?? ""));
  if (payload.plugin) {
    parts.push("p:" + payload.plugin.s + (payload.plugin.r ?? ""));
  }
  return parts.join(":");
}

interface SnoozeReadAttempt {
  state: SnoozeState;
  mtimeMs: number;
}

function parseSnoozeContent(content: string): SnoozeState | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  // Format: "<versionKey> <level> <epoch>"
  // The version key may contain colons but not spaces, so split from the right.
  const lastSpace = trimmed.lastIndexOf(" ");
  if (lastSpace === -1) return null;
  const epochStr = trimmed.slice(lastSpace + 1);

  const rest = trimmed.slice(0, lastSpace);
  const secondLastSpace = rest.lastIndexOf(" ");
  if (secondLastSpace === -1) return null;

  const versionKey = rest.slice(0, secondLastSpace);
  const levelStr = rest.slice(secondLastSpace + 1);

  const level = parseInt(levelStr, 10);
  const epoch = parseInt(epochStr, 10);
  if (isNaN(level) || isNaN(epoch) || level <= 0 || !versionKey) return null;

  return { versionKey, level, epoch };
}

function readSnoozeAt(path: string): SnoozeReadAttempt | null {
  let mtimeMs: number;
  let content: string;
  try {
    mtimeMs = statSync(path).mtimeMs;
    content = readFileSync(path, "utf-8");
  } catch {
    return null;
  }
  const state = parseSnoozeContent(content);
  if (!state) return null;
  return { state, mtimeMs };
}

/**
 * Read current snooze state. Returns null if missing or corrupt.
 *
 * Inspects both the primary and the fallback path; when both have valid
 * contents, the one with the newer mtime wins. This keeps escalation
 * correct when a session moves between sandboxed and non-sandboxed contexts:
 * the older file is a stale snapshot from before the redirect happened.
 */
export function readSnooze(): SnoozeState | null {
  const primary = readSnoozeAt(PRIMARY_SNOOZE_PATH);
  const fallback = ensureFallbackDir(false).usable
    ? readSnoozeAt(FALLBACK_SNOOZE_PATH)
    : null;
  if (!primary) return fallback?.state ?? null;
  if (!fallback) return primary.state;
  return fallback.mtimeMs > primary.mtimeMs ? fallback.state : primary.state;
}

/**
 * Write snooze state. Escalates level if same versionKey, resets to 1 if
 * different. Sandbox-aware: falls back to $TMPDIR when ~/.mthds/state/ is
 * not writable. Write failures emit a one-shot stderr warning per process.
 */
export function writeSnooze(versionKey: string): void {
  const existing = readSnooze();
  const level =
    existing && existing.versionKey === versionKey ? existing.level + 1 : 1;
  const content = `${versionKey} ${level} ${Date.now()}\n`;

  const res = writeWithFallback(
    STATE_DIR,
    PRIMARY_SNOOZE_PATH,
    FALLBACK_SNOOZE_PATH,
    content,
  );
  if (res.ok) return;
  emitSnoozeWriteWarning(res.code, res.fallbackCode);
}

function emitSnoozeWriteWarning(primaryCode?: string, fallbackCode?: string): void {
  if (warnedAboutSnoozeWrite) return;
  warnedAboutSnoozeWrite = true;
  const detail = fallbackCode
    ? `primary=${primaryCode ?? "?"}, fallback=${fallbackCode}`
    : (primaryCode ?? "?");
  process.stderr.write(
    `Warning: could not write snooze state (${detail}). The upgrade prompt may re-appear next time.\n`
  );
}

/** Check if snooze is active for the given versionKey. */
export function isSnoozed(versionKey: string): boolean {
  const state = readSnooze();
  if (!state) return false;

  // Different version key means the constraint changed — snooze is invalid
  if (state.versionKey !== versionKey) return false;

  const duration = SNOOZE_DURATIONS_MS[state.level] ?? SNOOZE_DEFAULT_MS;
  const elapsed = Date.now() - state.epoch;
  // Negative elapsed beyond 1 minute means clock skew — treat snooze as expired
  return elapsed >= -MS_PER_MINUTE && elapsed < duration;
}

/**
 * Clear snooze. Hits the primary path and — when its directory passes the
 * hardening check — the fallback path. When unlink is blocked (sandbox EPERM),
 * overwrites with empty content so the next read parses as null. Warns at most
 * once per process when a present file cannot be cleared by either route.
 * Silent when both paths were absent to begin with — no spurious 0-byte file
 * is created in that case.
 */
export function clearSnooze(): void {
  let blocked = false;
  const paths = [PRIMARY_SNOOZE_PATH];
  if (ensureFallbackDir(false).usable) paths.push(FALLBACK_SNOOZE_PATH);
  for (const path of paths) {
    if (!existsSync(path)) continue;
    if (!invalidateFileAt(path)) blocked = true;
  }
  if (blocked && !warnedAboutSnoozeClear) {
    warnedAboutSnoozeClear = true;
    process.stderr.write(
      `Warning: could not clear snooze state. The upgrade prompt may stay suppressed until the TTL expires.\n`
    );
  }
}
