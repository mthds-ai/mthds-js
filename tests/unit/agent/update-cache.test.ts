import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  utimesSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { BINARY_RECOVERY } from "../../../src/agent/binaries.js";

const PX_CONSTRAINT = BINARY_RECOVERY["pipelex"].version_constraint;

let tempHome: string;
let tempTmp: string | undefined;

// Pluggable failure predicates so individual tests can simulate sandbox EPERM
// on the primary cache write path without touching real filesystem perms.
let writeFailPredicate: ((path: string) => NodeJS.ErrnoException | null) | null = null;
let mkdirFailPredicate: ((path: string) => NodeJS.ErrnoException | null) | null = null;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: () => tempHome,
    tmpdir: () => tempTmp ?? original.tmpdir(),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    writeFileSync: vi.fn((p: unknown, data: unknown, opts?: unknown) => {
      if (writeFailPredicate) {
        const err = writeFailPredicate(String(p));
        if (err) throw err;
      }
      return real.writeFileSync(
        p as Parameters<typeof real.writeFileSync>[0],
        data as Parameters<typeof real.writeFileSync>[1],
        opts as Parameters<typeof real.writeFileSync>[2]
      );
    }),
    mkdirSync: vi.fn((p: unknown, opts?: unknown) => {
      if (mkdirFailPredicate) {
        const err = mkdirFailPredicate(String(p));
        if (err) throw err;
      }
      return real.mkdirSync(
        p as Parameters<typeof real.mkdirSync>[0],
        opts as Parameters<typeof real.mkdirSync>[1]
      );
    }),
  };
});

async function importModule() {
  vi.resetModules();
  return await import("../../../src/agent/update-cache.js");
}

function stateDir() {
  return join(tempHome, ".mthds", "state");
}

function cachePath() {
  return join(stateDir(), "last-update-check");
}

function fallbackDir() {
  return join(tempTmp ?? tmpdir(), "mthds-agent");
}

function fallbackCachePath() {
  return join(fallbackDir(), "last-update-check");
}

function eperm(path: string): NodeJS.ErrnoException {
  const err = new Error(`EPERM: operation not permitted, '${path}'`) as NodeJS.ErrnoException;
  err.code = "EPERM";
  return err;
}

const OK_PAYLOAD = {
  mthds_agent: { s: "ok" as const, v: "0.2.1" },
  pipelex_agent: { s: "ok" as const, v: "0.22.0" },
  plxt: { s: "ok" as const, v: "0.3.2" },
};

const OUTDATED_PAYLOAD = {
  mthds_agent: { s: "ok" as const, v: "0.2.1" },
  pipelex_agent: { s: "outdated" as const, v: "0.21.0", r: PX_CONSTRAINT },
  plxt: { s: "ok" as const, v: "0.3.2" },
};

