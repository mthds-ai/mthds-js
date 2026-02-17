import { execFileSync } from "node:child_process";

export function isUvInstalled(): boolean {
  try {
    execFileSync("uv", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function isPipelexInstalled(): boolean {
  try {
    const output = execFileSync("uv", ["tool", "list"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.includes("pipelex");
  } catch {
    return false;
  }
}
