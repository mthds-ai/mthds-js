import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMthdsFiles,
  formatLintError,
  formatFmtError,
  buildBlockPayload,
  buildPathCandidates,
  commandOnPath,
  runCodexHook,
} from "../../../src/agent/commands/codex-hook.js";

// Pure helpers ────────────────────────────────────────────────────────

describe("parseMthdsFiles", () => {
  it("extracts a single Update File path", () => {
    const env = `*** Begin Patch
*** Update File: bundles/core.mthds
@@
- foo
+ bar
*** End Patch`;
    expect(parseMthdsFiles(env)).toEqual(["bundles/core.mthds"]);
  });

  it("extracts Add File and Move to destinations", () => {
    const env = `*** Begin Patch
*** Add File: a.mthds
*** Move to: b/c.mthds
*** End Patch`;
    expect(parseMthdsFiles(env).sort()).toEqual(["a.mthds", "b/c.mthds"]);
  });

  it("ignores non-.mthds files", () => {
    const env = `*** Update File: foo.py
*** Add File: bar.mthds`;
    expect(parseMthdsFiles(env)).toEqual(["bar.mthds"]);
  });

  it("ignores Delete File and Move from headers", () => {
    // Delete File: target is gone post-patch — should be skipped.
    // Move from: source is gone — should be skipped (Move to: catches the dest).
    const env = `*** Delete File: gone.mthds
*** Move from: old.mthds
*** Move to: new.mthds`;
    expect(parseMthdsFiles(env)).toEqual(["new.mthds"]);
  });

  it("deduplicates the same path mentioned twice", () => {
    const env = `*** Update File: same.mthds
*** Add File: same.mthds`;
    expect(parseMthdsFiles(env)).toEqual(["same.mthds"]);
  });

  it("returns empty for an envelope with no .mthds files", () => {
    expect(parseMthdsFiles("*** Update File: src/foo.ts")).toEqual([]);
  });
});

describe("formatLintError", () => {
  it("prefers stderr over stdout when both are present", () => {
    const msg = formatLintError("a.mthds", { exitCode: 1, stdout: "out", stderr: "err" });
    expect(msg).toContain("a.mthds");
    expect(msg).toContain("err");
    expect(msg).not.toContain("out");
  });

  it("falls back to stdout when stderr is empty", () => {
    const msg = formatLintError("a.mthds", { exitCode: 1, stdout: "out", stderr: "" });
    expect(msg).toContain("out");
  });

  it("synthesises a placeholder when both streams are empty", () => {
    const msg = formatLintError("a.mthds", { exitCode: 2, stdout: "", stderr: "" });
    expect(msg).toContain("exited with code 2");
  });
});

describe("formatFmtError", () => {
  it("includes the exit code in the message", () => {
    const msg = formatFmtError("a.mthds", { exitCode: 3, stdout: "", stderr: "boom" });
    expect(msg).toContain("exit 3");
    expect(msg).toContain("boom");
  });

  it("falls back to stdout when stderr is empty", () => {
    const msg = formatFmtError("a.mthds", {
      exitCode: 4,
      stdout: "stdout-diagnostic",
      stderr: "",
    });
    expect(msg).toContain("stdout-diagnostic");
    expect(msg).not.toContain("no output");
  });

  it("synthesises a placeholder when both streams are empty", () => {
    const msg = formatFmtError("a.mthds", { exitCode: 5, stdout: "", stderr: "" });
    expect(msg).toContain("exited with code 5");
  });
});

describe("buildBlockPayload", () => {
  it("emits valid Codex hook block JSON with a trailing newline", () => {
    const out = buildBlockPayload("nope");
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out.trim());
    expect(parsed).toEqual({ decision: "block", reason: "nope" });
  });
});

// PATH lookup ──────────────────────────────────────────────────────────

