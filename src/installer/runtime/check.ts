import { execFileSync } from "node:child_process";

export function isBinaryInstalled(bin: string): boolean {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function isPipelexInstalled(): boolean {
  return isBinaryInstalled("pipelex");
}

export function isPlxtInstalled(): boolean {
  return isBinaryInstalled("plxt");
}
