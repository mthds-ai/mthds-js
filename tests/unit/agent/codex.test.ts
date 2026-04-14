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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let agentCodexInstallHook: () => Promise<void>;

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

  it("creates a fresh hooks.json when none exists", async () => {
    await agentCodexInstallHook();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(successSpy).toHaveBeenCalledWith({
      status: "INSTALLED_NEW_FILE",
      hooks_file: hooksFile(),
    });
    expect(existsSync(hooksFile())).toBe(true);

    const parsed = JSON.parse(readFileSync(hooksFile(), "utf8"));
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain("codex-validate-mthds");
    expect(parsed.hooks.Stop[0].hooks[0].timeout).toBe(30);
  });

  it("is idempotent when the entry is already present", async () => {
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
    expect(successSpy).toHaveBeenCalledWith({
      status: "ALREADY_INSTALLED",
      hooks_file: hooksFile(),
    });
    const parsed = JSON.parse(readFileSync(hooksFile(), "utf8"));
    expect(parsed.hooks.Stop).toHaveLength(1);
  });

  it("merges into an existing hooks.json with unrelated Stop entries", async () => {
    const existing = {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "~/.codex/hooks/some-other-tool.sh",
                timeout: 15,
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
    expect(parsed.hooks.Stop).toHaveLength(2);
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain("some-other-tool");
    expect(parsed.hooks.Stop[1].hooks[0].command).toContain("codex-validate-mthds");
  });

  it("preserves unrelated top-level hook categories (PostToolUse, etc.)", async () => {
    const existing = {
      hooks: {
        PostToolUse: [
          { hooks: [{ type: "command", command: "echo hi" }] },
        ],
      },
      otherKey: "preserved",
    };
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify(existing, null, 2));

    await agentCodexInstallHook();

    expect(errorSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(readFileSync(hooksFile(), "utf8"));
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.otherKey).toBe("preserved");
  });

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
    expect(parsed.hooks.Stop).toHaveLength(1);
  });

  it("fails loudly on invalid JSON", async () => {
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), "not valid json {");

    await expect(agentCodexInstallHook()).rejects.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    const call = errorSpy.mock.calls[0]!;
    expect(call[1]).toBe("ConfigError");
  });

  it("fails loudly when top-level is not an object", async () => {
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify(["not", "an", "object"]));

    await expect(agentCodexInstallHook()).rejects.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls[0]![1]).toBe("ConfigError");
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
    expect(parsed.hooks.Stop).toHaveLength(1);
  });

  it("fails loudly when hooks.Stop is not an array", async () => {
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), JSON.stringify({ hooks: { Stop: { bogus: true } } }));

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
});
