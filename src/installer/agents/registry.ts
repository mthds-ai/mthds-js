import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Agent, AgentHandler, InstallMethodOptions } from "./types.js";

/**
 * Generate an executable CLI shim for a method in ~/.mthds/bin/.
 *
 * The shim allows invoking a method directly by slug, e.g.:
 *   extract-contract-terms --inputs '{"text": "..."}'
 *
 * On Windows, a .cmd shim is also generated.
 */
export function generateShim(slug: string, installDir: string): void {
  const binDir = join(homedir(), ".mthds", "bin");
  mkdirSync(binDir, { recursive: true });

  const shimPath = join(binDir, slug);
  const shimContent = [
    "#!/bin/sh",
    `exec pipelex-agent run pipe "$@" -L ${JSON.stringify(installDir)}`,
    "",
  ].join("\n");

  writeFileSync(shimPath, shimContent, { mode: 0o755 });

  // On Windows, also generate a .cmd shim
  if (process.platform === "win32") {
    const cmdPath = join(binDir, `${slug}.cmd`);
    const cmdContent = [
      "@echo off",
      `pipelex-agent run pipe %* -L ${JSON.stringify(installDir)}`,
      "",
    ].join("\r\n");
    writeFileSync(cmdPath, cmdContent, "utf-8");
  }
}

function writeMethodFiles(options: InstallMethodOptions): void {
  const { repo, targetDir } = options;
  mkdirSync(targetDir, { recursive: true });

  for (const method of repo.methods) {
    const installDir = resolve(join(targetDir, method.slug));
    mkdirSync(installDir, { recursive: true });

    writeFileSync(join(installDir, "METHODS.toml"), method.rawManifest, "utf-8");

    for (const file of method.files) {
      const filePath = resolve(join(installDir, file.relativePath));
      if (!filePath.startsWith(installDir + "/")) {
        throw new Error(`Path traversal detected: "${file.relativePath}" escapes install directory.`);
      }
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, file.content, "utf-8");
    }

    generateShim(method.slug, installDir);
  }
}

const defaultHandler: (id: Agent) => AgentHandler = (id) => ({
  id,
  async installMethod(options: InstallMethodOptions): Promise<void> {
    writeMethodFiles(options);
  },
});

const handlers: Record<Agent, AgentHandler> = {
  "claude-code": defaultHandler("claude-code"),
  cursor: defaultHandler("cursor"),
  codex: defaultHandler("codex"),
};

export function getAllAgents(): AgentHandler[] {
  return Object.values(handlers);
}

export function getAgentHandler(agent: Agent): AgentHandler {
  const handler = handlers[agent];
  if (!handler) {
    throw new Error(`Unknown agent: ${agent}`);
  }
  return handler;
}
