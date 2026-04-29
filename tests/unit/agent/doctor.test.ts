import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("../../../src/installer/runtime/version-check.js", () => ({
  checkBinaryVersion: vi.fn(),
}));

vi.mock("../../../src/config/config.js", () => ({
  listConfig: vi.fn(() => []),
}));

// Doctor calls inspectCodexConfig for the Codex section. The existing
// doctor tests pre-date that section and assume `issues` only contains
// binary/runner findings. Stub it to a clean state so those expectations
// hold; the codex-specific behavior is covered by codex-config.test.ts and
// has its own dedicated case below.
vi.mock("../../../src/agent/commands/codex-config.js", () => ({
  inspectCodexConfig: vi.fn(() => ({
    config_file: "/tmp/.codex/config.toml",
    exists: true,
    needs_change: null,
    warnings: [],
  })),
}));

// Capture what agentSuccess receives
let capturedResult: Record<string, unknown> | undefined;
vi.mock("../../../src/agent/output.js", () => ({
  agentSuccess: vi.fn((result: Record<string, unknown>) => {
    capturedResult = result;
  }),
}));

import { execFileSync } from "node:child_process";
import { checkBinaryVersion } from "../../../src/installer/runtime/version-check.js";
import { listConfig } from "../../../src/config/config.js";
import { agentDoctor, OutputFormat } from "../../../src/agent/commands/doctor.js";
import { BINARY_RECOVERY } from "../../../src/agent/binaries.js";

const PX_CONSTRAINT = BINARY_RECOVERY["pipelex"].version_constraint;

const mockedCheckBinaryVersion = vi.mocked(checkBinaryVersion);
const mockedExecFileSync = vi.mocked(execFileSync);
const mockedListConfig = vi.mocked(listConfig);

interface DependencyCheck {
  binary: string;
  installed: boolean;
  version: string | null;
  version_ok: boolean;
  version_constraint: string;
  path: string | null;
  install_command: string;
  install_url: string;
}

interface Issue {
  severity: string;
  message: string;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedResult = undefined;
});

