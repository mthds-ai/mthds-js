import type { AgentHandler, InstallContext } from "./types.js";
import { Agent } from "./types.js";

export const githubCopilotHandler: AgentHandler = {
  id: Agent.GithubCopilot,
  label: "GitHub Copilot",
  supported: false,
  hint: "coming soon",

  async installMethod(_ctx: InstallContext): Promise<void> {
    throw new Error("GitHub Copilot is not supported yet.");
  },
};
