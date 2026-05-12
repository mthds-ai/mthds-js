import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Filesystem mock ──────────────────────────────────────────────────
//
// We control all fs reads consumed by plugin-version.ts:
//   - existsSync          — used by detectHost()
//   - readFileSync        — used by Claude reader + Codex manifest reader
//   - readdirSync         — used by Codex reader
//   - statSync            — used by Codex reader to filter directories
//
// Each test sets `fsState` to describe the world it wants. Mocks dispatch
// through that state. Anything not configured throws ENOENT.

interface FakeStat {
  isDirectory: () => boolean;
}

interface FsState {
  files: Map<string, string>;
  dirs: Map<string, string[]>; // dir path -> entries
  fileStats: Set<string>;      // paths that statSync should return as non-dir
}

let fsState: FsState;

function enoent(path: string): NodeJS.ErrnoException {
  const err = new Error(`ENOENT: no such file or directory, '${path}'`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    existsSync: vi.fn((p: string): boolean => {
      return fsState.files.has(p) || fsState.dirs.has(p) || fsState.fileStats.has(p);
    }),
    readFileSync: vi.fn((p: string): string => {
      const content = fsState.files.get(p);
      if (content === undefined) throw enoent(p);
      return content;
    }),
    readdirSync: vi.fn((p: string): string[] => {
      const entries = fsState.dirs.get(p);
      if (entries === undefined) throw enoent(p);
      return entries;
    }),
    statSync: vi.fn((p: string): FakeStat => {
      if (fsState.dirs.has(p)) return { isDirectory: () => true };
      if (fsState.fileStats.has(p) || fsState.files.has(p)) {
        return { isDirectory: () => false };
      }
      throw enoent(p);
    }),
  };
});

import { homedir } from "node:os";
import { join } from "node:path";
import {
  checkPluginVersion,
  detectHost,
  INSTALLED_PLUGINS_PATH,
  MIN_PLUGIN_VERSION,
  PLUGIN_KEYS,
  pluginUpdateCommand,
  readCodexPluginVersion,
} from "../../../src/agent/plugin-version.js";

// ── Helpers ──────────────────────────────────────────────────────

function freshState(): FsState {
  return { files: new Map(), dirs: new Map(), fileStats: new Set() };
}

function defaultCodexHome(): string {
  return join(homedir(), ".codex");
}

function codexPluginDir(plugin: string, codexHome?: string): string {
  return join(codexHome ?? defaultCodexHome(), "plugins", "cache", "mthds-plugins", plugin);
}

function codexVersionDir(plugin: string, version: string, codexHome?: string): string {
  return join(codexPluginDir(plugin, codexHome), version);
}

function codexManifestPath(plugin: string, version: string, codexHome?: string): string {
  return join(codexVersionDir(plugin, version, codexHome), ".codex-plugin", "plugin.json");
}

function installPrimaryClaude(version: string, scope = "user"): void {
  fsState.files.set(
    INSTALLED_PLUGINS_PATH,
    JSON.stringify({
      version: 2,
      plugins: {
        [PLUGIN_KEYS[0]]: [{ scope, version, installPath: "/tmp" }],
      },
    })
  );
}

function installCodexPlugin(
  plugin: string,
  versions: string[],
  opts: { manifestVersion?: string; codexHome?: string } = {}
): void {
  // Ensure the cache parent dir registers as "exists" — detectHost requires it.
  const cacheParent = join(opts.codexHome ?? defaultCodexHome(), "plugins", "cache");
  if (!fsState.dirs.has(cacheParent)) fsState.dirs.set(cacheParent, ["mthds-plugins"]);
  const dir = codexPluginDir(plugin, opts.codexHome);
  fsState.dirs.set(dir, versions);
  for (const v of versions) {
    fsState.dirs.set(codexVersionDir(plugin, v, opts.codexHome), [".codex-plugin"]);
    fsState.dirs.set(
      join(codexVersionDir(plugin, v, opts.codexHome), ".codex-plugin"),
      ["plugin.json"]
    );
    const manifest: Record<string, unknown> = {};
    if (opts.manifestVersion) manifest.version = opts.manifestVersion;
    else if (v !== "local") manifest.version = v;
    fsState.files.set(codexManifestPath(plugin, v, opts.codexHome), JSON.stringify(manifest));
  }
}

// ── Tests ──────────────────────────────────────────────────────────

const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME;
const ORIGINAL_CLAUDECODE = process.env.CLAUDECODE;

