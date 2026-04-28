import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    public extras?: Record<string, unknown>
  ) {
    super(errorType);
  }
}

const successSpy = vi.fn();
const errorSpy = vi.fn(
  (message: string, errorType: string, extras?: Record<string, unknown>) => {
    throw new AgentErrorThrow(errorType, { message, ...extras });
  }
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

let agentCodexInstallHook: () => Promise<void>;

const HOOK_COMMAND = "mthds-agent codex hook";

describe("agentCodexInstallHook", () => {
  beforeEach(async () => {
    scratchHome = mkdtempSync(join(tmpdir(), "mthds-codex-test-"));
    successSpy.mockClear();
    errorSpy.mockClear();
    // Re-import after mocks are set up so homedir() resolves correctly.
    vi.resetModules();
    const mod = await import("../../../src/agent/commands/codex.js");
    agentCodexInstallHook = mod.agentCodexInstallHook;
  });

  afterEach(() => {
    rmSync(scratchHome, { recursive: true, force: true });
  });

  const hooksFile = () => join(scratchHome, ".codex", "hooks.json");

  // ── Fresh-install paths ────────────────────────────────────────────

  it("creates a fresh hooks.json with PostToolUse(apply_patch) when none exists", async () => {
    await agentCodexInstallHook();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith({
      status: "INSTALLED_NEW_FILE",
      hooks_file: hooksFile(),
    });
    expect(existsSync(hooksFile())).toBe(true);

    const parsed = JSON.parse(readFileSync(hooksFile(), "utf8"));
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(parsed.hooks.PostToolUse[0].matcher).toBe("apply_patch");
    expect(parsed.hooks.PostToolUse[0].hooks[0].command).toBe(HOOK_COMMAND);
    expect(parsed.hooks.PostToolUse[0].hooks[0].timeout).toBe(30);
    expect(parsed.hooks.PostToolUse[0].hooks[0].type).toBe("command");
    // No legacy keys
    expect(parsed.hooks.Stop).toBeUndefined();
  });

  // ── Idempotency ────────────────────────────────────────────────────

  it("is idempotent when the new-shape entry is already present", async () => {
    const existing = {
      hooks: {
        PostToolUse: [
          {
            matcher: "apply_patch",
            hooks: [
              { type: "command", command: HOOK_COMMAND, timeout: 30 },
            ],
          },
        ],
      },
    };
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify(existing, null, 2));

    await agentCodexInstallHook();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith({
      status: "ALREADY_INSTALLED",
      hooks_file: hooksFile(),
    });
    const parsed = JSON.parse(readFileSync(hooksFile(), "utf8"));
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
  });

  // ── Coexistence with unrelated entries ─────────────────────────────

  it("merges into an existing hooks.json with unrelated PostToolUse entries", async () => {
    const existing = {
      hooks: {
        PostToolUse: [
          {
            matcher: "Read",
            hooks: [
              { type: "command", command: "echo unrelated", timeout: 10 },
            ],
          },
        ],
      },
    };
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify(existing, null, 2));

    await agentCodexInstallHook();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith({
      status: "MERGED",
      hooks_file: hooksFile(),
    });
    const parsed = JSON.parse(readFileSync(hooksFile(), "utf8"));
    expect(parsed.hooks.PostToolUse).toHaveLength(2);
    expect(parsed.hooks.PostToolUse[0].matcher).toBe("Read");
    expect(parsed.hooks.PostToolUse[1].matcher).toBe("apply_patch");
    expect(parsed.hooks.PostToolUse[1].hooks[0].command).toBe(HOOK_COMMAND);
  });

  it("preserves unrelated top-level keys and other hook categories", async () => {
    const existing = {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command: "echo before" }] },
        ],
      },
      otherKey: "preserved",
    };
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify(existing, null, 2));

    await agentCodexInstallHook();

    expect(errorSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(readFileSync(hooksFile(), "utf8"));
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(parsed.otherKey).toBe("preserved");
  });

  // ── Legacy-Stop migration (pre-0.5.0 mthds-agent) ──────────────────

  it("removes a legacy Stop entry pointing at our old bash script", async () => {
    const existing = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "~/.codex/hooks/codex-validate-mthds.sh",
                timeout: 30,
              },
            ],
          },
        ],
      },
    };
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify(existing, null, 2));

    await agentCodexInstallHook();

    expect(errorSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(readFileSync(hooksFile(), "utf8"));
    // Stop was the only entry pointing at our script — the entire Stop key drops.
    expect(parsed.hooks.Stop).toBeUndefined();
    // PostToolUse(apply_patch) is now present.
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(parsed.hooks.PostToolUse[0].matcher).toBe("apply_patch");
    expect(parsed.hooks.PostToolUse[0].hooks[0].command).toBe(HOOK_COMMAND);
  });

  it("preserves unrelated Stop entries while removing ours", async () => {
    const existing = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: "command", command: "/some/other-tool.sh", timeout: 15 },
            ],
          },
          {
            hooks: [
              {
                type: "command",
                command: "~/.codex/hooks/codex-validate-mthds.sh",
                timeout: 30,
              },
            ],
          },
        ],
      },
    };
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify(existing, null, 2));

    await agentCodexInstallHook();

    expect(errorSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(readFileSync(hooksFile(), "utf8"));
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain("other-tool");
  });

  // ── Legacy-PostToolUse migration (mthds-plugins WIP 0.9.0 install-codex.sh) ─

  it("cleans up a stale Stop entry even when the current PostToolUse entry already exists", async () => {
    // Regression: previously the function early-returned ALREADY_INSTALLED
    // as soon as it saw the current entry, skipping the write step — so any
    // in-memory Stop cleanup was discarded. The dirty-tracking rewrite must
    // persist the Stop removal even when nothing else changes.
    const existing = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "~/.codex/hooks/codex-validate-mthds.sh",
                timeout: 30,
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: "apply_patch",
            hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 30 }],
          },
        ],
      },
    };
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify(existing, null, 2));

    await agentCodexInstallHook();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith({
      status: "MERGED",
      hooks_file: hooksFile(),
    });
    const parsed = JSON.parse(readFileSync(hooksFile(), "utf8"));
    expect(parsed.hooks.Stop).toBeUndefined();
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(parsed.hooks.PostToolUse[0].hooks[0].command).toBe(HOOK_COMMAND);
  });

  it("migrates a hooks.json that has BOTH legacy Stop and legacy PostToolUse entries", async () => {
    // A user upgrading from pre-0.5.0 mthds-agent (Stop entry) to a transitional
    // WIP-0.9.0 install-codex.sh build (which added a PostToolUse entry without
    // removing the Stop entry) ends up with both. The migration must remove
    // both legacy entries and write exactly one current-shape entry.
    const existing = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "~/.codex/hooks/codex-validate-mthds.sh",
                timeout: 30,
              },
            ],
          },
        ],
        PostToolUse: [
          {
            matcher: "apply_patch",
            hooks: [
              {
                type: "command",
                command: "~/.codex/hooks/codex-validate-mthds.sh",
                timeout: 30,
              },
            ],
          },
        ],
      },
    };
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify(existing, null, 2));

    await agentCodexInstallHook();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith({
      status: "MERGED",
      hooks_file: hooksFile(),
    });
    const parsed = JSON.parse(readFileSync(hooksFile(), "utf8"));
    expect(parsed.hooks.Stop).toBeUndefined();
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(parsed.hooks.PostToolUse[0].matcher).toBe("apply_patch");
    expect(parsed.hooks.PostToolUse[0].hooks[0].command).toBe(HOOK_COMMAND);
  });

  it("replaces a legacy PostToolUse(apply_patch) entry that pointed at the bash script", async () => {
    const existing = {
      hooks: {
        PostToolUse: [
          {
            matcher: "apply_patch",
            hooks: [
              {
                type: "command",
                command: "~/.codex/hooks/codex-validate-mthds.sh",
                timeout: 30,
              },
            ],
          },
        ],
      },
    };
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify(existing, null, 2));

    await agentCodexInstallHook();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith({
      status: "MERGED",
      hooks_file: hooksFile(),
    });
    const parsed = JSON.parse(readFileSync(hooksFile(), "utf8"));
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(parsed.hooks.PostToolUse[0].matcher).toBe("apply_patch");
    expect(parsed.hooks.PostToolUse[0].hooks[0].command).toBe(HOOK_COMMAND);
  });

  // ── Edge cases on the existing file ────────────────────────────────

  it("handles an existing hooks.json without a hooks key", async () => {
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify({ unrelated: true }));

    await agentCodexInstallHook();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith({
      status: "MERGED",
      hooks_file: hooksFile(),
    });
    const parsed = JSON.parse(readFileSync(hooksFile(), "utf8"));
    expect(parsed.unrelated).toBe(true);
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
  });

  it("treats an empty hooks.json as an existing empty file (MERGED)", async () => {
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), "");

    await agentCodexInstallHook();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith({
      status: "MERGED",
      hooks_file: hooksFile(),
    });
    const parsed = JSON.parse(readFileSync(hooksFile(), "utf8"));
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
  });

  // ── Validation failures ────────────────────────────────────────────

  it("fails loudly on invalid JSON", async () => {
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), "not valid json {");

    await expect(agentCodexInstallHook()).rejects.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]![1]).toBe("ConfigError");
  });

  it("fails loudly when top-level is not an object", async () => {
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify(["not", "an", "object"]));

    await expect(agentCodexInstallHook()).rejects.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]![1]).toBe("ConfigError");
  });

  it("fails loudly when the hooks key is not an object", async () => {
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify({ hooks: "not-an-object" }));

    await expect(agentCodexInstallHook()).rejects.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]![1]).toBe("ConfigError");
  });

  it("fails loudly when hooks.PostToolUse is not an array", async () => {
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify({ hooks: { PostToolUse: { bogus: true } } }));

    await expect(agentCodexInstallHook()).rejects.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]![1]).toBe("ConfigError");
  });

  it("fails loudly when hooks.Stop is not an array", async () => {
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify({ hooks: { Stop: { bogus: true } } }));

    await expect(agentCodexInstallHook()).rejects.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]![1]).toBe("ConfigError");
  });
});
