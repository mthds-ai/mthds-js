import { spawn } from "node:child_process";

export function spawnPipelex(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("pipelex", args, {
      stdio: "inherit",
      shell: false,
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to start pipelex: ${err.message}`));
    });

    child.on("close", (code) => {
      resolve(code ?? 1);
    });
  });
}
