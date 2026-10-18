import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseMthdsFiles,
  formatLintError,
  formatFmtError,
  buildBlockPayload,
  buildAdditionalContextPayload,
  buildPathCandidates,
  classifyStage3Result,
  commandOnPath,
  formatValidationReason,
  parseAgentErrorEnvelope,
  runCodexHook,
  truncateForAdditionalContext,
} from "../../../src/agent/commands/codex-hook.js";
import { buildProblem } from "../../../src/problems/build.js";
import type { Problem } from "../../../src/problems/types.js";

// The envelope a pipelex-agent that predates problem documents writes with
// `--error-format json`, as a string on stderr.
function errorEnvelope(fields: Record<string, unknown>): string {
  return JSON.stringify({ error: true, ...fields });
}

// A pipelex-agent that writes problem documents writes the problem's JSON form instead.
function problemEnvelope(problem: Problem): string {
  return JSON.stringify(problem);
}

// An invalid bundle as a problem: `method.invalid` holding one item per fault.
const UNKNOWN_MODEL_ITEM = {
  code: "model.unknown",
  detail: "Model handle 'gpt-5.1' was not found in the model deck. Did you mean: gpt-5?",
  params: { model: "gpt-5.1", model_type: "llm", suggestions: ["gpt-5"] },
  location: { pipe: "summarize", field: "model", file: "bundles/x.mthds" },
  suggested_fix: {
    fix_code: "rename-model",
    description:
      "Replace model 'gpt-5.1' of pipe 'summarize' with 'gpt-5', its one close match in the model deck",
    safety: "unsafe",
    ops: [
      {
        kind: "remap_value",
        table_path: ["pipe", "summarize"],
        key: "model",
        mapping: { "gpt-5.1": "gpt-5" },
      },
    ],
  },
};

const MISSING_PIPE_ITEM = {
  code: "method.pipe_unresolved",
  detail: "The pipe 'main' calls 'demo.summarise', which no bundle declares.",
  params: { pipe: "main", missing: "demo.summarise", candidates: [] },
  location: { pipe: "main" },
};

const INVALID_METHOD_PROBLEM = buildProblem(
  "method.invalid",
  {},
  {
    reader: "actor",
    errors: [UNKNOWN_MODEL_ITEM, MISSING_PIPE_ITEM],
    extra: { message: "Validation error(s) in the bundle", is_valid: false },
  },
);

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
    expect(buildPathCandidates("plxt", "/usr/local/bin:/usr/bin", "linux", undefined)).toEqual([
      "/usr/local/bin/plxt",
      "/usr/bin/plxt",
    ]);
  });

  it("on POSIX ignores PATHEXT even when set", () => {
    expect(buildPathCandidates("plxt", "/bin", "darwin", ".EXE;.CMD")).toEqual(["/bin/plxt"]);
  });

  it("on POSIX skips empty PATH segments", () => {
    expect(buildPathCandidates("plxt", "/a::/b", "linux", undefined)).toEqual([
      "/a/plxt",
      "/b/plxt",
    ]);
  });

  it("on POSIX handles a directory with a trailing separator", () => {
    expect(buildPathCandidates("plxt", "/a/", "linux", undefined)).toEqual(["/a/plxt"]);
  });

  it("on Windows applies each PATHEXT extension and excludes the bare name", () => {
    const candidates = buildPathCandidates("plxt", "C:\\bin;D:\\tools", "win32", ".COM;.EXE;.CMD");
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
    expect(buildPathCandidates("plxt", "C:\\bin", "win32", undefined)).toEqual([
      "C:\\bin\\plxt.COM",
      "C:\\bin\\plxt.EXE",
      "C:\\bin\\plxt.BAT",
      "C:\\bin\\plxt.CMD",
    ]);
  });

  it("on Windows treats a directory with a trailing backslash without doubling the separator", () => {
    expect(buildPathCandidates("plxt", "C:\\bin\\", "win32", ".EXE")).toEqual([
      "C:\\bin\\plxt.EXE",
    ]);
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
    },
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

interface FakePipelexCall {
  file: string;
  libraryDir: string;
}

function makeDeps(overrides: {
  stdin: string;
  files?: Set<string>;
  hasPlxt?: boolean;
  plxtResults?: Map<string, { exitCode: number; stdout?: string; stderr?: string }>;
  hasPipelexAgent?: boolean;
  // Keyed by file path → validate result. Missing entry means exit 0 (pass).
  pipelexResults?: Map<string, { exitCode: number; stderr?: string }>;
}) {
  const calls: FakePlxtCall[] = [];
  const pipelexCalls: FakePipelexCall[] = [];
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
    hasPipelexAgent: () => overrides.hasPipelexAgent ?? true,
    runPipelexValidate: (file: string, libraryDir: string) => {
      pipelexCalls.push({ file, libraryDir });
      const cfg = overrides.pipelexResults?.get(file);
      return { exitCode: cfg?.exitCode ?? 0, stderr: cfg?.stderr ?? "" };
    },
    emit: (s: string) => emitted.push(s),
  };
  return { deps, calls, pipelexCalls, emitted };
}

