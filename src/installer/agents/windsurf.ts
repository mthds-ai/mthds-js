import type { AgentHandler, InstallContext } from "./types.js";
import { Agent } from "./types.js";

export const windsurfHandler: AgentHandler = {
  id: Agent.Windsurf,
  label: "Windsurf",
  supported: false,
  hint: "coming soon",

  async installMethod(_ctx: InstallContext): Promise<void> {
    throw new Error("Windsurf is not supported yet.");
  },
};
