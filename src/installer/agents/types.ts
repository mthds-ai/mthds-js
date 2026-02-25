import type { ResolvedRepo } from "../../package/manifest/types.js";

export type Agent = "claude" | "cursor" | "codex";

export enum InstallLocation {
  Local = "local",
  Global = "global",
}

export interface InstallMethodOptions {
  readonly repo: ResolvedRepo;
  readonly agent: Agent;
  readonly location: InstallLocation;
  readonly targetDir: string;
}

export interface AgentHandler {
  readonly id: Agent;
  installMethod(options: InstallMethodOptions): Promise<void>;
}
