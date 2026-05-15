import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Mock homedir so all filesystem access lands in a scratch dir ────

let scratchHome: string;

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => scratchHome,
  };
});

let inspectLegacyCodexHook: () => {
  hooks_file: string;
  exists: boolean;
  has_legacy_entry: boolean;
  parse_error?: string;
};
let removeLegacyCodexHook: () => {
  hooks_file: string;
  status: "removed" | "absent" | "error";
  error?: string;
};

const HOOK_COMMAND = "mthds-agent codex hook";
const LEGACY_SCRIPT = "~/.codex/hooks/codex-validate-mthds.sh";

describe("legacy codex hook cleanup", () => {
  beforeEach(async () => {
    scratchHome = mkdtempSync(join(tmpdir(), "mthds-codex-cleanup-test-"));
    // Re-import after mocks are set up so homedir() resolves correctly.
    vi.resetModules();
    const mod = await import("../../../src/agent/commands/codex.js");
    inspectLegacyCodexHook = mod.inspectLegacyCodexHook;
    removeLegacyCodexHook = mod.removeLegacyCodexHook;
  });

  afterEach(() => {
    rmSync(scratchHome, { recursive: true, force: true });
  });

  const hooksFile = () => join(scratchHome, ".codex", "hooks.json");

  function writeHooks(value: unknown): void {
    mkdirSync(join(scratchHome, ".codex"), { recursive: true });
    writeFileSync(hooksFile(), typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }

  // ── inspectLegacyCodexHook ──────────────────────────────────────────

  it("reports no entry when hooks.json does not exist", () => {
    const result = inspectLegacyCodexHook();
    expect(result.exists).toBe(false);
    expect(result.has_legacy_entry).toBe(false);
    expect(result.hooks_file).toBe(hooksFile());
  });

  it("detects a current-shape PostToolUse entry pointing at mthds-agent codex hook", () => {
    writeHooks({
      hooks: {
        PostToolUse: [
          { matcher: "apply_patch", hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 30 }] },
        ],
      },
    });
    expect(inspectLegacyCodexHook().has_legacy_entry).toBe(true);
  });

  it("detects a legacy Stop entry pointing at the old bash script", () => {
    writeHooks({
      hooks: { Stop: [{ hooks: [{ type: "command", command: LEGACY_SCRIPT }] }] },
    });
    expect(inspectLegacyCodexHook().has_legacy_entry).toBe(true);
  });

  it("reports no entry when only unrelated hooks are present", () => {
    writeHooks({
      hooks: {
        PostToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "echo unrelated" }] }],
      },
    });
    expect(inspectLegacyCodexHook().has_legacy_entry).toBe(false);
  });

  it("treats an empty hooks.json as no entry", () => {
    writeHooks("");
    const result = inspectLegacyCodexHook();
    expect(result.exists).toBe(true);
    expect(result.has_legacy_entry).toBe(false);
    expect(result.parse_error).toBeUndefined();
  });

  it("reports a parse_error for malformed JSON without crashing", () => {
    writeHooks("not valid json {");
    const result = inspectLegacyCodexHook();
    expect(result.has_legacy_entry).toBe(false);
    expect(result.parse_error).toBeDefined();
  });

  it("reports a parse_error when the top-level value is not an object", () => {
    writeHooks(["not", "an", "object"]);
    expect(inspectLegacyCodexHook().parse_error).toBeDefined();
  });

  // ── removeLegacyCodexHook ───────────────────────────────────────────

  it("returns absent when hooks.json does not exist", () => {
    expect(removeLegacyCodexHook().status).toBe("absent");
  });

  it("removes a current-shape PostToolUse(apply_patch) entry", () => {
    writeHooks({
      hooks: {
        PostToolUse: [
          { matcher: "apply_patch", hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 30 }] },
        ],
      },
    });

    expect(removeLegacyCodexHook().status).toBe("removed");

    const parsed = JSON.parse(readFileSync(hooksFile(), "utf8"));
    // The PostToolUse array became empty, so the key is dropped entirely.
    expect(parsed.hooks.PostToolUse).toBeUndefined();
  });

  it("removes a legacy Stop entry and drops the emptied Stop key", () => {
    writeHooks({
      hooks: { Stop: [{ hooks: [{ type: "command", command: LEGACY_SCRIPT }] }] },
    });

    expect(removeLegacyCodexHook().status).toBe("removed");

    const parsed = JSON.parse(readFileSync(hooksFile(), "utf8"));
    expect(parsed.hooks.Stop).toBeUndefined();
  });

  it("removes both a legacy Stop entry and a legacy PostToolUse entry at once", () => {
    writeHooks({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: LEGACY_SCRIPT }] }],
        PostToolUse: [
          { matcher: "apply_patch", hooks: [{ type: "command", command: LEGACY_SCRIPT }] },
        ],
      },
    });

    expect(removeLegacyCodexHook().status).toBe("removed");

    const parsed = JSON.parse(readFileSync(hooksFile(), "utf8"));
    expect(parsed.hooks.Stop).toBeUndefined();
    expect(parsed.hooks.PostToolUse).toBeUndefined();
  });

  it("preserves unrelated hook entries, hook events, and top-level keys", () => {
    writeHooks({
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "echo before" }] }],
        PostToolUse: [
          { matcher: "Read", hooks: [{ type: "command", command: "echo unrelated" }] },
          { matcher: "apply_patch", hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 30 }] },
        ],
        Stop: [{ hooks: [{ type: "command", command: "/some/other-tool.sh" }] }],
      },
      otherKey: "preserved",
    });

    expect(removeLegacyCodexHook().status).toBe("removed");

    const parsed = JSON.parse(readFileSync(hooksFile(), "utf8"));
    expect(parsed.otherKey).toBe("preserved");
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    // Only the mthds PostToolUse entry was removed; the unrelated one stays.
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(parsed.hooks.PostToolUse[0].matcher).toBe("Read");
    expect(parsed.hooks.Stop).toHaveLength(1);
    expect(parsed.hooks.Stop[0].hooks[0].command).toContain("other-tool");
  });

  it("returns absent and leaves the file untouched when no mthds entry is present", () => {
    writeHooks({
      hooks: {
        PostToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "echo unrelated" }] }],
      },
    });
    const before = readFileSync(hooksFile(), "utf8");

    expect(removeLegacyCodexHook().status).toBe("absent");
    expect(readFileSync(hooksFile(), "utf8")).toBe(before);
  });

  it("returns error and leaves the file untouched when hooks.json is malformed", () => {
    writeHooks("not valid json {");
    const before = readFileSync(hooksFile(), "utf8");

    const result = removeLegacyCodexHook();
    expect(result.status).toBe("error");
    expect(result.error).toBeDefined();
    expect(readFileSync(hooksFile(), "utf8")).toBe(before);
  });

  it("treats a malformed (non-array) PostToolUse slot as nothing to remove", () => {
    writeHooks({ hooks: { PostToolUse: "oops" } });
    expect(removeLegacyCodexHook().status).toBe("absent");
    expect(existsSync(hooksFile())).toBe(true);
  });
});
