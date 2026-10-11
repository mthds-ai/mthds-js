/**
 * The account's real usage-statistics state, `~/.mthds/usage-stats/` under the home directory the
 * account has, not the one HOME names: vitest.config.ts points HOME at a scratch directory, and no
 * test may change the real one.
 */

import { readdirSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join, relative } from "node:path";

export const REAL_STATE_DIR = join(userInfo().homedir, ".mthds", "usage-stats");

/** Every path under the real state directory with its size and modification time, or `absent`. */
export function realStateSnapshot(): string {
  const entries: string[] = [];
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = statSync(path);
      entries.push(`${relative(REAL_STATE_DIR, path)} ${stat.size} ${stat.mtimeMs}`);
      if (stat.isDirectory()) walk(path);
    }
  };
  try {
    statSync(REAL_STATE_DIR);
  } catch {
    return "absent";
  }
  try {
    walk(REAL_STATE_DIR);
  } catch {
    entries.push("(changed while it was read)");
  }
  return entries.join("\n");
}
