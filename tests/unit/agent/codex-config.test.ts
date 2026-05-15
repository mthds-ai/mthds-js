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

const HOOK_COMMAND = "mthds-agent codex hook";

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
  const hooksFile = () => join(scratchHome, ".codex", "hooks.json");

  function writeConfig(contents: string): void {
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(configFile(), contents, "utf8");
  }

  function writeHooks(value: unknown): void {
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify(value, null, 2), "utf8");
  }

  function readConfig(): string {
    return readFileSync(configFile(), "utf8");
  }

  function lastSuccess(): Record<string, unknown> {
    return successSpy.mock.calls[0][0] as Record<string, unknown>;
  }

  const NETWORK_CHANGE = { table: "sandbox_workspace_write", key: "network_access", value: "true" };
  const PLUGIN_HOOKS_CHANGE = { table: "features", key: "plugin_hooks", value: "true" };

  // ── Apply paths ────────────────────────────────────────────────────

  it("creates config.toml with both required keys when none exists", async () => {
    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith({
      status: "APPLIED",
      config_file: configFile(),
      applied: [NETWORK_CHANGE, PLUGIN_HOOKS_CHANGE],
      legacy_hook: { hooks_file: hooksFile(), status: "absent" },
      warnings: [],
    });
    const parsed = parseToml(readConfig()) as Record<string, Record<string, unknown>>;
    expect(parsed.sandbox_workspace_write.network_access).toBe(true);
    expect(parsed.features.plugin_hooks).toBe(true);
  });

  it("inserts plugin_hooks into an existing [features] table and appends [sandbox_workspace_write]", async () => {
    writeConfig(`# top comment
sandbox_mode = "workspace-write"

[features]
some_other = true
`);

    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(lastSuccess().status).toBe("APPLIED");
    const raw = readConfig();
    // Existing comments and keys preserved verbatim
    expect(raw).toContain("# top comment");
    expect(raw).toContain('sandbox_mode = "workspace-write"');

    const parsed = parseToml(raw) as Record<string, Record<string, unknown>>;
    expect(parsed.features.some_other).toBe(true);
    expect(parsed.features.plugin_hooks).toBe(true);
    expect(parsed.sandbox_workspace_write.network_access).toBe(true);
  });

  it("inserts network_access into an existing [sandbox_workspace_write] table and appends [features]", async () => {
    writeConfig(`[sandbox_workspace_write]
writable_roots = ["/tmp"]
`);

    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    const parsed = parseToml(readConfig()) as Record<string, Record<string, unknown>>;
    expect(parsed.sandbox_workspace_write.network_access).toBe(true);
    expect(parsed.sandbox_workspace_write.writable_roots).toEqual(["/tmp"]);
    expect(parsed.features.plugin_hooks).toBe(true);
  });

  it("treats [[array_of_tables]] headers as section boundaries when inserting", async () => {
    // Regression: a sloppy boundary regex would step past `[[history]]` and
    // insert network_access into the wrong section.
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
    // The array-of-tables entries must not have grown a network_access key.
    expect(history[0].network_access).toBeUndefined();
    expect(history[1].network_access).toBeUndefined();
  });

  // ── Idempotence ────────────────────────────────────────────────────

  it("reports ALREADY_OK when both required keys are already set", async () => {
    writeConfig(`[sandbox_workspace_write]
network_access = true

[features]
plugin_hooks = true
`);

    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith({
      status: "ALREADY_OK",
      config_file: configFile(),
      applied: [],
      legacy_hook: { hooks_file: hooksFile(), status: "absent" },
      warnings: [],
    });
  });

  it("is idempotent — second run after apply is a no-op", async () => {
    await agentCodexApplyConfig();
    const after1 = readConfig();
    successSpy.mockClear();

    await agentCodexApplyConfig();

    expect(lastSuccess().status).toBe("ALREADY_OK");
    expect(readConfig()).toBe(after1);
  });

  // ── Conflicts (a key explicitly set to the wrong value) ────────────

  it("errors without writing when network_access is explicitly false", async () => {
    const original = `[sandbox_workspace_write]
network_access = false
`;
    writeConfig(original);

    await expect(agentCodexApplyConfig()).rejects.toBeInstanceOf(AgentErrorThrow);
    expect(errorSpy.mock.calls[0][1]).toBe("ConfigError");
    // File untouched — apply-config never overrides an explicit user choice.
    expect(readConfig()).toBe(original);
  });

  it("errors without writing when plugin_hooks is explicitly false", async () => {
    const original = `[features]
plugin_hooks = false
`;
    writeConfig(original);

    await expect(agentCodexApplyConfig()).rejects.toBeInstanceOf(AgentErrorThrow);
    expect(errorSpy.mock.calls[0][1]).toBe("ConfigError");
    expect(readConfig()).toBe(original);
  });

  it("distinguishes a string \"true\" from the required boolean in the conflict message", async () => {
    const original = `[sandbox_workspace_write]
network_access = "true"
`;
    writeConfig(original);

    await expect(agentCodexApplyConfig()).rejects.toBeInstanceOf(AgentErrorThrow);
    expect(errorSpy.mock.calls[0][1]).toBe("ConfigError");
    // The quoted form makes clear the current value is a string, not the
    // boolean the plugin needs.
    expect(errorSpy.mock.calls[0][0]).toContain('network_access = "true"');
    expect(readConfig()).toBe(original);
  });

  // ── Warnings (warn-only, never modify) ─────────────────────────────

  it("warns when [features] hooks is explicitly false but still applies the required keys", async () => {
    writeConfig(`[features]
hooks = false
`);

    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    const call = lastSuccess();
    expect(call.status).toBe("APPLIED");
    const warnings = call.warnings as Array<{ code: string; message: string }>;
    expect(warnings.some((w) => w.code === "CODEX_HOOKS_DISABLED")).toBe(true);

    const parsed = parseToml(readConfig()) as Record<string, Record<string, unknown>>;
    // hooks left untouched; plugin_hooks added alongside it.
    expect(parsed.features.hooks).toBe(false);
    expect(parsed.features.plugin_hooks).toBe(true);
  });

  it("warns when [features] codex_hooks is explicitly false", async () => {
    writeConfig(`[features]
codex_hooks = false
`);

    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    const warnings = lastSuccess().warnings as Array<{ code: string; message: string }>;
    const warning = warnings.find((w) => w.code === "CODEX_HOOKS_DISABLED");
    expect(warning?.message).toContain("[features] codex_hooks is");
  });

  it("warns when sandbox_mode is read-only without modifying it", async () => {
    writeConfig(`sandbox_mode = "read-only"
`);

    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    const warnings = lastSuccess().warnings as Array<{ code: string }>;
    expect(warnings.some((w) => w.code === "SANDBOX_READ_ONLY")).toBe(true);
    const parsed = parseToml(readConfig()) as Record<string, unknown>;
    expect(parsed.sandbox_mode).toBe("read-only");
  });

  // ── Legacy ~/.codex/hooks.json cleanup ─────────────────────────────

  it("removes an obsolete ~/.codex/hooks.json entry left by the retired install-hook", async () => {
    writeConfig(`[sandbox_workspace_write]
network_access = true

[features]
plugin_hooks = true
`);
    writeHooks({
      hooks: {
        PostToolUse: [
          { matcher: "apply_patch", hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 30 }] },
        ],
      },
    });

    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    const call = lastSuccess();
    // config.toml needed nothing, but removing the stale hook still counts as APPLIED.
    expect(call.status).toBe("APPLIED");
    expect(call.applied).toEqual([]);
    expect(call.legacy_hook).toEqual({ hooks_file: hooksFile(), status: "removed" });
    expect(readFileSync(hooksFile(), "utf8")).not.toContain(HOOK_COMMAND);
  });

  it("warns but still applies config when ~/.codex/hooks.json is malformed", async () => {
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), "not valid json {", "utf8");

    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    const call = lastSuccess();
    expect(call.status).toBe("APPLIED");
    const warnings = call.warnings as Array<{ code: string }>;
    expect(warnings.some((w) => w.code === "LEGACY_HOOK_UNREADABLE")).toBe(true);
    // The required config keys were still written.
    const parsed = parseToml(readConfig()) as Record<string, Record<string, unknown>>;
    expect(parsed.sandbox_workspace_write.network_access).toBe(true);
  });

  // ── --check mode ───────────────────────────────────────────────────

  it("--check exits non-zero when changes are needed", async () => {
    await expect(agentCodexApplyConfig({ check: true })).rejects.toBeInstanceOf(AgentErrorThrow);
    expect(errorSpy).toHaveBeenCalled();
    expect(existsSync(configFile())).toBe(false);
  });

  it("--check exits 0 when config is already OK and no stale hook exists", async () => {
    writeConfig(`[sandbox_workspace_write]
network_access = true

[features]
plugin_hooks = true
`);

    await agentCodexApplyConfig({ check: true });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith({
      status: "ALREADY_OK",
      config_file: configFile(),
    });
  });

  it("--check exits non-zero when a warning is present even if both keys are set", async () => {
    writeConfig(`[sandbox_workspace_write]
network_access = true

[features]
plugin_hooks = true
hooks = false
`);

    await expect(agentCodexApplyConfig({ check: true })).rejects.toBeInstanceOf(AgentErrorThrow);
  });

  it("--check exits non-zero when a stale ~/.codex/hooks.json entry is present", async () => {
    writeConfig(`[sandbox_workspace_write]
network_access = true

[features]
plugin_hooks = true
`);
    writeHooks({
      hooks: {
        PostToolUse: [
          { matcher: "apply_patch", hooks: [{ type: "command", command: HOOK_COMMAND }] },
        ],
      },
    });

    await expect(agentCodexApplyConfig({ check: true })).rejects.toBeInstanceOf(AgentErrorThrow);
  });

  // ── --dry-run mode ─────────────────────────────────────────────────

  it("--dry-run reports WOULD_APPLY without writing the file", async () => {
    await agentCodexApplyConfig({ dryRun: true });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith({
      status: "WOULD_APPLY",
      config_file: configFile(),
      applied: [NETWORK_CHANGE, PLUGIN_HOOKS_CHANGE],
      legacy_hook: { hooks_file: hooksFile(), status: "absent" },
      warnings: [],
    });
    expect(existsSync(configFile())).toBe(false);
  });

  it("--dry-run flags a stale hook entry as would-remove without touching it", async () => {
    writeConfig(`[sandbox_workspace_write]
network_access = true

[features]
plugin_hooks = true
`);
    const hooksBefore = JSON.stringify({
      hooks: {
        PostToolUse: [
          { matcher: "apply_patch", hooks: [{ type: "command", command: HOOK_COMMAND }] },
        ],
      },
    }, null, 2);
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), hooksBefore, "utf8");

    await agentCodexApplyConfig({ dryRun: true });

    expect(errorSpy).not.toHaveBeenCalled();
    const call = lastSuccess();
    expect(call.status).toBe("WOULD_APPLY");
    expect(call.legacy_hook).toEqual({ hooks_file: hooksFile(), status: "would-remove" });
    // hooks.json untouched in dry-run.
    expect(readFileSync(hooksFile(), "utf8")).toBe(hooksBefore);
  });

  // ── Invalid input ──────────────────────────────────────────────────

  it("errors clearly on invalid TOML", async () => {
    writeConfig("this is = = not valid toml");

    await expect(agentCodexApplyConfig()).rejects.toBeInstanceOf(AgentErrorThrow);
    expect(errorSpy.mock.calls[0][1]).toBe("ConfigError");
  });
});
