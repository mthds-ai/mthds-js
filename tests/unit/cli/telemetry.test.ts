import { beforeEach, describe, expect, it, vi } from "vitest";

// `mthds telemetry enable` and `status` name the environment variable holding
// telemetry off — DO_NOT_TRACK or DISABLE_TELEMETRY — rather than claiming
// telemetry is on, or leaving the person to guess why it is off.

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../src/cli/commands/index.js", () => ({ printLogo: vi.fn() }));

vi.mock("../../../src/config/config.js", () => ({
  isTelemetryEnabled: vi.fn(),
  setTelemetryEnabled: vi.fn(),
  getTelemetrySource: vi.fn(),
  getTelemetryDisablingEnvVar: vi.fn(),
}));

import * as p from "@clack/prompts";
import {
  isTelemetryEnabled,
  setTelemetryEnabled,
  getTelemetrySource,
  getTelemetryDisablingEnvVar,
} from "../../../src/config/config.js";
import {
  telemetryEnable,
  telemetryDisable,
  telemetryStatus,
} from "../../../src/cli/commands/telemetry.js";

const mockedIsTelemetryEnabled = vi.mocked(isTelemetryEnabled);
const mockedGetTelemetrySource = vi.mocked(getTelemetrySource);
const mockedGetTelemetryDisablingEnvVar = vi.mocked(getTelemetryDisablingEnvVar);

beforeEach(() => {
  vi.clearAllMocks();
  mockedIsTelemetryEnabled.mockReturnValue(true);
  mockedGetTelemetrySource.mockReturnValue("default");
  mockedGetTelemetryDisablingEnvVar.mockReturnValue(undefined);
});

describe("telemetryEnable", () => {
  it("writes the setting and reports success when nothing overrides it", () => {
    telemetryEnable();

    expect(setTelemetryEnabled).toHaveBeenCalledWith(true);
    expect(p.log.success).toHaveBeenCalledWith("Telemetry enabled.");
    expect(p.log.warn).not.toHaveBeenCalled();
  });

  it("warns, rather than reporting success, when DO_NOT_TRACK keeps telemetry off", () => {
    mockedGetTelemetryDisablingEnvVar.mockReturnValue("DO_NOT_TRACK");

    telemetryEnable();

    expect(setTelemetryEnabled).toHaveBeenCalledWith(true);
    expect(p.log.success).not.toHaveBeenCalled();
    expect(p.log.warn).toHaveBeenCalledWith(expect.stringContaining("DO_NOT_TRACK is set"));
  });
});

describe("telemetryDisable", () => {
  it("writes the setting and reports it", () => {
    telemetryDisable();

    expect(setTelemetryEnabled).toHaveBeenCalledWith(false);
    expect(p.log.success).toHaveBeenCalledWith("Telemetry disabled.");
  });
});

describe("telemetryStatus", () => {
  it("names the environment variable holding telemetry off", () => {
    mockedIsTelemetryEnabled.mockReturnValue(false);
    mockedGetTelemetrySource.mockReturnValue("env");
    mockedGetTelemetryDisablingEnvVar.mockReturnValue("DO_NOT_TRACK");

    telemetryStatus();

    expect(p.log.info).toHaveBeenCalledWith("Telemetry is disabled (by DO_NOT_TRACK)");
  });

  it.each([
    ["env", true, "Telemetry is enabled (from env)"],
    ["default", true, "Telemetry is enabled (default)"],
    ["file", false, "Telemetry is disabled"],
  ] as const)("reports a %s source", (source, enabled, line) => {
    mockedIsTelemetryEnabled.mockReturnValue(enabled);
    mockedGetTelemetrySource.mockReturnValue(source);

    telemetryStatus();

    expect(p.log.info).toHaveBeenCalledWith(line);
  });
});