describe("update-cache", () => {
  beforeEach(() => {
    // Reset predicates before any fs operation runs — otherwise a predicate
    // leaked from a prior test (which throws EPERM) would fire on our setup.
    writeFailPredicate = null;
    mkdirFailPredicate = null;
    // Clear tempTmp before allocating tempHome so the mocked tmpdir() inside
    // mkdtempSync falls through to the real OS tmpdir.
    tempTmp = undefined;
    tempHome = mkdtempSync(join(tmpdir(), "mthds-cache-test-"));
    tempTmp = join(tempHome, "tmp");
    mkdirSync(tempTmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // readCache
  // ---------------------------------------------------------------------------
  describe("readCache", () => {
    it("returns null when file does not exist", async () => {
      const { readCache } = await importModule();
      expect(readCache()).toBeNull();
    });

    it("returns null when file is empty", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(cachePath(), "", "utf-8");

      const { readCache } = await importModule();
      expect(readCache()).toBeNull();
    });

    it("returns null when file has only one line", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(cachePath(), "UP_TO_DATE\n", "utf-8");

      const { readCache } = await importModule();
      expect(readCache()).toBeNull();
    });

    it("returns null when line 1 is not a valid aggregate status", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(cachePath(), "INVALID\n{}\n", "utf-8");

      const { readCache } = await importModule();
      expect(readCache()).toBeNull();
    });

    it("returns null when line 2 is not valid JSON", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(cachePath(), "UP_TO_DATE\nnot-json\n", "utf-8");

      const { readCache } = await importModule();
      expect(readCache()).toBeNull();
    });

    it("returns null when JSON is valid but payload shape is wrong", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(cachePath(), 'UP_TO_DATE\n{"foo":"bar"}\n', "utf-8");

      const { readCache } = await importModule();
      expect(readCache()).toBeNull();
    });

    it("returns null when payload entries are missing required 's' field", async () => {
      mkdirSync(stateDir(), { recursive: true });
      const bad = { mthds_agent: { v: "0.2.1" }, pipelex_agent: { s: "ok", v: "0.22.0" }, plxt: { s: "ok", v: "0.3.2" } };
      writeFileSync(cachePath(), "UP_TO_DATE\n" + JSON.stringify(bad) + "\n", "utf-8");

      const { readCache } = await importModule();
      expect(readCache()).toBeNull();
    });

    it("returns null when UP_TO_DATE cache is expired (>60min)", async () => {
      mkdirSync(stateDir(), { recursive: true });
      const content = "UP_TO_DATE\n" + JSON.stringify(OK_PAYLOAD) + "\n";
      writeFileSync(cachePath(), content, "utf-8");

      // Set mtime to 61 minutes ago
      const old = new Date(Date.now() - 61 * 60 * 1000);
      utimesSync(cachePath(), old, old);

      const { readCache } = await importModule();
      expect(readCache()).toBeNull();
    });

    it("returns null when UPGRADE_AVAILABLE cache is expired (>720min)", async () => {
      mkdirSync(stateDir(), { recursive: true });
      const content =
        "UPGRADE_AVAILABLE\n" + JSON.stringify(OUTDATED_PAYLOAD) + "\n";
      writeFileSync(cachePath(), content, "utf-8");

      // Set mtime to 721 minutes ago
      const old = new Date(Date.now() - 721 * 60 * 1000);
      utimesSync(cachePath(), old, old);

      const { readCache } = await importModule();
      expect(readCache()).toBeNull();
    });

    it("returns cached result when UP_TO_DATE and within TTL", async () => {
      mkdirSync(stateDir(), { recursive: true });
      const content = "UP_TO_DATE\n" + JSON.stringify(OK_PAYLOAD) + "\n";
      writeFileSync(cachePath(), content, "utf-8");

      const { readCache } = await importModule();
      const result = readCache();
      expect(result).not.toBeNull();
      expect(result!.aggregate).toBe("UP_TO_DATE");
      expect(result!.payload.mthds_agent.s).toBe("ok");
    });

    it("returns cached result when UPGRADE_AVAILABLE and within TTL", async () => {
      mkdirSync(stateDir(), { recursive: true });
      const content =
        "UPGRADE_AVAILABLE\n" + JSON.stringify(OUTDATED_PAYLOAD) + "\n";
      writeFileSync(cachePath(), content, "utf-8");

      const { readCache } = await importModule();
      const result = readCache();
      expect(result).not.toBeNull();
      expect(result!.aggregate).toBe("UPGRADE_AVAILABLE");
      expect(result!.payload.pipelex_agent.s).toBe("outdated");
      expect(result!.payload.pipelex_agent.r).toBe(PX_CONSTRAINT);
    });
  });

  // ---------------------------------------------------------------------------
  // writeCache
  // ---------------------------------------------------------------------------
  describe("writeCache", () => {
    it("creates state directory if missing", async () => {
      const { writeCache } = await importModule();
      writeCache({ aggregate: "UP_TO_DATE", payload: OK_PAYLOAD });

      expect(existsSync(stateDir())).toBe(true);
    });

    it("writes correct two-line format", async () => {
      const { writeCache } = await importModule();
      writeCache({ aggregate: "UPGRADE_AVAILABLE", payload: OUTDATED_PAYLOAD });

      const content = readFileSync(cachePath(), "utf-8");
      const lines = content.split("\n");
      expect(lines[0]).toBe("UPGRADE_AVAILABLE");
      expect(JSON.parse(lines[1]!)).toEqual(OUTDATED_PAYLOAD);
    });

    it("does NOT create the fallback path when primary write succeeds", async () => {
      const { writeCache } = await importModule();
      writeCache({ aggregate: "UP_TO_DATE", payload: OK_PAYLOAD });

      expect(existsSync(cachePath())).toBe(true);
      expect(existsSync(fallbackCachePath())).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Sandbox fallback
  // ---------------------------------------------------------------------------
  describe("sandbox EPERM fallback", () => {
    it("falls back to $TMPDIR when primary writeFileSync throws EPERM", async () => {
      writeFailPredicate = (p) => (p === cachePath() ? eperm(p) : null);

      const { writeCache } = await importModule();
      writeCache({ aggregate: "UP_TO_DATE", payload: OK_PAYLOAD });

      expect(existsSync(cachePath())).toBe(false);
      expect(existsSync(fallbackCachePath())).toBe(true);

      const content = readFileSync(fallbackCachePath(), "utf-8");
      expect(content.split("\n")[0]).toBe("UP_TO_DATE");
    });

    it("falls back to $TMPDIR when primary mkdirSync throws EPERM", async () => {
      mkdirFailPredicate = (p) => (p === stateDir() ? eperm(p) : null);

      const { writeCache } = await importModule();
      writeCache({ aggregate: "UP_TO_DATE", payload: OK_PAYLOAD });

      expect(existsSync(cachePath())).toBe(false);
      expect(existsSync(fallbackCachePath())).toBe(true);
    });

    it("readCache reads the fallback when only the fallback file exists", async () => {
      mkdirSync(fallbackDir(), { recursive: true });
      writeFileSync(
        fallbackCachePath(),
        "UP_TO_DATE\n" + JSON.stringify(OK_PAYLOAD) + "\n",
        "utf-8"
      );

      const { readCache } = await importModule();
      const result = readCache();
      expect(result).not.toBeNull();
      expect(result!.aggregate).toBe("UP_TO_DATE");
    });

    it("readCache prefers the newer file when both primary and fallback have unexpired contents", async () => {
      // Primary is older — simulates a stale snapshot from before writes were
      // redirected to the fallback path (e.g. user moved from non-sandbox to a
      // sandboxed session). The fresher fallback must win.
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(
        cachePath(),
        "UPGRADE_AVAILABLE\n" + JSON.stringify(OUTDATED_PAYLOAD) + "\n",
        "utf-8"
      );
      const old = new Date(Date.now() - 30 * 60 * 1000);
      utimesSync(cachePath(), old, old);

      mkdirSync(fallbackDir(), { recursive: true });
      writeFileSync(
        fallbackCachePath(),
        "UP_TO_DATE\n" + JSON.stringify(OK_PAYLOAD) + "\n",
        "utf-8"
      );

      const { readCache } = await importModule();
      const result = readCache();
      expect(result!.aggregate).toBe("UP_TO_DATE");
    });

    it("readCache prefers primary when primary is newer than fallback", async () => {
      // Inverse case: fallback holds an older snapshot from a previous
      // sandboxed session, primary was refreshed afterwards.
      mkdirSync(fallbackDir(), { recursive: true });
      writeFileSync(
        fallbackCachePath(),
        "UPGRADE_AVAILABLE\n" + JSON.stringify(OUTDATED_PAYLOAD) + "\n",
        "utf-8"
      );
      const old = new Date(Date.now() - 30 * 60 * 1000);
      utimesSync(fallbackCachePath(), old, old);

      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(
        cachePath(),
        "UP_TO_DATE\n" + JSON.stringify(OK_PAYLOAD) + "\n",
        "utf-8"
      );

      const { readCache } = await importModule();
      const result = readCache();
      expect(result!.aggregate).toBe("UP_TO_DATE");
    });

    it("clearCache deletes both primary and fallback paths", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(cachePath(), "UP_TO_DATE\n{}\n", "utf-8");
      mkdirSync(fallbackDir(), { recursive: true });
      writeFileSync(fallbackCachePath(), "UP_TO_DATE\n{}\n", "utf-8");

      const { clearCache } = await importModule();
      clearCache();

      expect(existsSync(cachePath())).toBe(false);
      expect(existsSync(fallbackCachePath())).toBe(false);
    });

    it("emits the warning at most once per process when both writes fail", async () => {
      writeFailPredicate = (_p) => eperm("anywhere");
      mkdirFailPredicate = (_p) => eperm("anywhere");

      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const mod = await importModule();

      mod.writeCache({ aggregate: "UP_TO_DATE", payload: OK_PAYLOAD });
      mod.writeCache({ aggregate: "UP_TO_DATE", payload: OK_PAYLOAD });
      mod.writeCache({ aggregate: "UP_TO_DATE", payload: OK_PAYLOAD });

      const warnings = stderrSpy.mock.calls.filter((args) =>
        String(args[0]).includes("could not write update-check cache")
      );
      expect(warnings.length).toBe(1);

      stderrSpy.mockRestore();
    });

    it("does NOT emit a warning when fallback succeeds", async () => {
      writeFailPredicate = (p) => (p === cachePath() ? eperm(p) : null);

      const mod = await importModule();
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      mod.writeCache({ aggregate: "UP_TO_DATE", payload: OK_PAYLOAD });

      const warnings = stderrSpy.mock.calls.filter((args) =>
        String(args[0]).includes("could not write update-check cache")
      );
      expect(warnings.length).toBe(0);

      stderrSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // clearCache
  // ---------------------------------------------------------------------------
  describe("clearCache", () => {
    it("removes the cache file", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(cachePath(), "UP_TO_DATE\n{}\n", "utf-8");

      const { clearCache } = await importModule();
      clearCache();
      expect(existsSync(cachePath())).toBe(false);
    });

    it("no-ops when file does not exist", async () => {
      const { clearCache } = await importModule();
      expect(() => clearCache()).not.toThrow();
    });
  });

  // ---------------------------------------------------------------------------
  // computeAggregate
  // ---------------------------------------------------------------------------
  describe("computeAggregate", () => {
    it("returns UP_TO_DATE when all binaries are ok", async () => {
      const { computeAggregate } = await importModule();
      expect(computeAggregate(OK_PAYLOAD)).toBe("UP_TO_DATE");
    });

    it("returns UPGRADE_AVAILABLE when any binary is outdated", async () => {
      const { computeAggregate } = await importModule();
      expect(computeAggregate(OUTDATED_PAYLOAD)).toBe("UPGRADE_AVAILABLE");
    });

    it("returns UPGRADE_AVAILABLE when any binary is missing", async () => {
      const { computeAggregate } = await importModule();
      const payload = {
        ...OK_PAYLOAD,
        plxt: { s: "missing" as const, v: null },
      };
      expect(computeAggregate(payload)).toBe("UPGRADE_AVAILABLE");
    });

    it("returns UP_TO_DATE when a binary is unparseable (not UPGRADE_AVAILABLE)", async () => {
      const { computeAggregate } = await importModule();
      const payload = {
        ...OK_PAYLOAD,
        plxt: { s: "unparseable" as const, v: null },
      };
      // Unparseable means the binary exists but version can't be parsed.
      // Treating it as UPGRADE_AVAILABLE would cause an infinite loop because
      // the upgrade command skips unparseable binaries.
      expect(computeAggregate(payload)).toBe("UP_TO_DATE");
    });

    it("returns UPGRADE_AVAILABLE when one binary is outdated even if another is unparseable", async () => {
      const { computeAggregate } = await importModule();
      const payload = {
        mthds_agent: { s: "ok" as const, v: "0.2.1" },
        pipelex_agent: { s: "outdated" as const, v: "0.21.0", r: PX_CONSTRAINT },
        plxt: { s: "unparseable" as const, v: null },
      };
      expect(computeAggregate(payload)).toBe("UPGRADE_AVAILABLE");
    });

    it("returns UP_TO_DATE when pipelex_agent is absent and others are ok", async () => {
      const { computeAggregate } = await importModule();
      const payload = {
        mthds_agent: { s: "ok" as const, v: "0.2.1" },
        plxt: { s: "ok" as const, v: "0.3.2" },
      };
      expect(computeAggregate(payload)).toBe("UP_TO_DATE");
    });
  });

  // ---------------------------------------------------------------------------
  // Optional pipelex_agent in cache
  // ---------------------------------------------------------------------------
  describe("optional pipelex_agent", () => {
    it("validates payload without pipelex_agent as valid", async () => {
      mkdirSync(stateDir(), { recursive: true });
      const payload = { mthds_agent: { s: "ok", v: "0.2.1" }, plxt: { s: "ok", v: "0.3.2" } };
      const content = "UP_TO_DATE\n" + JSON.stringify(payload) + "\n";
      writeFileSync(cachePath(), content, "utf-8");

      const { readCache } = await importModule();
      const result = readCache();
      expect(result).not.toBeNull();
      expect(result!.payload.pipelex_agent).toBeUndefined();
    });

    it("validates payload with pipelex_agent present", async () => {
      mkdirSync(stateDir(), { recursive: true });
      const content = "UP_TO_DATE\n" + JSON.stringify(OK_PAYLOAD) + "\n";
      writeFileSync(cachePath(), content, "utf-8");

      const { readCache } = await importModule();
      const result = readCache();
      expect(result).not.toBeNull();
      expect(result!.payload.pipelex_agent).toBeDefined();
    });
  });
});
