/**
 * This tool's spool, `~/.mthds/usage-stats/spool/mthds/`: the events written when a command ends,
 * waiting for a sender.
 *
 * A file is named `<created-ms>-<random>.json` and holds `{"spool_version": 1, "events": [...]}`.
 * It is written under a name starting with a dot and renamed into place, so a reader never sees it
 * partial. A sender claims a file by renaming it to `<name>.sending-<random>`, so two senders never
 * post one file, and after its attempt deletes the file or renames it back.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { SPOOL_LIMITS, STATE_FILES, TOOL } from "./contract.js";
import type { Envelope } from "./event.js";
import { ensureStateDir, stateDir } from "./state.js";

const SPOOL_VERSION = 1;
const CLAIM_MARKER = ".sending-";
const READY_NAME = /^(\d+)-[0-9a-f]+\.json$/;

export interface SpoolFile {
  spool_version: number;
  events: Envelope[];
}

export function spoolDir(): string {
  return join(stateDir(), STATE_FILES.spool, TOOL);
}

function randomSuffix(): string {
  return randomBytes(6).toString("hex");
}

function ageMs(path: string, name: string, now: number): number | undefined {
  const created = READY_NAME.exec(name.split(CLAIM_MARKER)[0]!);
  if (created) return now - Number(created[1]);
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/** The files waiting to be sent, oldest first: neither temporary nor claimed. */
export function listReadyFiles(): string[] {
  let names: string[];
  try {
    names = readdirSync(spoolDir());
  } catch {
    return [];
  }
  return names
    .filter((name) => READY_NAME.test(name))
    .sort((left, right) => Number(READY_NAME.exec(left)![1]) - Number(READY_NAME.exec(right)![1]))
    .map((name) => join(spoolDir(), name));
}

/**
 * Write `events` as one new spool file, keeping at most the contract's number of files by deleting
 * the oldest. Answers the file's path.
 */
export function writeSpoolFile(events: Envelope[]): string {
  ensureStateDir();
  const directory = spoolDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ready = listReadyFiles();
  for (const path of ready.slice(
    0,
    Math.max(0, ready.length - (SPOOL_LIMITS.maxFilesPerTool - 1)),
  )) {
    rmSync(path, { force: true });
  }
  const name = `${Date.now()}-${randomSuffix()}.json`;
  const temporary = join(directory, `.${name}.${randomSuffix()}.tmp`);
  const content: SpoolFile = { spool_version: SPOOL_VERSION, events };
  writeFileSync(temporary, JSON.stringify(content), { encoding: "utf-8", mode: 0o600 });
  const path = join(directory, name);
  renameSync(temporary, path);
  return path;
}

/**
 * Claim `path` for this sender; undefined when another sender claimed it first or it is gone. The
 * claimed file's modification time is set to now, since a rename keeps it, so the age of the claim,
 * not of the events, is what makes another sender take it back.
 */
export function claimFile(path: string): string | undefined {
  const claimed = `${path}${CLAIM_MARKER}${randomSuffix()}`;
  try {
    renameSync(path, claimed);
  } catch {
    return undefined;
  }
  try {
    const now = new Date();
    utimesSync(claimed, now, now);
  } catch {
    // The claim stands; it may be taken back early, which only costs a duplicate PostHog drops.
  }
  return claimed;
}

/** Give a claimed file back to the spool under its original name, for the next sender. */
export function releaseClaim(claimed: string): void {
  try {
    renameSync(claimed, claimed.slice(0, claimed.lastIndexOf(CLAIM_MARKER)));
  } catch {
    // Deleted meanwhile, by `disable` or `reset-id`.
  }
}

export function deleteFile(path: string): void {
  rmSync(path, { force: true });
}

/** Read a spool file; undefined when it is not one this sender can read, which it then deletes. */
export function readSpoolFile(path: string): SpoolFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<SpoolFile>;
    if (parsed.spool_version !== SPOOL_VERSION || !Array.isArray(parsed.events)) return undefined;
    return { spool_version: SPOOL_VERSION, events: parsed.events };
  } catch {
    return undefined;
  }
}

/**
 * Rewrite a file this sender holds claimed, with the events it keeps; false when the file is gone.
 * It is written in place, opened without creating it, so a file that `disable`, `reset-id` or the
 * legacy migration deleted meanwhile is never written again. No other sender reads a claimed file.
 */
export function rewriteClaimed(claimed: string, events: Envelope[]): boolean {
  const content: SpoolFile = { spool_version: SPOOL_VERSION, events };
  let descriptor: number;
  try {
    descriptor = openSync(claimed, "r+");
  } catch {
    return false;
  }
  try {
    ftruncateSync(descriptor, 0);
    writeSync(descriptor, JSON.stringify(content), 0, "utf-8");
    return true;
  } catch {
    return false;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * The spool's housekeeping, run by each sender before it posts: a claim older than the contract's
 * limit is a crashed sender's and goes back to the spool, a file older than the age limit is
 * deleted unsent, and a temporary file older than an hour is a leftover and is deleted.
 */
export function tidySpool(now: number = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(spoolDir());
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(spoolDir(), name);
    const age = ageMs(path, name, now);
    if (age === undefined) continue;
    if (name.startsWith(".")) {
      if (age > SPOOL_LIMITS.staleTempMinutes * 60_000) deleteFile(path);
    } else if (name.includes(CLAIM_MARKER)) {
      let claimAge: number;
      try {
        claimAge = now - statSync(path).mtimeMs;
      } catch {
        continue;
      }
      if (age > SPOOL_LIMITS.maxAgeDays * 86_400_000) deleteFile(path);
      else if (claimAge > SPOOL_LIMITS.staleClaimMinutes * 60_000) releaseClaim(path);
    } else if (READY_NAME.test(name) && age > SPOOL_LIMITS.maxAgeDays * 86_400_000) {
      deleteFile(path);
    }
  }
}
