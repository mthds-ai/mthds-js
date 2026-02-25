import { execFileSync } from "node:child_process";

export function isPipelexInstalled(): boolean {
  try {
    execFileSync("pipelex", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
