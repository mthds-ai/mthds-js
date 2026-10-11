import * as p from "@clack/prompts";
import { printLogo } from "./index.js";
import {
  isTelemetryEnabled,
  setTelemetryEnabled,
  getTelemetrySource,
  getTelemetryDisablingEnvVar,
} from "../../config/config.js";

export function telemetryEnable(): void {
  printLogo();
  p.intro("mthds telemetry");
  setTelemetryEnabled(true);
  const disablingEnvVar = getTelemetryDisablingEnvVar();
  if (disablingEnvVar) {
    p.log.warn(
      `Telemetry enabled in ~/.mthds/config, but ${disablingEnvVar} is set in your environment and keeps it off.`,
    );
  } else {
    p.log.success("Telemetry enabled.");
  }
  p.outro("");
}

export function telemetryDisable(): void {
  printLogo();
  p.intro("mthds telemetry");
  setTelemetryEnabled(false);
  p.log.success("Telemetry disabled.");
  p.outro("");
}

/** The parenthesised source of `telemetry status`: what decided the setting. */
function telemetrySourceLabel(): string {
  const disablingEnvVar = getTelemetryDisablingEnvVar();
  if (disablingEnvVar) return ` (by ${disablingEnvVar})`;
  const source = getTelemetrySource();
  if (source === "env") return " (from env)";
  if (source === "default") return " (default)";
  return "";
}

export function telemetryStatus(): void {
  printLogo();
  p.intro("mthds telemetry");
  const enabled = isTelemetryEnabled();
  p.log.info(`Telemetry is ${enabled ? "enabled" : "disabled"}${telemetrySourceLabel()}`);
  p.outro("");
}
