import type { Agent, AgentHandler } from "./types.js";
import { claudeCodeHandler } from "./claude-code.js";
import { cursorHandler } from "./cursor.js";
import { windsurfHandler } from "./windsurf.js";
import { githubCopilotHandler } from "./github-copilot.js";

const handlers: ReadonlyMap<Agent, AgentHandler> = new Map([
  [claudeCodeHandler.id, claudeCodeHandler],
  [cursorHandler.id, cursorHandler],
  [windsurfHandler.id, windsurfHandler],
  [githubCopilotHandler.id, githubCopilotHandler],
]);

export function getAgentHandler(agent: Agent): AgentHandler {
  const handler = handlers.get(agent);
  if (!handler) {
    throw new Error(`No handler registered for agent: ${agent}`);
  }
  return handler;
}

export function getAllAgents(): readonly AgentHandler[] {
  return [...handlers.values()];
}

export function getSupportedAgents(): readonly AgentHandler[] {
  return getAllAgents().filter((h) => h.supported);
}