beforeEach(() => {
  fsState = freshState();
  delete process.env.CODEX_HOME;
  // Tests assume "no host hints" by default; opt in per test.
  delete process.env.CLAUDECODE;
});

afterEach(() => {
  vi.clearAllMocks();
  if (ORIGINAL_CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = ORIGINAL_CODEX_HOME;
  if (ORIGINAL_CLAUDECODE === undefined) delete process.env.CLAUDECODE;
  else process.env.CLAUDECODE = ORIGINAL_CLAUDECODE;
});

// ── detectHost ────────────────────────────────────────────────────

describe("detectHost", () => {
  it("returns null when neither host is detectable", () => {
    expect(detectHost()).toBeNull();
  });

  it("returns 'codex' when ~/.codex/plugins/cache exists", () => {
    fsState.dirs.set(join(defaultCodexHome(), "plugins", "cache"), []);
    expect(detectHost()).toBe("codex");
  });

  it("returns 'codex' from a custom $CODEX_HOME with a cache dir", () => {
    process.env.CODEX_HOME = "/custom/codex";
    fsState.dirs.set(join("/custom/codex", "plugins", "cache"), []);
    expect(detectHost()).toBe("codex");
  });

  it("does NOT return 'codex' when $CODEX_HOME is set but no cache dir exists", () => {
    // Defends against users who set CODEX_HOME in their shell profile while
    // running mthds-agent from Claude Code. Picking "codex" here would emit a
    // spurious "missing" warning and a wrong upgrade command.
    process.env.CODEX_HOME = "/custom/codex";
    installPrimaryClaude("0.10.2");
    expect(detectHost()).toBe("claude");
  });

  it("returns 'claude' when only Claude registry exists", () => {
    installPrimaryClaude("0.10.2");
    expect(detectHost()).toBe("claude");
  });

  it("prefers 'codex' when both Codex cache and Claude registry exist and CLAUDECODE is unset", () => {
    fsState.dirs.set(join(defaultCodexHome(), "plugins", "cache"), []);
    installPrimaryClaude("0.10.2");
    expect(detectHost()).toBe("codex");
  });

  it("returns 'claude' when CLAUDECODE=1 even if Codex cache exists too", () => {
    // CLAUDECODE=1 is only set by Claude Code at runtime (not in user shell
    // profiles), so it's a stronger signal than filesystem state alone when
    // both hosts are installed on the same machine.
    process.env.CLAUDECODE = "1";
    fsState.dirs.set(join(defaultCodexHome(), "plugins", "cache"), []);
    installPrimaryClaude("0.10.2");
    expect(detectHost()).toBe("claude");
  });

  it("ignores CLAUDECODE=1 when Claude registry is absent", () => {
    // CLAUDECODE alone doesn't conjure a Claude install. If only the Codex
    // cache exists on disk, that's still where we'd find the plugin.
    process.env.CLAUDECODE = "1";
    fsState.dirs.set(join(defaultCodexHome(), "plugins", "cache"), []);
    expect(detectHost()).toBe("codex");
  });
});

// ── pluginUpdateCommand ───────────────────────────────────────────

describe("pluginUpdateCommand", () => {
  it("returns the Codex slash command for the codex host", () => {
    expect(pluginUpdateCommand("codex")).toBe("/plugins install mthds");
  });

  it("returns the claude shell command for the claude host", () => {
    expect(pluginUpdateCommand("claude")).toBe(
      "claude plugin install mthds@mthds-plugins"
    );
  });

});

// ── checkPluginVersion — Claude branch ────────────────────────────

describe("checkPluginVersion (Claude)", () => {
  it("returns ok when plugin version satisfies constraint", () => {
    installPrimaryClaude("0.10.2");
    expect(checkPluginVersion("claude")).toEqual({ s: "ok", v: "0.10.2" });
  });

  it("returns outdated when plugin version is below minimum", () => {
    installPrimaryClaude("0.6.2");
    expect(checkPluginVersion("claude")).toEqual({
      s: "outdated",
      v: "0.6.2",
      r: MIN_PLUGIN_VERSION,
    });
  });

  it("returns missing when plugin key is absent", () => {
    fsState.files.set(
      INSTALLED_PLUGINS_PATH,
      JSON.stringify({ version: 2, plugins: {} })
    );
    expect(checkPluginVersion("claude")).toEqual({
      s: "missing",
      v: null,
      r: MIN_PLUGIN_VERSION,
    });
  });

  it("returns missing when plugin key has empty entries", () => {
    fsState.files.set(
      INSTALLED_PLUGINS_PATH,
      JSON.stringify({ version: 2, plugins: { [PLUGIN_KEYS[0]]: [] } })
    );
    expect(checkPluginVersion("claude")).toEqual({
      s: "missing",
      v: null,
      r: MIN_PLUGIN_VERSION,
    });
  });

  it("returns null when JSON is corrupt", () => {
    fsState.files.set(INSTALLED_PLUGINS_PATH, "not valid json{{{");
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(checkPluginVersion("claude")).toBeNull();
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("contains invalid JSON")
    );
    stderrSpy.mockRestore();
  });

  it("returns null for unparseable version strings", () => {
    installPrimaryClaude("unknown");
    expect(checkPluginVersion("claude")).toBeNull();
  });

  it("prefers scope=user entry when both user and local exist", () => {
    fsState.files.set(
      INSTALLED_PLUGINS_PATH,
      JSON.stringify({
        version: 2,
        plugins: {
          [PLUGIN_KEYS[0]]: [
            { scope: "local", version: "0.5.0", installPath: "/tmp" },
            { scope: "user", version: "0.10.2", installPath: "/tmp" },
          ],
        },
      })
    );
    expect(checkPluginVersion("claude")).toEqual({ s: "ok", v: "0.10.2" });
  });

  it("finds the plugin under the dev key when prod key is absent", () => {
    fsState.files.set(
      INSTALLED_PLUGINS_PATH,
      JSON.stringify({
        version: 2,
        plugins: {
          [PLUGIN_KEYS[1]]: [{ scope: "user", version: "0.6.0", installPath: "/tmp" }],
        },
      })
    );
    expect(checkPluginVersion("claude")).toEqual({
      s: "outdated",
      v: "0.6.0",
      r: MIN_PLUGIN_VERSION,
    });
  });

  it("prefers prod key when both prod and dev keys exist", () => {
    fsState.files.set(
      INSTALLED_PLUGINS_PATH,
      JSON.stringify({
        version: 2,
        plugins: {
          [PLUGIN_KEYS[0]]: [{ scope: "user", version: "0.10.2", installPath: "/tmp" }],
          [PLUGIN_KEYS[1]]: [{ scope: "user", version: "0.1.0", installPath: "/tmp" }],
        },
      })
    );
    expect(checkPluginVersion("claude")).toEqual({ s: "ok", v: "0.10.2" });
  });
});

