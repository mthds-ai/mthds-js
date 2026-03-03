import { spawn } from "node:child_process";
import * as p from "@clack/prompts";
import { isPipelexInstalled } from "../../installer/runtime/check.js";
import { ensureRuntime } from "../../installer/runtime/installer.js";
import { printLogo } from "./index.js";

export async function login(): Promise<void> {
  printLogo();
  p.intro("mthds login");

  if (!isPipelexInstalled()) {
    p.log.step("pipelex is not installed. Installing...");
    await ensureRuntime();

    if (!isPipelexInstalled()) {
      p.log.error(
        "pipelex was installed but is not reachable. Make sure the uv tools bin directory is in your PATH."
      );
      process.exit(1);
    }

    p.log.success("pipelex installed successfully.");
  }

  p.log.step("Running pipelex login...");

  await new Promise<void>((resolve, reject) => {
    const child = spawn("pipelex", ["login", "--no-logo"], {
      stdio: "inherit",
    });
    child.on("error", (err) =>
      reject(new Error(`pipelex not found: ${err.message}`))
    );
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`pipelex login exited with code ${code}`));
      }
    });
  });

  p.outro("Done");
}
