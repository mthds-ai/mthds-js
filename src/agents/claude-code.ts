import { join } from "node:path";
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
    s.start(`Installing method "${ctx.method}" for Claude Code...`);

    // TODO: When multi-agent support ships, offer symlink vs copy strategy.
    // Symlink: store method once in a canonical location, symlink from each agent's dir.
    // Copy: independent copies per agent. Fallback when symlinks aren't supported.
    const methodDir = join(ctx.targetDir, ctx.method);
    mkdirSync(methodDir, { recursive: true });

    writeFileSync(
      join(methodDir, "METHOD.mthds"),
      ctx.content,
      "utf-8"
    );

    s.stop(`Method "${ctx.method}" installed to ${methodDir}`);
  },
};
