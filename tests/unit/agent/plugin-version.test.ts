import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    readFileSync: vi.fn((): string => {
      const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }),
  };
});

import { readFileSync } from "node:fs";
import { checkPluginVersion, MIN_PLUGIN_VERSION, PLUGIN_KEYS } from "../../../src/agent/plugin-version.js";

// ── Helpers ──────────────────────────────────────────────────────

function makeInstalledPlugins(
  entries: Array<{ scope: string; version: string }>
): string {
  return JSON.stringify({
    version: 2,
    plugins: { [PLUGIN_KEYS[0]]: entries.map((e) => ({ ...e, installPath: "/tmp" })) },
  });
}

describe("checkPluginVersion", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(readFileSync).mockImplementation(() => {
      const err = new Error("ENOENT: no such file") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
  });

  // ---------------------------------------------------------------------------
  // File not found — not in Claude Code
  // ---------------------------------------------------------------------------
  it("returns null when installed_plugins.json does not exist", () => {
    const result = checkPluginVersion();
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Corrupt JSON
  // ---------------------------------------------------------------------------
  it("returns null when file contains corrupt JSON", () => {
    vi.mocked(readFileSync).mockReturnValue("not valid json{{{");
    const result = checkPluginVersion();
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Missing plugins key
  // ---------------------------------------------------------------------------
  it("returns null when file has no plugins key", () => {
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: 2 }));
    const result = checkPluginVersion();
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // plugins key is null or non-object
  // ---------------------------------------------------------------------------
  it("returns null when plugins is null", () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ version: 2, plugins: null })
    );
    expect(checkPluginVersion()).toBeNull();
  });

  it("returns null when plugins is a number", () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ version: 2, plugins: 42 })
    );
    expect(checkPluginVersion()).toBeNull();
  });

  it("returns null when plugins is an array", () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ version: 2, plugins: [] })
    );
    expect(checkPluginVersion()).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Plugin key not present
  // ---------------------------------------------------------------------------
  it("returns missing when plugin key is absent", () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ version: 2, plugins: {} })
    );
    const result = checkPluginVersion();
    expect(result).toEqual({ s: "missing", v: null, r: MIN_PLUGIN_VERSION });
  });

  // ---------------------------------------------------------------------------
  // Plugin key with empty array
  // ---------------------------------------------------------------------------
  it("returns missing when plugin key has empty entries array", () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ version: 2, plugins: { [PLUGIN_KEYS[0]]: [] } })
    );
    const result = checkPluginVersion();
    expect(result).toEqual({ s: "missing", v: null, r: MIN_PLUGIN_VERSION });
  });

  // ---------------------------------------------------------------------------
  // Up-to-date plugin
  // ---------------------------------------------------------------------------
  it("returns ok when plugin version satisfies constraint", () => {
    vi.mocked(readFileSync).mockReturnValue(
      makeInstalledPlugins([{ scope: "user", version: "0.9.1" }])
    );
    const result = checkPluginVersion();
    expect(result).toEqual({ s: "ok", v: "0.9.1" });
  });

  // ---------------------------------------------------------------------------
  // Outdated plugin
  // ---------------------------------------------------------------------------
  it("returns outdated when plugin version is below minimum", () => {
    vi.mocked(readFileSync).mockReturnValue(
      makeInstalledPlugins([{ scope: "user", version: "0.6.2" }])
    );
    const result = checkPluginVersion();
    expect(result).toEqual({ s: "outdated", v: "0.6.2", r: MIN_PLUGIN_VERSION });
  });

  // ---------------------------------------------------------------------------
  // Multiple scope entries — prefers user
  // ---------------------------------------------------------------------------
  it("uses scope=user entry when both user and local exist", () => {
    vi.mocked(readFileSync).mockReturnValue(
      makeInstalledPlugins([
        { scope: "local", version: "0.5.0" },
        { scope: "user", version: "0.9.1" },
      ])
    );
    const result = checkPluginVersion();
    expect(result).toEqual({ s: "ok", v: "0.9.1" });
  });

  // ---------------------------------------------------------------------------
  // Only local scope — falls back to first entry
  // ---------------------------------------------------------------------------
  it("falls back to first entry when no user scope exists", () => {
    vi.mocked(readFileSync).mockReturnValue(
      makeInstalledPlugins([{ scope: "local", version: "0.6.0" }])
    );
    const result = checkPluginVersion();
    expect(result).toEqual({ s: "outdated", v: "0.6.0", r: MIN_PLUGIN_VERSION });
  });

  // ---------------------------------------------------------------------------
  // Unparseable version string (e.g. "unknown")
  // ---------------------------------------------------------------------------
  it("returns null when version string is unparseable", () => {
    vi.mocked(readFileSync).mockReturnValue(
      makeInstalledPlugins([{ scope: "user", version: "unknown" }])
    );
    const result = checkPluginVersion();
    expect(result).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Exact minimum version
  // ---------------------------------------------------------------------------
  it("returns ok when version exactly matches minimum", () => {
    vi.mocked(readFileSync).mockReturnValue(
      makeInstalledPlugins([{ scope: "user", version: "0.9.0" }])
    );
    const result = checkPluginVersion();
    expect(result).toEqual({ s: "ok", v: "0.9.0" });
  });

  // ---------------------------------------------------------------------------
  // Dev plugin key (mthds-dev@mthds-plugins)
  // ---------------------------------------------------------------------------
  it("finds the plugin under the dev key when prod key is absent", () => {
    const data = JSON.stringify({
      version: 2,
      plugins: {
        [PLUGIN_KEYS[1]]: [
          { scope: "user", version: "0.6.0", installPath: "/tmp" },
        ],
      },
    });
    vi.mocked(readFileSync).mockReturnValue(data);
    const result = checkPluginVersion();
    expect(result).toEqual({ s: "outdated", v: "0.6.0", r: MIN_PLUGIN_VERSION });
  });

  // ---------------------------------------------------------------------------
  // Prod key takes precedence over dev key
  // ---------------------------------------------------------------------------
  it("prefers prod key when both prod and dev keys exist", () => {
    const data = JSON.stringify({
      version: 2,
      plugins: {
        [PLUGIN_KEYS[0]]: [
          { scope: "user", version: "0.9.1", installPath: "/tmp" },
        ],
        [PLUGIN_KEYS[1]]: [
          { scope: "user", version: "0.1.0", installPath: "/tmp" },
        ],
      },
    });
    vi.mocked(readFileSync).mockReturnValue(data);
    const result = checkPluginVersion();
    expect(result).toEqual({ s: "ok", v: "0.9.1" });
  });
});
