import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("../../../src/installer/runtime/check.js", () => ({
  isBinaryInstalled: vi.fn(),
}));

vi.mock("../../../src/config/config.js", () => ({
  listConfig: vi.fn(() => []),
}));

// Capture what agentSuccess receives
let capturedResult: Record<string, unknown> | undefined;
vi.mock("../../../src/agent/output.js", () => ({
  agentSuccess: vi.fn((result: Record<string, unknown>) => {
    capturedResult = result;
  }),
}));

import { execFileSync } from "node:child_process";
import { isBinaryInstalled } from "../../../src/installer/runtime/check.js";
import { listConfig } from "../../../src/config/config.js";
import { agentDoctor } from "../../../src/agent/commands/doctor.js";

const mockedIsBinaryInstalled = vi.mocked(isBinaryInstalled);
const mockedExecFileSync = vi.mocked(execFileSync);
const mockedListConfig = vi.mocked(listConfig);

interface Issue {
  severity: string;
  message: string;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedResult = undefined;
});

describe("agentDoctor", () => {
  it("reports healthy when all binaries are installed", async () => {
    mockedIsBinaryInstalled.mockReturnValue(true);
    mockedExecFileSync.mockReturnValue(Buffer.from("1.0.0"));
    mockedListConfig.mockReturnValue([]);

    await agentDoctor();

    expect(capturedResult).toBeDefined();
    expect(capturedResult!.healthy).toBe(true);
    expect(capturedResult!.issues).toEqual([]);
  });

  it("reports missing binaries as warnings, not errors", async () => {
    mockedIsBinaryInstalled.mockReturnValue(false);
    mockedListConfig.mockReturnValue([]);

    await agentDoctor();

    expect(capturedResult).toBeDefined();
    const issues = capturedResult!.issues as Issue[];
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.severity).toBe("warning");
    }
    // No errors → still healthy
    expect(capturedResult!.healthy).toBe(true);
  });

  it("reports error when runner=pipelex and pipelex-agent is missing", async () => {
    mockedIsBinaryInstalled.mockReturnValue(false);
    mockedListConfig.mockReturnValue([
      { cliKey: "runner", envKey: "MTHDS_RUNNER", value: "pipelex", source: "default" },
    ]);

    await agentDoctor();

    expect(capturedResult).toBeDefined();
    const issues = capturedResult!.issues as Issue[];
    const errorIssue = issues.find((i) => i.severity === "error");
    expect(errorIssue).toBeDefined();
    expect(errorIssue!.message).toContain("pipelex-agent");
    expect(capturedResult!.healthy).toBe(false);
  });

  it("stays healthy when runner=api and pipelex-agent is missing", async () => {
    mockedIsBinaryInstalled.mockReturnValue(false);
    mockedListConfig.mockReturnValue([
      { cliKey: "runner", envKey: "MTHDS_RUNNER", value: "api", source: "default" },
    ]);

    await agentDoctor();

    expect(capturedResult).toBeDefined();
    // Only warnings from the initial loop, no errors
    const issues = capturedResult!.issues as Issue[];
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
    expect(capturedResult!.healthy).toBe(true);
  });

  it("warns when runner=api and no API key configured", async () => {
    mockedIsBinaryInstalled.mockReturnValue(true);
    mockedExecFileSync.mockReturnValue(Buffer.from("1.0.0"));
    mockedListConfig.mockReturnValue([
      { cliKey: "runner", envKey: "MTHDS_RUNNER", value: "api", source: "default" },
      { cliKey: "api-key", envKey: "MTHDS_API_KEY", value: "", source: "default" },
    ]);

    await agentDoctor();

    expect(capturedResult).toBeDefined();
    const issues = capturedResult!.issues as Issue[];
    const warning = issues.find((i) => i.message.includes("API key"));
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe("warning");
  });
});
