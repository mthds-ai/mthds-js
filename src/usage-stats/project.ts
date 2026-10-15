/**
 * The project setting: `[usage_stats] enabled = false` in the project's committed
 * `.pipelex/pipelex.toml` turns statistics off for everyone who works in it.
 *
 * The project is found the way pipelex finds its project configuration: from the working directory,
 * walk up through the parents, stopping at the user's home directory, which is never a project, and
 * at the filesystem root; the first directory holding any of the contract's markers is the project
 * root. The setting can only turn statistics off, and it fails closed: a file that cannot be read,
 * is not valid TOML, or holds a `usage_stats` or an `enabled` of the wrong type turns them off.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { PROJECT_MARKERS } from "./contract.js";

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** The project root `cwd` belongs to, or undefined when none is found below the home directory. */
export function findProjectRoot(
  cwd: string = process.cwd(),
  home: string = homedir(),
): string | undefined {
  const homeDir = resolve(home);
  let current = resolve(cwd);
  for (;;) {
    if (current === homeDir) return undefined;
    if (PROJECT_MARKERS.some((marker) => exists(join(current, marker)))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** Whether the project's `.pipelex/pipelex.toml` turns statistics off, failing closed on a bad file. */
export function projectSettingTurnsOff(
  cwd: string = process.cwd(),
  home: string = homedir(),
): boolean {
  const root = findProjectRoot(cwd, home);
  if (root === undefined) return false;
  const path = join(root, ".pipelex", "pipelex.toml");
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
  let document: Record<string, unknown>;
  try {
    document = parse(content) as Record<string, unknown>;
  } catch {
    return true;
  }
  if (!("usage_stats" in document)) return false;
  const section = document["usage_stats"];
  if (typeof section !== "object" || section === null || Array.isArray(section)) return true;
  if (!("enabled" in section)) return false;
  const enabled = (section as Record<string, unknown>)["enabled"];
  if (typeof enabled !== "boolean") return true;
  return !enabled;
}
