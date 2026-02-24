import { join, dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import * as p from "@clack/prompts";
import type { AgentHandler, InstallContext } from "./types.js";
import { Agent } from "./types.js";

export const claudeCodeHandler: AgentHandler = {
  id: Agent.ClaudeCode,
  label: "Claude Code",
  supported: true,

  async installMethod(ctx: InstallContext): Promise<void> {
    const s = p.spinner();
    const { repo } = ctx;

    for (const method of repo.methods) {
      const installDir = resolve(join(ctx.targetDir, repo.repoName, method.slug));

      s.start(`Installing "${method.slug}" to ${installDir}...`);

      // Create the install directory
      mkdirSync(installDir, { recursive: true });

      // Write METHODS.toml (verbatim raw string)
      writeFileSync(join(installDir, "METHODS.toml"), method.rawManifest, "utf-8");

      // Write all .mthds files, preserving directory structure
      for (const file of method.files) {
        const filePath = resolve(join(installDir, file.relativePath));
        if (!filePath.startsWith(installDir + "/")) {
          throw new Error(`Path traversal detected: "${file.relativePath}" escapes install directory.`);
        }
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, file.content, "utf-8");
      }

      const fileCount = method.files.length;
      const filesMsg = fileCount === 0
        ? "(manifest only)"
        : `(${fileCount} .mthds file${fileCount > 1 ? "s" : ""})`;

      s.stop(`Installed "${method.slug}" to ${installDir} ${filesMsg}`);
    }
  },
};
