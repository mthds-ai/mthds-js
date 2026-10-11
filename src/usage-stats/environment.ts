/**
 * What the process can tell about where it runs: the readings of the switch variables, CI and
 * containers, and the system facts every event carries.
 */

import { existsSync, readFileSync } from "node:fs";
import { CI_VARIABLES, CONTAINER_MARKERS, SWITCH_VALUES } from "./contract.js";

/** A variable's value as every switch reads it: surrounding whitespace removed, case ignored. */
export function normalizedValue(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value.trim().toLowerCase();
}

/**
 * Whether a variable read the way `DO_NOT_TRACK` is read says yes: set to anything but the empty
 * string, `0` or `false`. The debug variable and the CI variables read the same way.
 */
export function isSetAndNotFalsy(value: string | undefined): boolean {
  const normalized = normalizedValue(value);
  return (
    normalized !== undefined && !(SWITCH_VALUES.falsy as readonly string[]).includes(normalized)
  );
}

/** Whether `DISABLE_TELEMETRY`, in the environment or in `~/.mthds/config`, means off. */
export function isMthdsDisableOn(value: string | undefined): boolean {
  const normalized = normalizedValue(value);
  return (
    normalized !== undefined &&
    (SWITCH_VALUES.mthdsDisableOn as readonly string[]).includes(normalized)
  );
}

/** Whether the process runs in continuous integration, by the contract's list of variables. */
export function isCi(env: NodeJS.ProcessEnv = process.env): boolean {
  return CI_VARIABLES.some((name) => isSetAndNotFalsy(env[name]));
}

/** Whether the process runs in a container, by the contract's files, variables and cgroup words. */
export function isContainer(env: NodeJS.ProcessEnv = process.env): boolean {
  if (CONTAINER_MARKERS.files.some((path) => existsSync(path))) return true;
  if (CONTAINER_MARKERS.environment.some((name) => (env[name] ?? "") !== "")) return true;
  let cgroup: string;
  try {
    cgroup = readFileSync("/proc/1/cgroup", "utf-8");
  } catch {
    return false;
  }
  return CONTAINER_MARKERS.cgroupWords.some((word) => cgroup.includes(word));
}

export function osFamily(platform: NodeJS.Platform = process.platform): string {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "darwin";
  if (platform === "win32") return "windows";
  return "other";
}

export function archFamily(arch: string = process.arch): string {
  if (arch === "x64") return "x86_64";
  if (arch === "arm64") return "arm64";
  return "other";
}

/** `node-<major>`, the `language_runtime` of a tool running on Node. */
export function languageRuntime(version: string = process.versions.node): string {
  return `node-${version.split(".")[0]}`;
}