const PAYLOAD = (envelope: string) => JSON.stringify({ tool_input: { command: envelope } });

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
    const plxtResults = new Map([["fmt a.mthds", { exitCode: 1, stderr: "fmt boom" }]]);
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

// Stage 3 pure helpers ────────────────────────────────────────────────

describe("parseAgentErrorEnvelope", () => {
  it("parses the JSON error envelope into an object", () => {
    const env = parseAgentErrorEnvelope(
      errorEnvelope({ is_valid: false, error_domain: "input", message: "bad" }),
    );
    expect(env?.error_domain).toBe("input");
    expect(env?.is_valid).toBe(false);
    expect(env?.message).toBe("bad");
  });

  it("returns undefined on empty input", () => {
    expect(parseAgentErrorEnvelope("")).toBeUndefined();
    expect(parseAgentErrorEnvelope("   \n ")).toBeUndefined();
  });

  it("returns undefined on non-JSON input (e.g. a raw traceback)", () => {
    expect(parseAgentErrorEnvelope("Traceback (most recent call last): ...")).toBeUndefined();
  });

  it("returns undefined on a JSON scalar (not an object)", () => {
    expect(parseAgentErrorEnvelope("42")).toBeUndefined();
  });

  it("returns undefined on a JSON array", () => {
    expect(parseAgentErrorEnvelope("[1, 2]")).toBeUndefined();
  });

  it("parses a problem document whole", () => {
    const env = parseAgentErrorEnvelope(problemEnvelope(INVALID_METHOD_PROBLEM));
    expect(env?.code).toBe("method.invalid");
    expect(env?.errors).toEqual([UNKNOWN_MODEL_ITEM, MISSING_PIPE_ITEM]);
  });
});

describe("formatValidationReason", () => {
  it("formats the message + validation_errors list", () => {
    const reason = formatValidationReason(
      "x.mthds",
      {
        message: "Invalid",
        validation_errors: [{ category: "pipe_validation", message: "bad ref", pipe_code: "p" }],
      },
      "fallback",
    );
    expect(reason).toContain("Invalid");
    expect(reason).toContain("[pipe_validation] bad ref");
    expect(reason).toContain("pipe: p");
  });

  it("does not crash when validation_errors is a non-array (malformed / version-skewed envelope)", () => {
    const reason = formatValidationReason(
      "x.mthds",
      { message: "Invalid", validation_errors: { not: "an array" } as never },
      "fallback",
    );
    expect(reason).toBe("Validation failed for x.mthds:\n\nInvalid");
  });

  it("does not crash on a non-string message (version-skewed envelope) — falls back", () => {
    const reason = formatValidationReason("x.mthds", { message: 42 as never }, "fallback");
    expect(reason).toBe("Validation failed for x.mthds:\n\nfallback");
  });

  it("does not crash on null / non-object items in validation_errors", () => {
    const reason = formatValidationReason(
      "x.mthds",
      {
        message: "Invalid",
        validation_errors: [
          null,
          "nope",
          { category: "pipe_validation", message: "real" },
        ] as never,
      },
      "fallback",
    );
    expect(reason).toContain("[pipe_validation] real");
    expect(reason).not.toContain("nope");
  });

  it("prints an item's suggested fix under it, and the pipe it found missing", () => {
    const reason = formatValidationReason(
      "x.mthds",
      {
        message: "Invalid",
        validation_errors: [
          {
            category: "pipe_validation",
            message: "Model handle 'gpt-5.1' was not found in the model deck.",
            pipe_code: "summarize",
            field_name: "model",
            source: "x.mthds",
            suggested_fix: {
              description: "Replace model 'gpt-5.1' of pipe 'summarize' with 'gpt-5'",
            },
          },
          {
            category: "pipe_validation",
            message: "Pipe 'demo.main' refers to 'summarise', which no bundle declares.",
            pipe_code: "main",
            missing_pipe_code: "demo.summarise",
          },
        ],
      },
      "fallback",
    );
    expect(reason).toBe(
      [
        "Validation failed for x.mthds:",
        "",
        "Invalid",
        "",
        "- [pipe_validation] Model handle 'gpt-5.1' was not found in the model deck. (pipe: summarize, field: model, source: x.mthds)",
        "  Suggested fix: Replace model 'gpt-5.1' of pipe 'summarize' with 'gpt-5'",
        "- [pipe_validation] Pipe 'demo.main' refers to 'summarise', which no bundle declares. (pipe: main, missing pipe: demo.summarise)",
      ].join("\n"),
    );
  });

  it("does not crash on a malformed suggested_fix (version-skewed envelope)", () => {
    const reason = formatValidationReason(
      "x.mthds",
      {
        message: "Invalid",
        validation_errors: [
          { category: "pipe_validation", message: "a", suggested_fix: null as never },
          { category: "pipe_validation", message: "b", suggested_fix: "rename it" as never },
          {
            category: "pipe_validation",
            message: "c",
            suggested_fix: { description: 42 as never },
          },
        ],
      },
      "fallback",
    );
    expect(reason).not.toContain("Suggested fix");
    expect(reason).toContain("[pipe_validation] c");
  });
});

