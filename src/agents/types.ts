export const Agent = {
  ClaudeCode: "claude-code",
  Cursor: "cursor",
  Windsurf: "windsurf",
  GithubCopilot: "github-copilot",
} as const;

export type Agent = (typeof Agent)[keyof typeof Agent];

export const InstallLocation = {
  Local: "local",
  Global: "global",
} as const;

export type InstallLocation =
  (typeof InstallLocation)[keyof typeof InstallLocation];

export interface InstallContext {
  readonly repo: import("../resolver/types.js").ResolvedRepo;
  readonly agent: Agent;
  readonly location: InstallLocation;
  readonly targetDir: string;
}

export interface AgentHandler {
  readonly id: Agent;
  readonly label: string;
  readonly supported: boolean;
  readonly hint?: string;
  installMethod(ctx: InstallContext): Promise<void>;
}