describe("agentDoctor", () => {
  it("reports healthy with version_ok when all binaries satisfy constraints", async () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "ok",
      installed_version: "0.22.0",
      version_constraint: PX_CONSTRAINT,
    });
    // getBinaryPath uses execFileSync (which)
    mockedExecFileSync.mockReturnValue(Buffer.from("/usr/local/bin/pipelex"));
    mockedListConfig.mockReturnValue([]);

    await agentDoctor(OutputFormat.JSON);

    expect(capturedResult).toBeDefined();
    expect(capturedResult!.healthy).toBe(true);
    expect(capturedResult!.issues).toEqual([]);

    const deps = capturedResult!.dependencies as DependencyCheck[];
    for (const dep of deps) {
      expect(dep.version_ok).toBe(true);
      expect(dep.version_constraint).toBeDefined();
      expect(dep.installed).toBe(true);
    }
  });

  it("reports outdated binaries as warnings with version details", async () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "outdated",
      installed_version: "0.20.0",
      version_constraint: PX_CONSTRAINT,
    });
    mockedExecFileSync.mockReturnValue(Buffer.from("/usr/local/bin/pipelex"));
    mockedListConfig.mockReturnValue([]);

    await agentDoctor(OutputFormat.JSON);

    expect(capturedResult).toBeDefined();
    const issues = capturedResult!.issues as Issue[];
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.severity).toBe("warning"); // NOT error — must not conflict with snooze
      expect(issue.message).toContain("outdated");
    }
    // Outdated is a warning, not an error → still healthy
    expect(capturedResult!.healthy).toBe(true);

    const deps = capturedResult!.dependencies as DependencyCheck[];
    for (const dep of deps) {
      expect(dep.version_ok).toBe(false);
      expect(dep.version).toBe("0.20.0");
    }
  });

  it("reports missing binaries as warnings, not errors", async () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "missing",
      installed_version: null,
      version_constraint: PX_CONSTRAINT,
    });
    mockedListConfig.mockReturnValue([]);

    await agentDoctor(OutputFormat.JSON);

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
    mockedCheckBinaryVersion.mockReturnValue({
      status: "missing",
      installed_version: null,
      version_constraint: PX_CONSTRAINT,
    });
    mockedListConfig.mockReturnValue([
      { cliKey: "runner", envKey: "MTHDS_RUNNER", value: "pipelex", source: "default" },
    ]);

    await agentDoctor(OutputFormat.JSON);

    expect(capturedResult).toBeDefined();
    const issues = capturedResult!.issues as Issue[];
    const errorIssue = issues.find((issue) => issue.severity === "error");
    expect(errorIssue).toBeDefined();
    expect(errorIssue!.message).toContain("pipelex-agent");
    // Ensure no duplicate: only the error, no extra warning for pipelex-agent
    const pipelexAgentIssues = issues.filter((issue) => issue.message.includes("pipelex-agent"));
    expect(pipelexAgentIssues).toHaveLength(1);
    expect(capturedResult!.healthy).toBe(false);
  });

  it("stays healthy when runner=api and pipelex-agent is missing", async () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "missing",
      installed_version: null,
      version_constraint: PX_CONSTRAINT,
    });
    mockedListConfig.mockReturnValue([
      { cliKey: "runner", envKey: "MTHDS_RUNNER", value: "api", source: "default" },
    ]);

    await agentDoctor(OutputFormat.JSON);

    expect(capturedResult).toBeDefined();
    const issues = capturedResult!.issues as Issue[];
    const errors = issues.filter((issue) => issue.severity === "error");
    expect(errors).toEqual([]);
    expect(capturedResult!.healthy).toBe(true);
  });

  it("warns when runner=api and no API key configured", async () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "ok",
      installed_version: "0.22.0",
      version_constraint: PX_CONSTRAINT,
    });
    mockedExecFileSync.mockReturnValue(Buffer.from("/usr/local/bin/pipelex"));
    mockedListConfig.mockReturnValue([
      { cliKey: "runner", envKey: "MTHDS_RUNNER", value: "api", source: "default" },
      { cliKey: "api-key", envKey: "MTHDS_API_KEY", value: "", source: "default" },
    ]);

    await agentDoctor(OutputFormat.JSON);

    expect(capturedResult).toBeDefined();
    const issues = capturedResult!.issues as Issue[];
    const warning = issues.find((issue) => issue.message.includes("API key"));
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe("warning");
  });

  it("reports unparseable versions as warnings", async () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "unparseable",
      installed_version: null,
      version_constraint: PX_CONSTRAINT,
    });
    mockedExecFileSync.mockReturnValue(Buffer.from("/usr/local/bin/pipelex"));
    mockedListConfig.mockReturnValue([]);

    await agentDoctor(OutputFormat.JSON);

    expect(capturedResult).toBeDefined();
    const issues = capturedResult!.issues as Issue[];
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.severity).toBe("warning");
      expect(issue.message).toContain("parse version");
    }
    expect(capturedResult!.healthy).toBe(true);
  });

  it("outputs markdown by default", async () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "ok",
      installed_version: "0.22.0",
      version_constraint: PX_CONSTRAINT,
    });
    mockedExecFileSync.mockReturnValue(Buffer.from("/usr/local/bin/pipelex"));
    mockedListConfig.mockReturnValue([
      { cliKey: "runner", envKey: "MTHDS_RUNNER", value: "pipelex", source: "config file" },
    ]);

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await agentDoctor();

    expect(writeSpy).toHaveBeenCalledOnce();
    const output = writeSpy.mock.calls[0]![0] as string;
    expect(output).toContain("# Doctor Report");
    expect(output).toContain("**Status:** healthy");
    expect(output).toContain("## Dependencies");
    expect(output).toContain("## Configuration");
    expect(output).toContain("pipelex");
    // agentSuccess should NOT have been called
    expect(capturedResult).toBeUndefined();

    writeSpy.mockRestore();
  });

  it("markdown includes issues section when there are problems", async () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "missing",
      installed_version: null,
      version_constraint: PX_CONSTRAINT,
    });
    mockedListConfig.mockReturnValue([]);

    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await agentDoctor(OutputFormat.MARKDOWN);

    const output = writeSpy.mock.calls[0]![0] as string;
    expect(output).toContain("## Issues");
    expect(output).toContain("[WARN]");
    expect(output).toContain("not installed");

    writeSpy.mockRestore();
  });

  it("surfaces Codex sandbox network issue when inspectCodexConfig flags it", async () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "ok",
      installed_version: "0.22.0",
      version_constraint: PX_CONSTRAINT,
    });
    mockedExecFileSync.mockReturnValue(Buffer.from("/usr/local/bin/pipelex"));
    mockedListConfig.mockReturnValue([]);

    const codexConfig = await import("../../../src/agent/commands/codex-config.js");
    vi.mocked(codexConfig.inspectCodexConfig).mockReturnValueOnce({
      config_file: "/tmp/.codex/config.toml",
      exists: true,
      needs_change: { table: "sandbox_workspace_write", key: "network_access", value: "true" },
      warnings: [{ code: "CODEX_HOOKS_DISABLED", message: "codex_hooks is false" }],
    });

    await agentDoctor(OutputFormat.JSON);

    const issues = capturedResult!.issues as Issue[];
    expect(issues.some((i) => i.message.includes("Codex sandbox network"))).toBe(true);
    expect(issues.some((i) => i.message.includes("codex_hooks is false"))).toBe(true);

    const codex = capturedResult!.codex as { needs_change: unknown };
    expect(codex.needs_change).toEqual({
      table: "sandbox_workspace_write",
      key: "network_access",
      value: "true",
    });
  });

  it("includes install_command using uv tool install format", async () => {
    mockedCheckBinaryVersion.mockReturnValue({
      status: "ok",
      installed_version: "0.22.0",
      version_constraint: PX_CONSTRAINT,
    });
    mockedExecFileSync.mockReturnValue(Buffer.from("/usr/local/bin/pipelex"));
    mockedListConfig.mockReturnValue([]);

    await agentDoctor(OutputFormat.JSON);

    const deps = capturedResult!.dependencies as DependencyCheck[];
    for (const dep of deps) {
      expect(dep.install_command).toContain("uv tool install");
    }
  });
});