describe("buildPathCandidates", () => {
  it("returns empty when PATH is empty", () => {
    expect(buildPathCandidates("plxt", "", "linux", undefined)).toEqual([]);
  });

  it("on POSIX yields one candidate per PATH dir, no extension applied", () => {
    expect(
      buildPathCandidates("plxt", "/usr/local/bin:/usr/bin", "linux", undefined)
    ).toEqual(["/usr/local/bin/plxt", "/usr/bin/plxt"]);
  });

  it("on POSIX ignores PATHEXT even when set", () => {
    expect(
      buildPathCandidates("plxt", "/bin", "darwin", ".EXE;.CMD")
    ).toEqual(["/bin/plxt"]);
  });

  it("on POSIX skips empty PATH segments", () => {
    expect(buildPathCandidates("plxt", "/a::/b", "linux", undefined)).toEqual([
      "/a/plxt",
      "/b/plxt",
    ]);
  });

  it("on POSIX handles a directory with a trailing separator", () => {
    expect(buildPathCandidates("plxt", "/a/", "linux", undefined)).toEqual([
      "/a/plxt",
    ]);
  });

  it("on Windows applies each PATHEXT extension and excludes the bare name", () => {
    const candidates = buildPathCandidates(
      "plxt",
      "C:\\bin;D:\\tools",
      "win32",
      ".COM;.EXE;.CMD"
    );
    expect(candidates).toEqual([
      "C:\\bin\\plxt.COM",
      "C:\\bin\\plxt.EXE",
      "C:\\bin\\plxt.CMD",
      "D:\\tools\\plxt.COM",
      "D:\\tools\\plxt.EXE",
      "D:\\tools\\plxt.CMD",
    ]);
    expect(candidates).not.toContain("C:\\bin\\plxt");
  });

  it("on Windows falls back to a sensible PATHEXT default when unset", () => {
    expect(
      buildPathCandidates("plxt", "C:\\bin", "win32", undefined)
    ).toEqual([
      "C:\\bin\\plxt.COM",
      "C:\\bin\\plxt.EXE",
      "C:\\bin\\plxt.BAT",
      "C:\\bin\\plxt.CMD",
    ]);
  });

  it("on Windows treats a directory with a trailing backslash without doubling the separator", () => {
    expect(
      buildPathCandidates("plxt", "C:\\bin\\", "win32", ".EXE")
    ).toEqual(["C:\\bin\\plxt.EXE"]);
  });
});

describe("commandOnPath", () => {
  const isWindows = process.platform === "win32";
  let scratch: string | undefined;
  let originalPath: string | undefined;

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
    originalPath = undefined;
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
      scratch = undefined;
    }
  });

  it.skipIf(isWindows)(
    "returns false when a file with the right name exists but lacks the executable bit",
    () => {
      // Regression: an earlier implementation only called statSync().isFile(),
      // which lets a non-executable file shadow a real CLI and surfaces as a
      // confusing 127 from spawnSync rather than the clean "Missing required
      // CLI tool" block.
      scratch = mkdtempSync(join(tmpdir(), "mthds-cmdpath-"));
      const file = join(scratch, "plxt");
      writeFileSync(file, "#!/bin/sh\necho hi\n");
      chmodSync(file, 0o644); // not executable
      originalPath = process.env.PATH;
      process.env.PATH = scratch;

      expect(commandOnPath("plxt")).toBe(false);
    }
  );

  it.skipIf(isWindows)("returns true when the file is marked executable", () => {
    scratch = mkdtempSync(join(tmpdir(), "mthds-cmdpath-"));
    const file = join(scratch, "plxt");
    writeFileSync(file, "#!/bin/sh\necho hi\n");
    chmodSync(file, 0o755);
    originalPath = process.env.PATH;
    process.env.PATH = scratch;

    expect(commandOnPath("plxt")).toBe(true);
  });

  it("returns false when PATH is empty", () => {
    originalPath = process.env.PATH;
    process.env.PATH = "";
    expect(commandOnPath("plxt")).toBe(false);
  });
});

// runCodexHook (dependency-injected) ─────────────────────────────────

interface FakePlxtCall {
  args: string[];
}

function makeDeps(overrides: {
  stdin: string;
  files?: Set<string>;
  hasPlxt?: boolean;
  plxtResults?: Map<string, { exitCode: number; stdout?: string; stderr?: string }>;
}) {
  const calls: FakePlxtCall[] = [];
  const emitted: string[] = [];
  const deps = {
    readStdin: () => overrides.stdin,
    fileExists: (p: string) => (overrides.files ?? new Set()).has(p),
    hasPlxt: () => overrides.hasPlxt ?? true,
    runPlxt: (args: string[]) => {
      calls.push({ args });
      const key = args.join(" ");
      const cfg = overrides.plxtResults?.get(key);
      return {
        exitCode: cfg?.exitCode ?? 0,
        stdout: cfg?.stdout ?? "",
        stderr: cfg?.stderr ?? "",
      };
    },
    emit: (s: string) => emitted.push(s),
  };
  return { deps, calls, emitted };
}

