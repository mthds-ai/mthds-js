/**
 * Snooze state for update-check upgrade prompts.
 *
 * Manages ~/.mthds/state/update-snoozed — a single-line file:
 *   <versionKey> <level> <epoch>
 *
 * Version key is a plain concatenation of binary statuses (human-readable).
 * Escalating backoff: level 1 = 24h, level 2 = 48h, level 3+ = 7d.
 * Snooze resets when the version key changes (any binary constraint updated).
 */

import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { STATE_DIR, ensureStateDir } from "./update-cache.js";
import type { CachePayload } from "./update-cache.js";

// ── Types ──────────────────────────────────────────────────────────

export interface SnoozeState {
  versionKey: string;
  level: number;
  epoch: number; // Unix epoch ms when snooze was written
}

// ── Constants ──────────────────────────────────────────────────────

const SNOOZE_PATH = join(STATE_DIR, "update-snoozed");

const SNOOZE_DURATIONS_MS: Record<number, number> = {
  1: 24 * 60 * 60 * 1000, // 24h
  2: 48 * 60 * 60 * 1000, // 48h
};
const SNOOZE_DEFAULT_MS = 7 * 24 * 60 * 60 * 1000; // 7d for level 3+

// ── Functions ──────────────────────────────────────────────────────

/**
 * Compute a human-readable version key from a cache payload.
 * Format: "status1:status2:status3" with constraints appended for non-ok entries.
 * Changes whenever any binary's status or constraint changes.
 */
export function computeVersionKey(payload: CachePayload): string {
  const parts = [
    payload.mthds_agent.s + (payload.mthds_agent.r ? payload.mthds_agent.r : ""),
    payload.pipelex_agent.s + (payload.pipelex_agent.r ? payload.pipelex_agent.r : ""),
    payload.plxt.s + (payload.plxt.r ? payload.plxt.r : ""),
  ];
  return parts.join(":");
}

/** Read current snooze state. Returns null if missing or corrupt. */
export function readSnooze(): SnoozeState | null {
  if (!existsSync(SNOOZE_PATH)) return null;

  let content: string;
  try {
    content = readFileSync(SNOOZE_PATH, "utf-8").trim();
  } catch {
    return null;
  }

  // Format: "<versionKey> <level> <epoch>"
  // The version key may contain colons but not spaces, so split from the right.
  const lastSpace = content.lastIndexOf(" ");
  if (lastSpace === -1) return null;
  const epochStr = content.slice(lastSpace + 1);

  const rest = content.slice(0, lastSpace);
  const secondLastSpace = rest.lastIndexOf(" ");
  if (secondLastSpace === -1) return null;

  const versionKey = rest.slice(0, secondLastSpace);
  const levelStr = rest.slice(secondLastSpace + 1);

  const level = parseInt(levelStr, 10);
  const epoch = parseInt(epochStr, 10);
  if (isNaN(level) || isNaN(epoch) || level <= 0 || !versionKey) return null;

  return { versionKey, level, epoch };
}

/**
 * Write snooze state. Escalates level if same versionKey, resets if different.
 */
export function writeSnooze(versionKey: string): void {
  ensureStateDir();

  const existing = readSnooze();
  let level: number;
  if (existing && existing.versionKey === versionKey) {
    level = existing.level + 1;
  } else {
    level = 1;
  }

  const content = `${versionKey} ${level} ${Date.now()}\n`;
  try {
    writeFileSync(SNOOZE_PATH, content, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    process.stderr.write(
      `Warning: could not write snooze state (${code ?? String(err)}).\n`
    );
  }
}

/** Check if snooze is active for the given versionKey. */
export function isSnoozed(versionKey: string): boolean {
  const state = readSnooze();
  if (!state) return false;

  // Different version key means the constraint changed — snooze is invalid
  if (state.versionKey !== versionKey) return false;

  const duration = SNOOZE_DURATIONS_MS[state.level] ?? SNOOZE_DEFAULT_MS;
  return Date.now() - state.epoch < duration;
}

/** Clear snooze file. */
export function clearSnooze(): void {
  try {
    unlinkSync(SNOOZE_PATH);
  } catch {
    // File may not exist — that's fine
  }
}