describe("formatValidationReason — problem documents", () => {
  it("formats the message and each item as `- <code>: <detail> (<location>)`, with its fix", () => {
    const reason = formatValidationReason("bundles/x.mthds", INVALID_METHOD_PROBLEM, "fallback");
    expect(reason).toBe(
      [
        "Validation failed for bundles/x.mthds:",
        "",
        "Validation error(s) in the bundle",
        "",
        "- model.unknown: Model handle 'gpt-5.1' was not found in the model deck. Did you mean: gpt-5? (pipe 'summarize', field 'model', file 'bundles/x.mthds')",
        "  Suggested fix (unsafe, rename-model): Replace model 'gpt-5.1' of pipe 'summarize' with 'gpt-5', its one close match in the model deck",
        "- method.pipe_unresolved: The pipe 'main' calls 'demo.summarise', which no bundle declares. (pipe 'main')",
      ].join("\n"),
    );
  });

  it("falls back to the problem's detail when it carries no message", () => {
    const problem = buildProblem("method.syntax", { finding: "unexpected '='" });
    const reason = formatValidationReason("x.mthds", problem, "fallback");
    expect(reason).toBe(
      "Validation failed for x.mthds:\n\nThe method does not parse (unexpected '=').",
    );
  });

  it("leaves out the items that are not problem items, and a non-array errors member", () => {
    const reason = formatValidationReason(
      "x.mthds",
      {
        ...INVALID_METHOD_PROBLEM,
        errors: [null, 42, { code: "method.syntax" }, MISSING_PIPE_ITEM],
      },
      "fallback",
    );
    expect(reason).toContain("- method.pipe_unresolved:");
    expect(reason).not.toContain("- method.syntax");
    expect(
      formatValidationReason("x.mthds", { ...INVALID_METHOD_PROBLEM, errors: "nope" }, "fallback"),
    ).toBe("Validation failed for x.mthds:\n\nValidation error(s) in the bundle");
  });

  it("does not read a problem's errors through the legacy validation_errors member", () => {
    const reason = formatValidationReason(
      "x.mthds",
      {
        ...buildProblem("method.invalid", {}),
        validation_errors: [{ category: "pipe_validation", message: "legacy item" }],
      },
      "fallback",
    );
    expect(reason).not.toContain("legacy item");
  });
});

describe("truncateForAdditionalContext", () => {
  it("returns input unchanged when within the limit", () => {
    const s = "x".repeat(100);
    expect(truncateForAdditionalContext(s)).toBe(s);
  });

  it("truncates oversized input and appends a `[truncated, …]` marker", () => {
    const s = "x".repeat(12000);
    const out = truncateForAdditionalContext(s);
    expect(out.length).toBeLessThan(s.length);
    expect(out).toContain("[truncated, 2500 chars omitted]");
    // The original payload must end before the marker.
    expect(out.endsWith("[truncated, 2500 chars omitted]")).toBe(true);
  });
});

