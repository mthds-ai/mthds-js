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
const errorSpy = vi.fn((message: string, errorType: string, extras?: Record<string, unknown>) => {
  throw new AgentErrorThrow(errorType, { message, ...extras });
});

vi.mock("../../../src/agent/output.js", () => ({
  agentSuccess: (result: Record<string, unknown>) => successSpy(result),
  agentError: (message: string, errorType: string, extras?: Record<string, unknown>) =>
    errorSpy(message, errorType, extras),
  AGENT_ERROR_DOMAINS: {
    CONFIG: "config",
    IO: "io",
  },
}));

// ── Mock the Codex app version check so tests never spawn `codex` ───

const codexVersionWarningMock = vi.fn<() => { code: string; message: string } | null>();

vi.mock("../../../src/agent/codex-version.js", () => ({
  codexVersionWarning: () => codexVersionWarningMock(),
}));

let agentCodexApplyConfig: (opts?: { check?: boolean; dryRun?: boolean }) => Promise<void>;

const HOOK_COMMAND = "mthds-agent codex hook";

describe("agentCodexApplyConfig", () => {
  beforeEach(async () => {
    scratchHome = mkdtempSync(join(tmpdir(), "mthds-codex-config-test-"));
    successSpy.mockClear();
    errorSpy.mockClear();
    codexVersionWarningMock.mockReset();
    codexVersionWarningMock.mockReturnValue(null);
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

  // ── Apply paths ────────────────────────────────────────────────────

  it("creates config.toml with the required sandbox network key when none exists", async () => {
    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith({
      status: "APPLIED",
      config_file: configFile(),
      applied: [NETWORK_CHANGE],
      legacy_hook: { hooks_file: hooksFile(), status: "absent" },
      warnings: [],
    });
    const parsed = parseToml(readConfig()) as Record<string, Record<string, unknown>>;
    expect(parsed.sandbox_workspace_write.network_access).toBe(true);
    // No [features] hook flag is written — hooks are default-on since Codex
    // 0.131 and the old plugin_hooks opt-in key was removed in 0.134.
    expect(parsed.features).toBeUndefined();
  });

  it("appends [sandbox_workspace_write] and leaves an existing [features] table untouched", async () => {
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
    // apply-config no longer writes a hook feature flag.
    expect(parsed.features.plugin_hooks).toBeUndefined();
    expect(parsed.sandbox_workspace_write.network_access).toBe(true);
  });

  it("inserts network_access into an existing [sandbox_workspace_write] table", async () => {
    writeConfig(`[sandbox_workspace_write]
writable_roots = ["/tmp"]
`);

    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    const parsed = parseToml(readConfig()) as Record<string, Record<string, unknown>>;
    expect(parsed.sandbox_workspace_write.network_access).toBe(true);
    expect(parsed.sandbox_workspace_write.writable_roots).toEqual(["/tmp"]);
    // No [features] table is created — the hook flag is no longer required.
    expect(parsed.features).toBeUndefined();
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

  it("reports ALREADY_OK when the required key is already set", async () => {
    writeConfig(`[sandbox_workspace_write]
network_access = true
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

  it("errors without writing when the stale plugin_hooks key is explicitly false", async () => {
    // plugin_hooks disabled plugin-bundled hooks on Codex ≤ 0.133 and is
    // ignored since 0.134 — either way the key must be removed by hand, so an
    // explicit false is a hard error, not a warning that APPLIED would mask.
    const original = `[features]
plugin_hooks = false
`;
    writeConfig(original);

    await expect(agentCodexApplyConfig()).rejects.toBeInstanceOf(AgentErrorThrow);
    expect(errorSpy.mock.calls[0][1]).toBe("ConfigError");
    expect(errorSpy.mock.calls[0][0]).toContain("plugin_hooks = false");
    expect(errorSpy.mock.calls[0][0]).toContain("ignored by Codex 0.134+");
    // File untouched — apply-config never overrides an explicit user choice,
    // and errors before writing anything (not even the network key).
    expect(readConfig()).toBe(original);
  });

  it('distinguishes a string "true" from the required boolean in the conflict message', async () => {
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

  // ── Hook-disabling keys (hard error, never modify) ─────────────────

  it("errors without writing when [features] hooks is explicitly false", async () => {
    // An explicit `hooks = false` disables ALL Codex hooks — the mthds hook
    // cannot load, so reporting APPLIED would be a false success. This is a
    // conflict-style hard error in every mode; the user must remove the key.
    const original = `[features]
hooks = false
`;
    writeConfig(original);

    await expect(agentCodexApplyConfig()).rejects.toBeInstanceOf(AgentErrorThrow);
    expect(errorSpy.mock.calls[0][1]).toBe("ConfigError");
    expect(errorSpy.mock.calls[0][0]).toContain("hooks = false");
    expect(errorSpy.mock.calls[0][0]).toContain("disables ALL Codex hooks");
    expect(readConfig()).toBe(original);
  });

  it("errors when the deprecated codex_hooks alias is explicitly false", async () => {
    const original = `[features]
codex_hooks = false
`;
    writeConfig(original);

    await expect(agentCodexApplyConfig()).rejects.toBeInstanceOf(AgentErrorThrow);
    expect(errorSpy.mock.calls[0][1]).toBe("ConfigError");
    expect(errorSpy.mock.calls[0][0]).toContain("codex_hooks = false");
    expect(errorSpy.mock.calls[0][0]).toContain("deprecated alias");
    expect(readConfig()).toBe(original);
  });

  it("names every disabled key when hooks and codex_hooks are both false", async () => {
    // Regression: a first-match implementation named only `hooks`, silently
    // omitting `codex_hooks` when both were disabled.
    writeConfig(`[features]
hooks = false
codex_hooks = false
`);

    await expect(agentCodexApplyConfig()).rejects.toBeInstanceOf(AgentErrorThrow);
    const message = errorSpy.mock.calls[0][0] as string;
    expect(message).toContain("[features] hooks = false");
    expect(message).toContain("[features] codex_hooks = false");
  });

  it("--dry-run also errors on a hook-disabling key", async () => {
    // The conflict check runs before the mode branches so apply, --check and
    // --dry-run all give the same verdict for the same config state.
    writeConfig(`[features]
hooks = false
`);

    await expect(agentCodexApplyConfig({ dryRun: true })).rejects.toBeInstanceOf(AgentErrorThrow);
    expect(errorSpy.mock.calls[0][1]).toBe("ConfigError");
  });

  // ── Warnings (warn-only, never modify) ─────────────────────────────

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

  it("includes a CODEX_VERSION_TOO_OLD warning in the APPLIED payload when Codex is old", async () => {
    codexVersionWarningMock.mockReturnValue({
      code: "CODEX_VERSION_TOO_OLD",
      message: "Codex 0.130.0 is older than 0.141.0, the minimum version the mthds plugin supports",
    });

    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    const call = lastSuccess();
    // The version check is advisory — the required key is still applied.
    expect(call.status).toBe("APPLIED");
    const warnings = call.warnings as Array<{ code: string; message: string }>;
    const warning = warnings.find((w) => w.code === "CODEX_VERSION_TOO_OLD");
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("0.130.0");
  });

  it("emits no version warning when Codex cannot be detected or is recent enough", async () => {
    // codexVersionWarningMock defaults to null (set in beforeEach) — covers
    // both the binary-missing and the recent-enough cases.
    await agentCodexApplyConfig();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(lastSuccess().warnings).toEqual([]);
  });

  // ── Legacy ~/.codex/hooks.json cleanup ─────────────────────────────

  it("removes an obsolete ~/.codex/hooks.json entry left by the retired install-hook", async () => {
    writeConfig(`[sandbox_workspace_write]
network_access = true
`);
    writeHooks({
      hooks: {
        PostToolUse: [
          {
            matcher: "apply_patch",
            hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 30 }],
          },
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

  it("errors on a malformed ~/.codex/hooks.json but still writes the required config key", async () => {
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), "not valid json {", "utf8");

    // A hooks.json we cannot parse can't be confirmed free of an obsolete
    // double-firing entry — apply-config errors (matching `apply-config
    // --check`) instead of reporting success while the problem persists.
    await expect(agentCodexApplyConfig()).rejects.toBeInstanceOf(AgentErrorThrow);
    expect(errorSpy.mock.calls[0][1]).toBe("ConfigError");
    expect(errorSpy.mock.calls[0][0]).toContain("hooks.json");
    // config.toml was still written before the hooks.json check ran.
    const parsed = parseToml(readConfig()) as Record<string, Record<string, unknown>>;
    expect(parsed.sandbox_workspace_write.network_access).toBe(true);
    // No [features] hook flag is written.
    expect(parsed.features).toBeUndefined();
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
`);

    await agentCodexApplyConfig({ check: true });

    expect(errorSpy).not.toHaveBeenCalled();
    // --check ALREADY_OK returns the same shape as --dry-run / apply so
    // consumers see a consistent schema across every mode.
    expect(successSpy).toHaveBeenCalledWith({
      status: "ALREADY_OK",
      config_file: configFile(),
      applied: [],
      legacy_hook: { hooks_file: hooksFile(), status: "absent" },
      warnings: [],
    });
  });

  it("--check exits non-zero when a hook-disabling key is set even if the required key is set", async () => {
    writeConfig(`[sandbox_workspace_write]
network_access = true

[features]
hooks = false
`);

    await expect(agentCodexApplyConfig({ check: true })).rejects.toBeInstanceOf(AgentErrorThrow);
    // The conflict error is specific — not the generic "needs attention".
    expect(errorSpy.mock.calls[0][0]).toContain("hooks = false");
  });

  it("--check exits non-zero when a warning is present even if the required key is set", async () => {
    writeConfig(`sandbox_mode = "read-only"

[sandbox_workspace_write]
network_access = true
`);

    await expect(agentCodexApplyConfig({ check: true })).rejects.toBeInstanceOf(AgentErrorThrow);
  });

  it("--check exits non-zero when the installed Codex is older than the supported floor", async () => {
    codexVersionWarningMock.mockReturnValue({
      code: "CODEX_VERSION_TOO_OLD",
      message: "Codex 0.130.0 is older than 0.141.0, the minimum version the mthds plugin supports",
    });
    writeConfig(`[sandbox_workspace_write]
network_access = true
`);

    await expect(agentCodexApplyConfig({ check: true })).rejects.toBeInstanceOf(AgentErrorThrow);
  });

  it("--check exits non-zero when a stale ~/.codex/hooks.json entry is present", async () => {
    writeConfig(`[sandbox_workspace_write]
network_access = true
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

  it("--check exits non-zero when ~/.codex/hooks.json is malformed", async () => {
    // config.toml is fully OK, but an unreadable hooks.json means we cannot
    // confirm no obsolete entry double-fires — --check must flag it, matching
    // the apply path which errors on the same state.
    writeConfig(`[sandbox_workspace_write]
network_access = true
`);
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), "not valid json {", "utf8");

    await expect(agentCodexApplyConfig({ check: true })).rejects.toBeInstanceOf(AgentErrorThrow);
  });

  // ── --dry-run mode ─────────────────────────────────────────────────

  it("--dry-run reports WOULD_APPLY without writing the file", async () => {
    await agentCodexApplyConfig({ dryRun: true });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith({
      status: "WOULD_APPLY",
      config_file: configFile(),
      applied: [NETWORK_CHANGE],
      legacy_hook: { hooks_file: hooksFile(), status: "absent" },
      warnings: [],
    });
    expect(existsSync(configFile())).toBe(false);
  });

  it("--dry-run flags a stale hook entry as would-remove without touching it", async () => {
    writeConfig(`[sandbox_workspace_write]
network_access = true
`);
    const hooksBefore = JSON.stringify(
      {
        hooks: {
          PostToolUse: [
            { matcher: "apply_patch", hooks: [{ type: "command", command: HOOK_COMMAND }] },
          ],
        },
      },
      null,
      2,
    );
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

  it("surfaces a ConfigError when an intermediate edit produces unparseable TOML", async () => {
    // A dotted-key implicit table has no `[header]` line, so appendTomlTable
    // emits a second `[sandbox_workspace_write]` header that smol-toml rejects
    // as a duplicate. applyChanges re-parses between changes, so the bad
    // intermediate state throws inside applyChanges — it must surface as a
    // ConfigError, not an uncaught crash that bypasses the error path.
    writeConfig(`sandbox_workspace_write.foo = 1
`);

    await expect(agentCodexApplyConfig()).rejects.toBeInstanceOf(AgentErrorThrow);
    expect(errorSpy.mock.calls[0][1]).toBe("ConfigError");
    expect(errorSpy.mock.calls[0][0]).toContain("would not re-parse");
  });
});
