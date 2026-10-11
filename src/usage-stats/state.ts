/**
 * The shared state every reporting tool on the machine reads and writes: `~/.mthds/usage-stats/`
 * (`%USERPROFILE%\.mthds\usage-stats\` on Windows), one small file per fact.
 *
 * A file is created or deleted whole and never rewritten, so two tools running at once can never
 * undo each other's choice. Paths are computed on every call from the home directory, which the
 * process reads from `HOME` (`USERPROFILE` on Windows).
 */

import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { join } from "node:path";
import {
  configFilePath,
  mthdsHomeDir,
  readConfigFile,
  writeConfigFile,
} from "../config/config-file.js";
import { parseDotenv } from "../config/dotenv.js";
import {
  INSTALLATION_ID_PATTERN,
  LEGACY_KEY,
  NOTICE_VERSION,
  STATE_FILES,
  SPOOL_LIMITS,
} from "./contract.js";
import { isMthdsDisableOn } from "./environment.js";

const ID_TEMP_PREFIX = `${STATE_FILES.id}.tmp-`;

// ── Paths ───────────────────────────────────────────────────────────

export function mthdsDir(): string {
  return mthdsHomeDir();
}

export function stateDir(): string {
  return join(mthdsDir(), "usage-stats");
}

/** `~/.mthds/config`, where today's `mthds` CLI kept its opt-out as `DISABLE_TELEMETRY`. */
export function legacyConfigPath(): string {
  return configFilePath();
}

function statePath(name: string): string {
  return join(stateDir(), name);
}

