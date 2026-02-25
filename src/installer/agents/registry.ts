import { join, resolve, dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Agent, AgentHandler, InstallMethodOptions } from "./types.js";

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
  }
}

const defaultHandler: (id: Agent) => AgentHandler = (id) => ({
  id,
  async installMethod(options: InstallMethodOptions): Promise<void> {
    writeMethodFiles(options);
  },
});

const handlers: Record<Agent, AgentHandler> = {
  claude: defaultHandler("claude"),
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
