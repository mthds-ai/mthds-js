/**
 * `mthds telemetry`: the usage-statistics command group of the `mthds` CLI. `mthds-agent` has none
 * of its own and follows the same state. It reads and writes the state every reporting tool on the
 * machine shares, so a choice made here holds for pipelex, plxt and the VS Code extension too, and
 * theirs holds here.
 *
 * The group's own commands never send an event, queue one or print the notice.
 */

import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import { TOOL } from "../../usage-stats/contract.js";
import type { OffByToken } from "../../usage-stats/contract.js";
import { isCi, isContainer } from "../../usage-stats/environment.js";
import {
  createDisabledFile,
  deleteEverySpool,
  isInternalMachine,
  markLegacyMigrated,
  noticeVersionSeen,
  readInstallationId,
  removeDisabledFile,
  replaceInstallationId,
  stateDir,
} from "../../usage-stats/state.js";
import { usageStatsOffBy } from "../../usage-stats/switches.js";

/** The answer of `mthds telemetry status --format json`, as the contract defines it. */
export interface UsageStatsStatus {
  tool: string;
  enabled: boolean;
  off_by: OffByToken[];
  installation_id: string | null;
  notice_version: number;
  internal: boolean;
  ci: boolean;
  container: boolean;
  state_dir: string;
}

/** What each switch is, in words, for the person reading `status` or `enable`. */
const SWITCH_DESCRIPTIONS: Record<OffByToken, string> = {
  do_not_track: "DO_NOT_TRACK is set in your environment",
  tool_variable: "PIPELEX_USAGE_STATS or DISABLE_TELEMETRY in your environment says off",
  machine_choice:
    "they are turned off on this machine, by `mthds telemetry disable` or another tool's disable command",
  legacy_mthds_choice: "DISABLE_TELEMETRY in ~/.mthds/config says off",
  project_setting:
    "this project's .pipelex/pipelex.toml sets [usage_stats] enabled = false, or cannot be read",
  invalid_endpoint_override:
    "PIPELEX_USAGE_STATS_ENDPOINT is set to something other than a loopback http origin",
};

/** Read-only: it creates nothing, migrates nothing and prints no notice. */
export function readUsageStatsStatus(): UsageStatsStatus {
  const offBy = usageStatsOffBy();
  const id = readInstallationId();
  return {
    tool: TOOL,
    enabled: offBy.length === 0,
    off_by: offBy,
    installation_id: id.kind === "valid" ? id.id : null,
    notice_version: noticeVersionSeen(),
    internal: isInternalMachine(),
    ci: isCi(),
    container: isContainer(),
    state_dir: stateDir(),
  };
}

function fail(message: string): never {
  p.log.error(message);
  p.outro("");
  process.exit(1);
}

export function telemetryStatus(options: { format?: string } = {}): void {
  const status = readUsageStatsStatus();
  if (options.format === "json") {
    process.stdout.write(JSON.stringify(status, null, 2) + "\n");
    return;
  }
  printLogo();
  p.intro("mthds telemetry");
  if (status.enabled) {
    p.log.info("Anonymous usage statistics are on.");
  } else {
    const reasons = status.off_by.map((token) => `  - ${SWITCH_DESCRIPTIONS[token]}`).join("\n");
    p.log.info(`Anonymous usage statistics are off:\n${reasons}`);
  }
  p.log.info(
    [
      `Installation identifier: ${status.installation_id ?? "none"}`,
      `Notice shown: ${status.notice_version > 0 ? `version ${status.notice_version}` : "not yet"}`,
      `State directory: ${status.state_dir}`,
    ].join("\n"),
  );
  p.outro("");
}

export function telemetryEnable(): void {
  printLogo();
  p.intro("mthds telemetry");
  try {
    removeDisabledFile();
    markLegacyMigrated();
  } catch (err) {
    fail(`Could not turn usage statistics on: ${(err as Error).message}`);
  }
  const stillOff = usageStatsOffBy();
  if (stillOff.length > 0) {
    const reasons = stillOff.map((token) => `  - ${SWITCH_DESCRIPTIONS[token]}`).join("\n");
    p.log.warn(`Turned on for this machine, but they stay off:\n${reasons}`);
  } else {
    p.log.success("Anonymous usage statistics are on.");
  }
  p.outro("");
}

export function telemetryDisable(): void {
  printLogo();
  p.intro("mthds telemetry");
  try {
    createDisabledFile();
    deleteEverySpool();
  } catch (err) {
    fail(`Could not turn usage statistics off: ${(err as Error).message}`);
  }
  p.log.success(
    "Anonymous usage statistics are off on this machine, for every Pipelex and MTHDS tool, and nothing queued will be sent.",
  );
  p.outro("");
}

export function telemetryResetId(): void {
  printLogo();
  p.intro("mthds telemetry");
  let id: string;
  try {
    deleteEverySpool();
    id = replaceInstallationId();
  } catch (err) {
    fail(`Could not replace the installation identifier: ${(err as Error).message}`);
  }
  p.log.success(`New installation identifier: ${id}`);
  p.outro("");
}