// ── checkPluginVersion — Codex branch ─────────────────────────────

describe("checkPluginVersion (Codex)", () => {
  it("returns ok when a satisfying version is installed", () => {
    installCodexPlugin("mthds", ["0.10.2"]);
    expect(checkPluginVersion("codex")).toEqual({ s: "ok", v: "0.10.2" });
  });

  it("picks the highest version directory when multiple are installed", () => {
    installCodexPlugin("mthds", ["0.9.0", "0.10.2", "0.8.3"]);
    expect(checkPluginVersion("codex")).toEqual({ s: "ok", v: "0.10.2" });
  });

  it("returns outdated when only an old version is installed", () => {
    installCodexPlugin("mthds", ["0.6.2"]);
    expect(checkPluginVersion("codex")).toEqual({
      s: "outdated",
      v: "0.6.2",
      r: MIN_PLUGIN_VERSION,
    });
  });

  it("returns null when 'local' dev sentinel is present", () => {
    installCodexPlugin("mthds", ["local", "0.10.2"]);
    expect(checkPluginVersion("codex")).toBeNull();
  });

  it("returns missing when no plugin dir exists under the codex cache", () => {
    expect(checkPluginVersion("codex")).toEqual({
      s: "missing",
      v: null,
      r: MIN_PLUGIN_VERSION,
    });
  });

  it("returns missing when the plugin dir is empty", () => {
    fsState.dirs.set(codexPluginDir("mthds"), []);
    fsState.dirs.set(codexPluginDir("mthds-dev"), []);
    expect(checkPluginVersion("codex")).toEqual({
      s: "missing",
      v: null,
      r: MIN_PLUGIN_VERSION,
    });
  });

  it("ignores dotfile entries when picking a version", () => {
    fsState.dirs.set(codexPluginDir("mthds"), [".DS_Store", "0.10.2"]);
    fsState.dirs.set(codexVersionDir("mthds", "0.10.2"), [".codex-plugin"]);
    fsState.dirs.set(
      join(codexVersionDir("mthds", "0.10.2"), ".codex-plugin"),
      ["plugin.json"]
    );
    fsState.files.set(
      codexManifestPath("mthds", "0.10.2"),
      JSON.stringify({ version: "0.10.2" })
    );
    expect(checkPluginVersion("codex")).toEqual({ s: "ok", v: "0.10.2" });
  });

  it("prefers the prod plugin name over mthds-dev", () => {
    installCodexPlugin("mthds", ["0.10.2"]);
    installCodexPlugin("mthds-dev", ["0.1.0"]);
    expect(checkPluginVersion("codex")).toEqual({ s: "ok", v: "0.10.2" });
  });

  it("falls back to mthds-dev when prod is absent", () => {
    installCodexPlugin("mthds-dev", ["0.10.2"]);
    expect(checkPluginVersion("codex")).toEqual({ s: "ok", v: "0.10.2" });
  });

  it("prefers the manifest version over the directory name", () => {
    installCodexPlugin("mthds", ["0.10.2"], { manifestVersion: "0.10.5" });
    expect(checkPluginVersion("codex")).toEqual({ s: "ok", v: "0.10.5" });
  });

  it("falls back to the directory name when the manifest is unreadable", () => {
    // Set up everything but the manifest file content.
    fsState.dirs.set(codexPluginDir("mthds"), ["0.10.2"]);
    fsState.dirs.set(codexVersionDir("mthds", "0.10.2"), [".codex-plugin"]);
    expect(checkPluginVersion("codex")).toEqual({ s: "ok", v: "0.10.2" });
  });

  it("respects $CODEX_HOME when set", () => {
    const customHome = "/custom/codex";
    process.env.CODEX_HOME = customHome;
    installCodexPlugin("mthds", ["0.10.2"], { codexHome: customHome });
    expect(checkPluginVersion("codex")).toEqual({ s: "ok", v: "0.10.2" });
  });
});