describe("buildAdditionalContextPayload", () => {
  it("emits valid Codex hook additionalContext JSON with a trailing newline", () => {
    const out = buildAdditionalContextPayload("hello");
    expect(out.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(out.trim());
    expect(parsed).toEqual({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "hello",
      },
    });
  });
});

describe("classifyStage3Result", () => {
  it("returns pass when exit code is 0", () => {
    expect(classifyStage3Result("a.mthds", { exitCode: 0, stderr: "" })).toEqual({
      kind: "pass",
    });
  });

  it("blocks with a generic reason on non-zero exit with empty stderr", () => {
    const out = classifyStage3Result("a.mthds", { exitCode: 2, stderr: "" });
    expect(out.kind).toBe("block");
    if (out.kind !== "block") return;
    expect(out.reason).toContain("a.mthds");
    expect(out.reason).toContain("exited 2");
    expect(out.reason).toContain("no stderr output");
  });

  it("blocks with a generic reason when stderr is not a JSON envelope", () => {
    const out = classifyStage3Result("a.mthds", {
      exitCode: 1,
      stderr: "Traceback (most recent call last): boom\n",
    });
    expect(out.kind).toBe("block");
    if (out.kind !== "block") return;
    expect(out.reason).toContain("a.mthds");
    expect(out.reason).toContain("Traceback");
  });

  it("blocks with the structured message + errors when error_domain is input", () => {
    const stderr = errorEnvelope({
      error_type: "ValidateBundleError",
      is_valid: false,
      error_domain: "input",
      message: "Validation error(s) in the bundle",
      validation_errors: [
        {
          category: "pipe_validation",
          message: "Missing required field 'source'",
          pipe_code: "extract_info",
        },
      ],
    });
    const out = classifyStage3Result("bundles/x.mthds", { exitCode: 1, stderr });
    expect(out.kind).toBe("block");
    if (out.kind !== "block") return;
    expect(out.reason).toContain("bundles/x.mthds");
    expect(out.reason).toContain("Validation error(s) in the bundle");
    expect(out.reason).toContain("Missing required field");
    expect(out.reason).toContain("pipe: extract_info");
  });

  it("blocks with the suggested fix of an unknown model, as pipelex-agent reports it", () => {
    const stderr = errorEnvelope({
      error_type: "ValidateBundleError",
      is_valid: false,
      error_domain: "input",
      message: "Validation error(s) in the bundle",
      validation_errors: [
        {
          category: "pipe_validation",
          error_type: "unknown_model",
          message: "Model handle 'gpt-5.1' was not found in the model deck. Did you mean: gpt-5?",
          pipe_code: "summarize",
          domain_code: "demo",
          source: "bundles/x.mthds",
          field_path: "pipe.summarize.model",
          field_name: "model",
          model_reference: "gpt-5.1",
          model_type: "llm",
          suggestions: ["gpt-5"],
          suggested_fix: {
            fix_code: "rename-model",
            description:
              "Replace model 'gpt-5.1' of pipe 'summarize' with 'gpt-5', its one close match in the model deck",
            safety: "unsafe",
            source: "bundles/x.mthds",
            ops: [
              {
                kind: "remap_value",
                table_path: ["pipe", "summarize"],
                key: "model",
                mapping: { "gpt-5.1": "gpt-5" },
              },
            ],
          },
        },
      ],
    });
    const out = classifyStage3Result("bundles/x.mthds", { exitCode: 1, stderr });
    expect(out.kind).toBe("block");
    if (out.kind !== "block") return;
    expect(out.reason).toContain("pipe: summarize");
    expect(out.reason).toContain(
      "Suggested fix: Replace model 'gpt-5.1' of pipe 'summarize' with 'gpt-5', its one close match in the model deck",
    );
  });

  it("blocks (safety default) when error_domain is absent (no-verdict / unknown)", () => {
    const stderr = errorEnvelope({
      error_type: "LibraryError",
      message: "Pipe 'build_scorecard' not found.",
    });
    const out = classifyStage3Result("a.mthds", { exitCode: 1, stderr });
    expect(out.kind).toBe("block");
    if (out.kind !== "block") return;
    expect(out.reason).toContain("build_scorecard");
  });

  it("warns (additionalContext) on config domain", () => {
    const stderr = errorEnvelope({
      error_type: "TelemetryConfigValidationError",
      is_valid: false,
      error_domain: "config",
      message: "Telemetry config is invalid",
    });
    const out = classifyStage3Result("a.mthds", { exitCode: 1, stderr });
    expect(out.kind).toBe("warn");
    if (out.kind !== "warn") return;
    expect(out.domain).toBe("config");
    expect(out.context).toContain("a.mthds");
    expect(out.context).toContain("config domain");
    expect(out.context).toContain("do not edit the file");
    expect(out.context).toContain("Telemetry config is invalid");
  });

  it("warns on runtime domain", () => {
    const stderr = errorEnvelope({
      error_type: "PipeRunError",
      error_domain: "runtime",
      message: "connection refused",
    });
    const out = classifyStage3Result("a.mthds", { exitCode: 1, stderr });
    expect(out.kind).toBe("warn");
    if (out.kind !== "warn") return;
    expect(out.domain).toBe("runtime");
    expect(out.context).toContain("runtime domain");
  });

  it("truncates an oversized config-domain message in the additionalContext", () => {
    const stderr = errorEnvelope({
      error_domain: "config",
      message: "x".repeat(12000),
    });
    const out = classifyStage3Result("a.mthds", { exitCode: 1, stderr });
    expect(out.kind).toBe("warn");
    if (out.kind !== "warn") return;
    expect(out.context).toContain("[truncated,");
    expect(out.context).toContain("chars omitted]");
    expect(out.context.length).toBeLessThan(10000);
  });
});

