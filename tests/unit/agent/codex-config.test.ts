import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

// ── Mock homedir so all filesystem writes land in a scratch dir ─────

let scratchHome: string;

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => scratchHome,
  };
});

// ── Mock agent output to capture results without writing to stdout ──

class AgentErrorThrow extends Error {
  constructor(
    public errorType: string,
    public extras?: Record<string, unknown>,
  ) {
    super(errorType);
  }
}

const successSpy = vi.fn();
const errorSpy = vi.fn(
  (message: string, errorType: string, extras?: Record<string, unknown>) => {
    throw new AgentErrorThrow(errorType, { message, ...extras });
  },
);

vi.mock("../../../src/agent/output.js", () => ({
  agentSuccess: (result: Record<string, unknown>) => successSpy(result),
  agentError: (message: string, errorType: string, extras?: Record<string, unknown>) =>
    errorSpy(message, errorType, extras),
  AGENT_ERROR_DOMAINS: {
    CONFIG: "config",
    IO: "io",
  },
}));

let agentCodexApplyConfig: (opts?: { check?: boolean; dryRun?: boolean }) => Promise<void>;

describe("agentCodexApplyConfig", () => {
  beforeEach(async () => {
    scratchHome = mkdtempSync(join(tmpdir(), "mthds-codex-config-test-"));
    successSpy.mockClear();
    errorSpy.mockClear();
    vi.resetModules();
    const mod = await import("../../../src/agent/commands/codex-config.js");
    agentCodexApplyConfig = mod.agentCodexApplyConfig;
  });

  afterEach(() => {
    rmSync(scratchHome, { recursive: true, force: true });
  });

  const configFile = () => join(scratchHome, ".codex", "config.toml");

  function writeConfig(contents: string) {
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(configFile(), contents, "utf8");
  }

  function readConfig(): string {
    return readFileSync(configFile(), "utf8");
  }

  // ── Apply paths ────────────────────────────────────────────────────

  it("creates config.toml with sandbox_workspace_write.network_access when none exists", async () => {
    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith({
      status: "APPLIED",
      config_file: configFile(),
      applied: [{ table: "sandbox_workspace_write", key: "network_access", value: "true" }],
      warnings: [],
    });
    const parsed = parseToml(readConfig()) as Record<string, Record<string, unknown>>;
    expect(parsed.sandbox_workspace_write?.network_access).toBe(true);
  });

  it("appends a new [sandbox_workspace_write] table when config exists with other tables", async () => {
    writeConfig(`# top comment
sandbox_mode = "workspace-write"

[features]
codex_hooks = true
`);

    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "APPLIED" }),
    );
    const raw = readConfig();
    // Existing comments and tables preserved verbatim
    expect(raw).toContain("# top comment");
    expect(raw).toContain('sandbox_mode = "workspace-write"');
    expect(raw).toContain("[features]");
    // New table appended
    expect(raw).toContain("[sandbox_workspace_write]");
    expect(raw).toContain("network_access = true");

    const parsed = parseToml(raw) as Record<string, Record<string, unknown>>;
    expect(parsed.sandbox_workspace_write.network_access).toBe(true);
    expect(parsed.features?.codex_hooks).toBe(true);
  });

  it("treats [[array_of_tables]] headers as section boundaries when inserting", async () => {
    // Regression: a sloppy boundary regex would step past `[[history]]`
    // and insert network_access into the wrong (or nonexistent) section.
    writeConfig(`[sandbox_workspace_write]
writable_roots = ["/tmp"]

[[history]]
path = "log1"

[[history]]
path = "log2"
`);

    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    const parsed = parseToml(readConfig()) as Record<string, unknown>;
    const sww = parsed.sandbox_workspace_write as Record<string, unknown>;
    expect(sww.network_access).toBe(true);
    expect(sww.writable_roots).toEqual(["/tmp"]);
    const history = parsed.history as Array<Record<string, unknown>>;
    expect(history).toHaveLength(2);
    expect(history[0].path).toBe("log1");
    expect(history[1].path).toBe("log2");
    // Critically: the array-of-tables entries must not have grown a
    // network_access key.
    expect(history[0].network_access).toBeUndefined();
    expect(history[1].network_access).toBeUndefined();
  });

  it("inserts network_access into an existing [sandbox_workspace_write] table preserving other keys", async () => {
    writeConfig(`[sandbox_workspace_write]
writable_roots = ["/tmp"]

[features]
codex_hooks = true
`);

    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "APPLIED" }),
    );
    const parsed = parseToml(readConfig()) as Record<string, Record<string, unknown>>;
    expect(parsed.sandbox_workspace_write.network_access).toBe(true);
    expect(parsed.sandbox_workspace_write.writable_roots).toEqual(["/tmp"]);
    expect(parsed.features?.codex_hooks).toBe(true);
  });

  // ── Idempotence ────────────────────────────────────────────────────

  it("reports ALREADY_OK when the required key is already set", async () => {
    writeConfig(`[sandbox_workspace_write]
network_access = true
`);

    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith({
      status: "ALREADY_OK",
      config_file: configFile(),
      warnings: [],
    });
  });

  it("is idempotent — second run after apply is a no-op", async () => {
    await agentCodexApplyConfig();
    const after1 = readConfig();
    successSpy.mockClear();

    await agentCodexApplyConfig();

    expect(successSpy).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ALREADY_OK" }),
    );
    expect(readConfig()).toBe(after1);
  });

  // ── Warnings (warn-only, never modify) ─────────────────────────────

  it("warns when [features] codex_hooks is explicitly false but does not modify it", async () => {
    writeConfig(`[features]
codex_hooks = false
`);

    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    const call = successSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(call.status).toBe("APPLIED");
    const warnings = call.warnings as Array<{ code: string }>;
    expect(warnings.some((w) => w.code === "CODEX_HOOKS_DISABLED")).toBe(true);

    // Did NOT touch the codex_hooks key
    const parsed = parseToml(readConfig()) as Record<string, Record<string, unknown>>;
    expect(parsed.features.codex_hooks).toBe(false);
  });

  it("warns when sandbox_mode is read-only", async () => {
    writeConfig(`sandbox_mode = "read-only"
`);

    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    const call = successSpy.mock.calls[0][0] as Record<string, unknown>;
    const warnings = call.warnings as Array<{ code: string }>;
    expect(warnings.some((w) => w.code === "SANDBOX_READ_ONLY")).toBe(true);
    // Did NOT touch sandbox_mode
    const parsed = parseToml(readConfig()) as Record<string, unknown>;
    expect(parsed.sandbox_mode).toBe("read-only");
  });

  // ── --check mode ───────────────────────────────────────────────────

  it("--check exits non-zero when changes are needed", async () => {
    await expect(agentCodexApplyConfig({ check: true })).rejects.toBeInstanceOf(AgentErrorThrow);
    expect(errorSpy).toHaveBeenCalled();
    // No file should have been written
    expect(existsSync(configFile())).toBe(false);
  });

  it("--check exits 0 when config is already OK", async () => {
    writeConfig(`[sandbox_workspace_write]
network_access = true
`);

    await agentCodexApplyConfig({ check: true });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith({
      status: "ALREADY_OK",
      config_file: configFile(),
    });
  });

  it("--check exits non-zero when warnings present even if required key is set", async () => {
    writeConfig(`[features]
codex_hooks = false

[sandbox_workspace_write]
network_access = true
`);

    await expect(agentCodexApplyConfig({ check: true })).rejects.toBeInstanceOf(AgentErrorThrow);
  });

  // ── --dry-run mode ─────────────────────────────────────────────────

  it("--dry-run reports WOULD_APPLY without writing the file", async () => {
    await agentCodexApplyConfig({ dryRun: true });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "WOULD_APPLY",
        config_file: configFile(),
      }),
    );
    expect(existsSync(configFile())).toBe(false);
  });

  // ── Invalid input ──────────────────────────────────────────────────

  it("errors clearly on invalid TOML", async () => {
    writeConfig("this is = = not valid toml");

    await expect(agentCodexApplyConfig()).rejects.toBeInstanceOf(AgentErrorThrow);
    expect(errorSpy).toHaveBeenCalled();
    const call = errorSpy.mock.calls[0];
    expect(call[1]).toBe("ConfigError");
  });
});
