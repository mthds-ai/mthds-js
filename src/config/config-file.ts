// ── `~/.mthds/config` on disk ─────────────────────────────────────
// The file's path and its whole-file read and write, in the dialect of `dotenv.ts`. The path is
// computed on every call from the home directory, which the process reads from `HOME`
// (`USERPROFILE` on Windows). A module of its own, depending on nothing else of the configuration,
// so that the usage statistics, which carry the legacy `DISABLE_TELEMETRY` opt-out out of this file,
// read and rewrite it through the same code as `mthds config`.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDotenv, serializeDotenv } from "./dotenv.js";

/** `~/.mthds`, the directory of the config file and of the shared usage-statistics state. */
export function mthdsHomeDir(): string {
  return join(homedir(), ".mthds");
}

/** `~/.mthds/config`. */
export function configFilePath(): string {
  return join(mthdsHomeDir(), "config");
}

/** The file's entries; none when it does not exist or cannot be read. */
export function readConfigFile(): Record<string, string> {
  const path = configFilePath();
  if (!existsSync(path)) return {};
  try {
    return parseDotenv(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

/** Write the whole file with `entries`, owner-only. */
export function writeConfigFile(entries: Record<string, string>): void {
  const path = configFilePath();
  mkdirSync(mthdsHomeDir(), { recursive: true });
  // The file stores MTHDS_API_KEY — it MUST be owner-only (0600), per the config
  // file spec. `mode` only applies when the file is created (and is masked by the
  // umask), so chmod explicitly to also tighten a pre-existing file.
  writeFileSync(path, serializeDotenv(entries), { encoding: "utf-8", mode: 0o600 });
  chmodSync(path, 0o600);
}