describe("classifyStage3Result — problem documents", () => {
  it("blocks on method.invalid, listing each item with its suggested fix", () => {
    const out = classifyStage3Result("bundles/x.mthds", {
      exitCode: 1,
      stderr: problemEnvelope(INVALID_METHOD_PROBLEM),
    });
    expect(out.kind).toBe("block");
    if (out.kind !== "block") return;
    expect(out.reason).toContain("Validation failed for bundles/x.mthds");
    expect(out.reason).toContain("Validation error(s) in the bundle");
    expect(out.reason).toContain(
      "- model.unknown: Model handle 'gpt-5.1' was not found in the model deck. Did you mean: gpt-5? (pipe 'summarize', field 'model', file 'bundles/x.mthds')",
    );
    expect(out.reason).toContain(
      "  Suggested fix (unsafe, rename-model): Replace model 'gpt-5.1' of pipe 'summarize' with 'gpt-5', its one close match in the model deck",
    );
    expect(out.reason).toContain("- method.pipe_unresolved:");
  });

  it("blocks on a problem of the input domain, the caller's own fault", () => {
    const problem = buildProblem(
      "request.pipe_not_found",
      { pipe: "demo.nope", suggestions: [] },
      { extra: { message: "Pipe 'demo.nope' not found." } },
    );
    const out = classifyStage3Result("a.mthds", { exitCode: 1, stderr: problemEnvelope(problem) });
    expect(out.kind).toBe("block");
    if (out.kind !== "block") return;
    expect(out.reason).toContain("Pipe 'demo.nope' not found.");
  });

  it.each([
    {
      code: "runtime.unavailable",
      problem: buildProblem("runtime.unavailable", {}),
      domain: "runtime",
    },
    {
      code: "runtime.misconfigured",
      problem: buildProblem("runtime.misconfigured", { component: "inference" }),
      domain: "operator",
    },
    {
      code: "account.quota_exhausted",
      problem: buildProblem("account.quota_exhausted", { quota: "credits" }),
      domain: "account",
    },
  ])("warns on $code, whose domain is the environment's", ({ problem, domain }) => {
    const out = classifyStage3Result("a.mthds", { exitCode: 1, stderr: problemEnvelope(problem) });
    expect(out.kind).toBe("warn");
    if (out.kind !== "warn") return;
    expect(out.domain).toBe(domain);
    expect(out.context).toContain(`${domain} domain`);
    expect(out.context).toContain("do not edit the file");
    // With no message member, the context quotes the problem's detail.
    expect(out.context).toContain(problem.detail);
  });

  it("quotes the problem's message in the warning when it carries one", () => {
    const problem = buildProblem(
      "runtime.unavailable",
      {},
      { extra: { message: "The inference gateway is down." } },
    );
    const out = classifyStage3Result("a.mthds", { exitCode: 1, stderr: problemEnvelope(problem) });
    expect(out.kind).toBe("warn");
    if (out.kind !== "warn") return;
    expect(out.context).toContain("The inference gateway is down.");
  });

  // The protocol reads a problem of a family a reader knows nothing of as `runtime`, which the
  // hook would read as the environment's and only warn on. A gate fails closed instead: such a
  // problem, of an unknown core family or an extension code, blocks, whatever its domain says
  // when the hook does not know that domain either.
  it.each([
    ["an unknown core family", "quorum.lost", undefined],
    ["an extension code", "pipelex.validation.foo", undefined],
    [
      "an extension code with a domain the hook does not know",
      "pipelex.validation.foo",
      "pipeline",
    ],
  ])("blocks on a problem of %s", (_topic, code, domain) => {
    const stderr = JSON.stringify({
      type: `https://example.com/errors/${code}`,
      title: "Something the hook does not know",
      detail: "The cluster lost its quorum.",
      code,
      ...(domain === undefined ? {} : { domain }),
      retry: "later",
      next_step: { kind: "retry", detail: "Try again later." },
    });
    const out = classifyStage3Result("a.mthds", { exitCode: 1, stderr });
    expect(out.kind).toBe("block");
    if (out.kind !== "block") return;
    expect(out.reason).toContain("Validation failed for a.mthds");
    expect(out.reason).toContain("The cluster lost its quorum.");
  });

  it("still reads an extension code by the domain it declares when the hook knows that domain", () => {
    const stderr = JSON.stringify({
      type: "https://example.com/errors/pipelex.inference.down",
      title: "Inference down",
      detail: "The inference gateway is down.",
      code: "pipelex.inference.down",
      domain: "runtime",
      retry: "yes",
      next_step: { kind: "retry", detail: "Try again later." },
    });
    const out = classifyStage3Result("a.mthds", { exitCode: 1, stderr });
    expect(out.kind).toBe("warn");
  });

  it("reads an unknown code with no domain as the codes of its family it knows", () => {
    const unknown = (code: string) =>
      JSON.stringify({
        type: `https://mthds.ai/errors/${code}`,
        title: "Something new",
        detail: "Something new went wrong.",
        code,
        retry: "no",
        next_step: { kind: "report", detail: "Report it." },
      });
    // The method family's known codes are faults of the file, or of the caller: the hook blocks.
    expect(
      classifyStage3Result("a.mthds", { exitCode: 1, stderr: unknown("method.brand_new") }).kind,
    ).toBe("block");
    // Every known code of the account family is the account's: the hook warns.
    const account = classifyStage3Result("a.mthds", {
      exitCode: 1,
      stderr: unknown("account.brand_new"),
    });
    expect(account.kind).toBe("warn");
    if (account.kind !== "warn") return;
    expect(account.domain).toBe("account");
  });

  it("warns on a configuration problem, whose fix is the machine's set-up", () => {
    const problem = buildProblem("client.not_configured", { setting: "MTHDS_API_KEY" });
    const out = classifyStage3Result("a.mthds", { exitCode: 1, stderr: problemEnvelope(problem) });
    expect(out.kind).toBe("warn");
  });

  it("prefers the problem's own domain member to its code's", () => {
    const problem = { ...buildProblem("runtime.unexpected", {}), domain: "method" };
    const out = classifyStage3Result("a.mthds", { exitCode: 1, stderr: problemEnvelope(problem) });
    expect(out.kind).toBe("block");
  });
});