/** Create the state directory, owner-only, if it does not exist yet. */
export function ensureStateDir(): void {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Create `path` whole, empty, unless it exists; a file that exists is left untouched. */
function createEmptyFile(path: string): void {
  try {
    writeFileSync(path, "", { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

function randomSuffix(): string {
  return randomBytes(6).toString("hex");
}

// ── The installation identifier ─────────────────────────────────────

export type IdReading = { kind: "absent" } | { kind: "malformed" } | { kind: "valid"; id: string };

/** Read `id`, accepting its content only when, whitespace stripped, it is a canonical UUID v4. */
export function readInstallationId(): IdReading {
  let content: string;
  try {
    content = readFileSync(statePath(STATE_FILES.id), "utf-8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "malformed" };
  }
  const id = content.trim();
  return INSTALLATION_ID_PATTERN.test(id) ? { kind: "valid", id } : { kind: "malformed" };
}

/** The identifier this process reports under, whether it created it, and whether `id` holds it. */
export interface Installation {
  id: string;
  idNew: boolean;
  persisted: boolean;
}

/** Delete `id.tmp-*` files an hour old or more: the leftovers of a crash, which any tool may delete. */
function sweepStaleIdTemps(): void {
  let names: string[];
  try {
    names = readdirSync(stateDir());
  } catch {
    return;
  }
  const cutoff = Date.now() - SPOOL_LIMITS.staleTempMinutes * 60_000;
  for (const name of names) {
    if (!name.startsWith(ID_TEMP_PREFIX)) continue;
    const path = statePath(name);
    try {
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
    } catch {
      // Another tool removed it first.
    }
  }
}

/**
 * Publish a fresh identifier as `id` without ever exposing it empty or partial: write it to a
 * temporary file, flush it, and hard-link it to `id`, which fails when `id` exists. First runs
 * racing on a fresh machine therefore converge on one identifier, exactly one of them creating it.
 */
function publishFreshId(fresh: string): Installation {
  ensureStateDir();
  sweepStaleIdTemps();
  const temporary = statePath(`${ID_TEMP_PREFIX}${randomSuffix()}`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeSync(fd, fresh);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(temporary, statePath(STATE_FILES.id));
    return { id: fresh, idNew: true, persisted: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const winner = readInstallationId();
    if (winner.kind === "valid") return { id: winner.id, idNew: false, persisted: true };
    return { id: fresh, idNew: true, persisted: false };
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Already gone.
    }
  }
}

/**
 * The identifier this process reports under. An existing valid `id` is read; a missing one is
 * created as {@link publishFreshId} says. A malformed `id` is never rewritten, and a directory that
 * cannot hold one (not writable, or a filesystem without hard links) gives the process a fresh
 * identifier of its own, persisted nowhere.
 */
export function obtainInstallationId(): Installation {
  const reading = readInstallationId();
  if (reading.kind === "valid") return { id: reading.id, idNew: false, persisted: true };
  const fresh = randomUUID();
  if (reading.kind === "malformed") return { id: fresh, idNew: true, persisted: false };
  try {
    return publishFreshId(fresh);
  } catch {
    return { id: fresh, idNew: true, persisted: false };
  }
}

/**
 * `reset-id`: delete `id` and create a new identifier the usual way. Throws when the new one cannot
 * be persisted, so the command can say it could not do what it says.
 */
export function replaceInstallationId(): string {
  ensureStateDir();
  rmSync(statePath(STATE_FILES.id), { force: true });
  const installation = publishFreshId(randomUUID());
  if (!installation.persisted) {
    throw new Error(`Could not write a new identifier to ${statePath(STATE_FILES.id)}.`);
  }
  return installation.id;
}

// ── The machine choice and the internal marker ──────────────────────

/** Whether the `disabled` file says statistics are off on this machine, for every tool. */
export function isMachineDisabled(): boolean {
  return exists(statePath(STATE_FILES.disabled));
}

export function createDisabledFile(): void {
  ensureStateDir();
  createEmptyFile(statePath(STATE_FILES.disabled));
}

export function removeDisabledFile(): void {
  rmSync(statePath(STATE_FILES.disabled), { force: true });
}

/** Whether the machine is marked as one of the team's, so every event carries `internal: true`. */
export function isInternalMachine(): boolean {
  return exists(statePath(STATE_FILES.internal));
}

// ── The notice markers ──────────────────────────────────────────────

/** The highest notice version, no higher than this tool's, recorded as shown on this machine; 0 when none. */
export function noticeVersionSeen(): number {
  for (let version = NOTICE_VERSION; version >= 1; version--) {
    if (exists(statePath(`${STATE_FILES.noticePrefix}${version}`))) return version;
  }
  return 0;
}

/** Record that this tool's notice was shown; false when the marker cannot be written. */
export function recordNoticeShown(): boolean {
  try {
    ensureStateDir();
    createEmptyFile(statePath(`${STATE_FILES.noticePrefix}${NOTICE_VERSION}`));
    return true;
  } catch {
    return false;
  }
}

// ── Every tool's spool ──────────────────────────────────────────────

/** Delete every spooled file of every tool, claimed or not: what `disable`, `reset-id` and the migration do. */
export function deleteEverySpool(): void {
  const root = statePath(STATE_FILES.spool);
  let tools: string[];
  try {
    tools = readdirSync(root);
  } catch {
    return;
  }
  for (const tool of tools) {
    const directory = join(root, tool);
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        rmSync(join(directory, name), { force: true });
      } catch {
        // A directory, or a file another process holds: left as it is.
      }
    }
  }
}

// ── The legacy `mthds` opt-out ──────────────────────────────────────

interface LegacyReading {
  /** Whether `DISABLE_TELEMETRY` in `~/.mthds/config` means off. */
  off: boolean;
  /** The config file's modification time, in milliseconds. */
  mtimeMs: number;
}

/**
 * The last parse of `~/.mthds/config` in this process, keyed by the file's path, inode, size and
 * times, so that a sender, which runs the migration before each post, parses the file again only
 * when it changed. The file is stat'ed before it is read, so a write between the two leaves a key
 * older than the content, which the next reading parses again, never the reverse.
 */
let lastParsed: { key: string; off: boolean } | undefined;

function readLegacyOptOut(): LegacyReading | undefined {
  const path = legacyConfigPath();
  let stats: Stats;
  try {
    stats = statSync(path);
  } catch {
    return undefined;
  }
  const { mtimeMs } = stats;
  const key = [path, stats.ino, stats.size, mtimeMs, stats.ctimeMs].join("\0");
  if (lastParsed?.key === key) return { off: lastParsed.off, mtimeMs };
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
  const off = isMthdsDisableOn(parseDotenv(content)[LEGACY_KEY]);
  lastParsed = { key, off };
  return { off, mtimeMs };
}

function mtimeMsOf(path: string): number | undefined {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

function legacyMarkerMtimeMs(): number | undefined {
  return mtimeMsOf(statePath(STATE_FILES.legacyMigrated));
}

/**
 * Whether the legacy opt-out is on and not migrated yet: `DISABLE_TELEMETRY` means off in
 * `~/.mthds/config`, and the file is newer than the `legacy-migrated` marker, or no marker exists.
 * The marker records when the file was last read, so a file no newer than it is not parsed at all.
 */
export function legacyOptOutPending(): boolean {
  const configMtimeMs = mtimeMsOf(legacyConfigPath());
  if (configMtimeMs === undefined) return false;
  const marker = legacyMarkerMtimeMs();
  if (marker !== undefined && configMtimeMs <= marker) return false;
  const legacy = readLegacyOptOut();
  if (!legacy?.off) return false;
  return marker === undefined || legacy.mtimeMs > marker;
}

/**
 * Whether the legacy opt-out is on and already carried into the shared state, or turned back on by
 * `enable` since: `DISABLE_TELEMETRY` means off, and the `legacy-migrated` marker is at least as
 * recent as the file. A write of the file for another setting must not make it pending again.
 */
export function legacyOptOutSettled(): boolean {
  const legacy = readLegacyOptOut();
  if (!legacy?.off) return false;
  const marker = legacyMarkerMtimeMs();
  return marker !== undefined && legacy.mtimeMs <= marker;
}

/**
 * Set the `legacy-migrated` marker's modification time to the later of now and the config file's,
 * so the opt-out it records is not migrated again. One millisecond is added to the file's time, so
 * a timestamp the filesystem stores more coarsely than it reports never leaves the marker older
 * than the file it covers.
 */
export function markLegacyMigrated(): void {
  ensureStateDir();
  const marker = statePath(STATE_FILES.legacyMigrated);
  createEmptyFile(marker);
  const configMtimeMs = readLegacyOptOut()?.mtimeMs;
  const targetMs = Math.max(Date.now(), configMtimeMs === undefined ? 0 : configMtimeMs + 1);
  const seconds = targetMs / 1000;
  utimesSync(marker, seconds, seconds);
}

/**
 * Turn usage statistics on for the machine, as `enable` does: delete `disabled`, take a
 * `DISABLE_TELEMETRY` an older `mthds` left in `~/.mthds/config` out of the file, and set the
 * `legacy-migrated` marker past the file. Taking the key out matters as much as the marker: left in,
 * the old opt-out would come back with the next write of the file for any other setting, such as
 * `mthds runner setup`, which dates the file past the marker. The file is rewritten only when it
 * holds the key, and a file that cannot be rewritten leaves the marker to keep the old opt-out from
 * applying again.
 */
export function enableOnMachine(): void {
  removeDisabledFile();
  try {
    const entries = readConfigFile();
    if (LEGACY_KEY in entries) {
      delete entries[LEGACY_KEY];
      writeConfigFile(entries);
    }
  } catch {
    // The marker below still keeps the old opt-out from applying again.
  }
  markLegacyMigrated();
}

/**
 * Carry the legacy opt-out into the shared state when it is pending: create `disabled`, delete every
 * tool's spool as `disable` does, and set the marker. Answers whether it migrated. A migration that
 * cannot write the state directory leaves the opt-out pending, which keeps statistics off anyway.
 */
export function runLegacyMigration(): boolean {
  if (!legacyOptOutPending()) return false;
  try {
    createDisabledFile();
    deleteEverySpool();
    markLegacyMigrated();
    return true;
  } catch {
    return false;
  }
}