const PAYLOAD = (envelope: string) =>
  JSON.stringify({ tool_input: { command: envelope } });

describe("runCodexHook", () => {
  it("silently passes on empty stdin", async () => {
    const { deps, emitted } = makeDeps({ stdin: "" });
    await runCodexHook(deps);
    expect(emitted).toEqual([]);
  });

  it("silently passes on malformed JSON", async () => {
    const { deps, emitted } = makeDeps({ stdin: "{not json" });
    await runCodexHook(deps);
    expect(emitted).toEqual([]);
  });

  it("silently passes when tool_input.command is missing", async () => {
    const { deps, emitted } = makeDeps({ stdin: JSON.stringify({ tool_input: {} }) });
    await runCodexHook(deps);
    expect(emitted).toEqual([]);
  });

  it("silently passes when no .mthds files are touched", async () => {
    const { deps, emitted } = makeDeps({
      stdin: PAYLOAD("*** Update File: src/foo.ts"),
    });
    await runCodexHook(deps);
    expect(emitted).toEqual([]);
  });

  it("blocks when plxt is missing", async () => {
    const { deps, emitted } = makeDeps({
      stdin: PAYLOAD("*** Update File: a.mthds"),
      hasPlxt: false,
      files: new Set(["a.mthds"]),
    });
    await runCodexHook(deps);
    expect(emitted).toHaveLength(1);
    const parsed = JSON.parse(emitted[0]!.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("plxt");
  });

  it("skips files that don't exist on disk (renamed sources, deletes)", async () => {
    const { deps, emitted, calls } = makeDeps({
      stdin: PAYLOAD("*** Update File: gone.mthds"),
      files: new Set(), // file absent
    });
    await runCodexHook(deps);
    expect(calls).toEqual([]);
    expect(emitted).toEqual([]);
  });

  it("passes silently when lint and fmt succeed", async () => {
    const { deps, emitted, calls } = makeDeps({
      stdin: PAYLOAD("*** Update File: a.mthds"),
      files: new Set(["a.mthds"]),
    });
    await runCodexHook(deps);
    expect(calls.map((c) => c.args)).toEqual([
      ["lint", "--quiet", "a.mthds"],
      ["fmt", "a.mthds"],
    ]);
    expect(emitted).toEqual([]);
  });

  it("blocks on lint failure and skips fmt for that file", async () => {
    const plxtResults = new Map([
      ["lint --quiet a.mthds", { exitCode: 1, stderr: "schema error" }],
    ]);
    const { deps, emitted, calls } = makeDeps({
      stdin: PAYLOAD("*** Update File: a.mthds"),
      files: new Set(["a.mthds"]),
      plxtResults,
    });
    await runCodexHook(deps);
    expect(calls.map((c) => c.args)).toEqual([["lint", "--quiet", "a.mthds"]]);
    expect(emitted).toHaveLength(1);
    const parsed = JSON.parse(emitted[0]!.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("a.mthds");
    expect(parsed.reason).toContain("schema error");
  });

  it("blocks on fmt failure when lint passed", async () => {
    const plxtResults = new Map([
      ["fmt a.mthds", { exitCode: 1, stderr: "fmt boom" }],
    ]);
    const { deps, emitted } = makeDeps({
      stdin: PAYLOAD("*** Update File: a.mthds"),
      files: new Set(["a.mthds"]),
      plxtResults,
    });
    await runCodexHook(deps);
    expect(emitted).toHaveLength(1);
    const parsed = JSON.parse(emitted[0]!.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("plxt fmt failed on a.mthds");
    expect(parsed.reason).toContain("fmt boom");
  });

  it("aggregates errors across multiple files in a single block payload", async () => {
    const plxtResults = new Map([
      ["lint --quiet a.mthds", { exitCode: 1, stderr: "err-a" }],
      ["lint --quiet b.mthds", { exitCode: 1, stderr: "err-b" }],
    ]);
    const { deps, emitted } = makeDeps({
      stdin: PAYLOAD("*** Update File: a.mthds\n*** Add File: b.mthds"),
      files: new Set(["a.mthds", "b.mthds"]),
      plxtResults,
    });
    await runCodexHook(deps);
    expect(emitted).toHaveLength(1);
    const parsed = JSON.parse(emitted[0]!.trim());
    expect(parsed.reason).toContain("err-a");
    expect(parsed.reason).toContain("err-b");
  });
});