// runCodexHook — Stage 3 wiring ──────────────────────────────────────

describe("runCodexHook — Stage 3", () => {
  it("blocks when pipelex-agent is missing", async () => {
    const { deps, emitted } = makeDeps({
      stdin: PAYLOAD("*** Update File: a.mthds"),
      files: new Set(["a.mthds"]),
      hasPipelexAgent: false,
    });
    await runCodexHook(deps);
    expect(emitted).toHaveLength(1);
    const parsed = JSON.parse(emitted[0]!.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("pipelex-agent");
  });

  it("invokes pipelex-agent with the file's parent directory and a trailing slash", async () => {
    const { deps, pipelexCalls } = makeDeps({
      stdin: PAYLOAD("*** Update File: bundles/core.mthds"),
      files: new Set(["bundles/core.mthds"]),
    });
    await runCodexHook(deps);
    expect(pipelexCalls).toEqual([{ file: "bundles/core.mthds", libraryDir: "bundles/" }]);
  });

  it("uses './' as library dir when the file has no parent directory", async () => {
    const { deps, pipelexCalls } = makeDeps({
      stdin: PAYLOAD("*** Update File: a.mthds"),
      files: new Set(["a.mthds"]),
    });
    await runCodexHook(deps);
    expect(pipelexCalls).toEqual([{ file: "a.mthds", libraryDir: "./" }]);
  });

  it("blocks when validate returns an input-domain JSON envelope", async () => {
    const stderr = errorEnvelope({
      error_type: "ValidateBundleError",
      is_valid: false,
      error_domain: "input",
      message: "Validation error(s) in the bundle",
      validation_errors: [
        {
          category: "pipe_validation",
          message: "Missing required field 'source'",
          pipe_code: "extract_info",
        },
      ],
    });
    const { deps, emitted } = makeDeps({
      stdin: PAYLOAD("*** Update File: a.mthds"),
      files: new Set(["a.mthds"]),
      pipelexResults: new Map([["a.mthds", { exitCode: 1, stderr }]]),
    });
    await runCodexHook(deps);
    expect(emitted).toHaveLength(1);
    const parsed = JSON.parse(emitted[0]!.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("a.mthds");
    expect(parsed.reason).toContain("Missing required field");
    expect(parsed.reason).toContain("extract_info");
  });

  it("blocks when validate returns a method.invalid problem document", async () => {
    const { deps, emitted } = makeDeps({
      stdin: PAYLOAD("*** Update File: a.mthds"),
      files: new Set(["a.mthds"]),
      pipelexResults: new Map([
        ["a.mthds", { exitCode: 1, stderr: problemEnvelope(INVALID_METHOD_PROBLEM) }],
      ]),
    });
    await runCodexHook(deps);
    expect(emitted).toHaveLength(1);
    const parsed = JSON.parse(emitted[0]!.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("a.mthds");
    expect(parsed.reason).toContain("- model.unknown:");
    expect(parsed.reason).toContain("Suggested fix (unsafe, rename-model)");
  });

  it("emits additionalContext (no block) on a runtime.unavailable problem document", async () => {
    const { deps, emitted } = makeDeps({
      stdin: PAYLOAD("*** Update File: a.mthds"),
      files: new Set(["a.mthds"]),
      pipelexResults: new Map([
        [
          "a.mthds",
          { exitCode: 1, stderr: problemEnvelope(buildProblem("runtime.unavailable", {})) },
        ],
      ]),
    });
    await runCodexHook(deps);
    expect(emitted).toHaveLength(1);
    const parsed = JSON.parse(emitted[0]!.trim());
    expect(parsed.decision).toBeUndefined();
    expect(parsed.hookSpecificOutput.additionalContext).toContain("runtime domain");
  });

  it("blocks (safety default) when the JSON envelope has no error_domain", async () => {
    const stderr = errorEnvelope({
      error_type: "LibraryError",
      message: "Pipe 'build_scorecard' not found.",
    });
    const { deps, emitted } = makeDeps({
      stdin: PAYLOAD("*** Update File: a.mthds"),
      files: new Set(["a.mthds"]),
      pipelexResults: new Map([["a.mthds", { exitCode: 1, stderr }]]),
    });
    await runCodexHook(deps);
    expect(emitted).toHaveLength(1);
    const parsed = JSON.parse(emitted[0]!.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("build_scorecard");
  });

  it("emits additionalContext (no block) on a config-domain JSON envelope", async () => {
    const stderr = errorEnvelope({
      error_type: "TelemetryConfigValidationError",
      is_valid: false,
      error_domain: "config",
      message: "Telemetry config missing required field",
    });
    const { deps, emitted } = makeDeps({
      stdin: PAYLOAD("*** Update File: a.mthds"),
      files: new Set(["a.mthds"]),
      pipelexResults: new Map([["a.mthds", { exitCode: 1, stderr }]]),
    });
    await runCodexHook(deps);
    expect(emitted).toHaveLength(1);
    const parsed = JSON.parse(emitted[0]!.trim());
    expect(parsed.decision).toBeUndefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("config domain");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("do not edit the file");
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "Telemetry config missing required field",
    );
    expect(parsed.hookSpecificOutput.additionalContext).toContain("a.mthds");
  });

  it("emits additionalContext on a runtime-domain JSON envelope", async () => {
    const stderr = errorEnvelope({
      error_type: "PipeRunError",
      error_domain: "runtime",
      message: "connection refused",
    });
    const { deps, emitted } = makeDeps({
      stdin: PAYLOAD("*** Update File: a.mthds"),
      files: new Set(["a.mthds"]),
      pipelexResults: new Map([["a.mthds", { exitCode: 1, stderr }]]),
    });
    await runCodexHook(deps);
    expect(emitted).toHaveLength(1);
    const parsed = JSON.parse(emitted[0]!.trim());
    expect(parsed.hookSpecificOutput.additionalContext).toContain("runtime domain");
  });

  it("blocks with a generic reason when validate fails with empty stderr", async () => {
    const { deps, emitted } = makeDeps({
      stdin: PAYLOAD("*** Update File: a.mthds"),
      files: new Set(["a.mthds"]),
      pipelexResults: new Map([["a.mthds", { exitCode: 2, stderr: "" }]]),
    });
    await runCodexHook(deps);
    const parsed = JSON.parse(emitted[0]!.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("no stderr output");
    expect(parsed.reason).toContain("exited 2");
  });

  it("passes silently when validate exits 0", async () => {
    const { deps, emitted, pipelexCalls } = makeDeps({
      stdin: PAYLOAD("*** Update File: a.mthds"),
      files: new Set(["a.mthds"]),
    });
    await runCodexHook(deps);
    expect(pipelexCalls).toHaveLength(1);
    expect(emitted).toEqual([]);
  });

  it("does not run Stage 3 when lint fails", async () => {
    const { deps, pipelexCalls } = makeDeps({
      stdin: PAYLOAD("*** Update File: a.mthds"),
      files: new Set(["a.mthds"]),
      plxtResults: new Map([["lint --quiet a.mthds", { exitCode: 1, stderr: "lint err" }]]),
    });
    await runCodexHook(deps);
    expect(pipelexCalls).toEqual([]);
  });

  it("does not run Stage 3 when fmt fails", async () => {
    const { deps, pipelexCalls } = makeDeps({
      stdin: PAYLOAD("*** Update File: a.mthds"),
      files: new Set(["a.mthds"]),
      plxtResults: new Map([["fmt a.mthds", { exitCode: 1, stderr: "fmt err" }]]),
    });
    await runCodexHook(deps);
    expect(pipelexCalls).toEqual([]);
  });

  it("when one file blocks and another warns, emits block only (warning is deferred)", async () => {
    const blockStderr = errorEnvelope({
      error_type: "ValidateBundleError",
      is_valid: false,
      error_domain: "input",
      message: "bad bundle a",
    });
    const warnStderr = errorEnvelope({
      error_type: "TelemetryConfigValidationError",
      error_domain: "config",
      message: "bad config",
    });
    const { deps, emitted } = makeDeps({
      stdin: PAYLOAD("*** Update File: a.mthds\n*** Add File: b.mthds"),
      files: new Set(["a.mthds", "b.mthds"]),
      pipelexResults: new Map([
        ["a.mthds", { exitCode: 1, stderr: blockStderr }],
        ["b.mthds", { exitCode: 1, stderr: warnStderr }],
      ]),
    });
    await runCodexHook(deps);
    expect(emitted).toHaveLength(1);
    const parsed = JSON.parse(emitted[0]!.trim());
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("a.mthds");
    expect(parsed.reason).toContain("bad bundle a");
    // Warning was deferred — must not leak into the block payload or as
    // a second emit.
    expect(parsed.reason).not.toContain("bad config");
    expect(parsed.reason).not.toContain("do not edit the file");
    expect(parsed.hookSpecificOutput).toBeUndefined();
  });

  it("aggregates multiple warnings (no block) into a single additionalContext payload", async () => {
    const warnA = errorEnvelope({ error_domain: "config", message: "bad cfg a" });
    const warnB = errorEnvelope({ error_domain: "runtime", message: "bad rt b" });
    const { deps, emitted } = makeDeps({
      stdin: PAYLOAD("*** Update File: a.mthds\n*** Add File: b.mthds"),
      files: new Set(["a.mthds", "b.mthds"]),
      pipelexResults: new Map([
        ["a.mthds", { exitCode: 1, stderr: warnA }],
        ["b.mthds", { exitCode: 1, stderr: warnB }],
      ]),
    });
    await runCodexHook(deps);
    expect(emitted).toHaveLength(1);
    const parsed = JSON.parse(emitted[0]!.trim());
    expect(parsed.decision).toBeUndefined();
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("a.mthds");
    expect(ctx).toContain("b.mthds");
    expect(ctx).toContain("bad cfg a");
    expect(ctx).toContain("bad rt b");
  });
});