// ── readCodexPluginVersion direct ─────────────────────────────────

describe("readCodexPluginVersion", () => {
  it("returns missing when no plugin dirs exist", () => {
    expect(readCodexPluginVersion()).toEqual({ kind: "missing" });
  });

  it("returns null when only 'local' sentinel is present", () => {
    fsState.dirs.set(codexPluginDir("mthds"), ["local"]);
    fsState.dirs.set(codexVersionDir("mthds", "local"), [".codex-plugin"]);
    expect(readCodexPluginVersion()).toEqual({ kind: "null" });
  });

  it("falls back to mthds-dev when mthds has only non-semver dirs", () => {
    // Regression: previously the function returned { kind: "null" } as soon
    // as mthds had only unparseable version dirs, skipping the mthds-dev
    // fallback entirely. If a future Codex build writes an unrecognized
    // version format, we'd miss a valid mthds-dev install.
    fsState.dirs.set(codexPluginDir("mthds"), ["weird-format"]);
    fsState.dirs.set(codexVersionDir("mthds", "weird-format"), [".codex-plugin"]);
    installCodexPlugin("mthds-dev", ["0.10.2"]);
    expect(readCodexPluginVersion()).toEqual({ kind: "version", version: "0.10.2" });
  });

  it("returns null when every plugin dir has only non-semver entries", () => {
    fsState.dirs.set(codexPluginDir("mthds"), ["weird-format"]);
    fsState.dirs.set(codexVersionDir("mthds", "weird-format"), [".codex-plugin"]);
    fsState.dirs.set(codexPluginDir("mthds-dev"), ["alsoweird"]);
    fsState.dirs.set(codexVersionDir("mthds-dev", "alsoweird"), [".codex-plugin"]);
    expect(readCodexPluginVersion()).toEqual({ kind: "null" });
  });

  it("returns null (not missing) when a plugin dir is unreadable for a non-ENOENT reason", async () => {
    // We can't set fsState entries — we need readdirSync to throw EACCES.
    // Override the mock directly for this test.
    const fs = await import("node:fs");
    const original = vi.mocked(fs.readdirSync).getMockImplementation();
    vi.mocked(fs.readdirSync).mockImplementation((p: unknown): string[] => {
      if (String(p).includes(join("plugins", "cache", "mthds-plugins", "mthds"))) {
        const err = new Error(`EACCES: ${String(p)}`) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      if (original) return original(p as Parameters<typeof fs.readdirSync>[0]) as string[];
      const err = new Error(`ENOENT: ${String(p)}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(readCodexPluginVersion()).toEqual({ kind: "null" });
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("could not read Codex plugin dir")
    );
    stderrSpy.mockRestore();
  });
});
