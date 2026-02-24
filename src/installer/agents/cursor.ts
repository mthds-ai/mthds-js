import type { AgentHandler, InstallContext } from "./types.js";
import { Agent } from "./types.js";

export const cursorHandler: AgentHandler = {
  id: Agent.Cursor,
  label: "Cursor",
  supported: false,
  hint: "coming soon",

  async installMethod(_ctx: InstallContext): Promise<void> {
    throw new Error("Cursor is not supported yet.");
  },
};
