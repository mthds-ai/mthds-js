import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import {
  setTelemetryEnabled,
  getTelemetryStatus,
} from "../telemetry/posthog.js";

export async function telemetryDisable(): Promise<void> {
  setTelemetryEnabled(false);
  printLogo();
  p.intro("mthds telemetry");
  p.log.success("Telemetry disabled.");
  p.outro("");
}

export async function telemetryEnable(): Promise<void> {
  setTelemetryEnabled(true);
  printLogo();
  p.intro("mthds telemetry");
  p.log.success("Telemetry enabled.");
  p.outro("");
}

export async function telemetryStatus(): Promise<void> {
  const { enabled, source } = getTelemetryStatus();
  printLogo();
  p.intro("mthds telemetry");

  const state = enabled ? "enabled" : "disabled";
  p.log.info(`Telemetry is ${state} (${source})`);

  if (source === "env") {
    p.log.message(
      "Override: DISABLE_TELEMETRY=1 environment variable is set."
    );
  } else if (source === "env.local") {
    p.log.message(
      "Override: DISABLE_TELEMETRY=1 found in ~/.mthds/.env.local"
    );
  } else if (source === "config") {
    p.log.message(
      "Set via: mthds telemetry enable / mthds telemetry disable"
    );
  } else {
    p.log.message(
      "Disable with: mthds telemetry disable"
    );
  }

  p.outro("");
}
