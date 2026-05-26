import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  utimesSync,
  rmSync,
  statSync,
  chmodSync,
  symlinkSync,
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
let unlinkFailPredicate: ((path: string) => NodeJS.ErrnoException | null) | null = null;

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
    // Hardened writes go through openSync (for O_NOFOLLOW), so the
    // primary-write failure injection now happens here.
    openSync: vi.fn((p: unknown, flags?: unknown, mode?: unknown) => {
      if (writeFailPredicate) {
        const err = writeFailPredicate(String(p));
        if (err) throw err;
      }
      return real.openSync(
        p as Parameters<typeof real.openSync>[0],
        flags as Parameters<typeof real.openSync>[1],
        mode as Parameters<typeof real.openSync>[2]
      );
    }),
    unlinkSync: vi.fn((p: unknown) => {
      if (unlinkFailPredicate) {
        const err = unlinkFailPredicate(String(p));
        if (err) throw err;
      }
      return real.unlinkSync(p as Parameters<typeof real.unlinkSync>[0]);
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
  // Mirrors update-cache.ts: the fallback dir name carries the uid so users
  // on a shared host never collide on ownership.
  const uid = typeof process.getuid === "function" ? `-${process.getuid()}` : "";
  return join(tempTmp ?? tmpdir(), `mthds-agent${uid}`);
}

function fallbackCachePath() {
  return join(fallbackDir(), "last-update-check");
}

function markerPath() {
  return join(stateDir(), "just-upgraded-from");
}

function fallbackMarkerPath() {
  return join(fallbackDir(), "just-upgraded-from");
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
    unlinkFailPredicate = null;
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

    it("re-asserts 0o700 on a pre-existing state directory", async () => {
      // mkdirSync's `mode` is honored only on creation, so a directory left
      // world-traversable by an older version must be chmod-ed back to
      // owner-only on the next write.
      mkdirSync(stateDir(), { recursive: true });
      chmodSync(stateDir(), 0o777);

      const { writeCache } = await importModule();
      writeCache({ aggregate: "UP_TO_DATE", payload: OK_PAYLOAD });

      expect(statSync(stateDir()).mode & 0o777).toBe(0o700);
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

    it("re-asserts 0o700 on a pre-existing fallback directory with broad permissions", async () => {
      // Simulates $TMPDIR/mthds-agent left world-traversable by an older
      // version, or pre-created on a shared /tmp. mkdirSync's `mode` is a no-op
      // on an existing dir, so the fallback write must chmod it owner-only.
      mkdirSync(fallbackDir(), { recursive: true });
      chmodSync(fallbackDir(), 0o777);

      writeFailPredicate = (p) => (p === cachePath() ? eperm(p) : null);

      const { writeCache } = await importModule();
      writeCache({ aggregate: "UP_TO_DATE", payload: OK_PAYLOAD });

      expect(existsSync(fallbackCachePath())).toBe(true);
      expect(statSync(fallbackDir()).mode & 0o777).toBe(0o700);
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

  // ---------------------------------------------------------------------------
  // upgrade marker (writeUpgradeMarker + readAndClearUpgradeMarker)
  // ---------------------------------------------------------------------------
  describe("upgrade marker", () => {
    const MARKER_DATA = { pipelex_agent: "0.26.3", plxt: "missing" };

    describe("writeUpgradeMarker", () => {
      it("writes to the primary path when home dir is writable", async () => {
        const { writeUpgradeMarker } = await importModule();
        writeUpgradeMarker(MARKER_DATA);

        expect(existsSync(markerPath())).toBe(true);
        expect(existsSync(fallbackMarkerPath())).toBe(false);
        expect(JSON.parse(readFileSync(markerPath(), "utf-8"))).toEqual(MARKER_DATA);
      });

      it("falls back to $TMPDIR when primary writeFileSync throws EPERM", async () => {
        writeFailPredicate = (p) => (p === markerPath() ? eperm(p) : null);

        const { writeUpgradeMarker } = await importModule();
        writeUpgradeMarker(MARKER_DATA);

        expect(existsSync(markerPath())).toBe(false);
        expect(existsSync(fallbackMarkerPath())).toBe(true);
        expect(JSON.parse(readFileSync(fallbackMarkerPath(), "utf-8"))).toEqual(MARKER_DATA);
      });

      it("falls back to $TMPDIR when primary mkdirSync throws EPERM", async () => {
        mkdirFailPredicate = (p) => (p === stateDir() ? eperm(p) : null);

        const { writeUpgradeMarker } = await importModule();
        writeUpgradeMarker(MARKER_DATA);

        expect(existsSync(markerPath())).toBe(false);
        expect(existsSync(fallbackMarkerPath())).toBe(true);
      });

      it("emits the warning at most once per process when both writes fail", async () => {
        writeFailPredicate = (_p) => eperm("anywhere");
        mkdirFailPredicate = (_p) => eperm("anywhere");

        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

        const { writeUpgradeMarker } = await importModule();
        writeUpgradeMarker(MARKER_DATA);
        writeUpgradeMarker(MARKER_DATA);
        writeUpgradeMarker(MARKER_DATA);

        const warnings = stderrSpy.mock.calls.filter((args) =>
          String(args[0]).includes("could not write upgrade marker")
        );
        expect(warnings.length).toBe(1);

        stderrSpy.mockRestore();
      });

      it("warns without falling back when the primary write fails with a non-sandbox error", async () => {
        // ENOSPC is not a sandbox/permission error — $TMPDIR would not help,
        // so writeUpgradeMarker must skip the fallback and warn directly.
        const enospc = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
        enospc.code = "ENOSPC";
        writeFailPredicate = (p) => (p === markerPath() ? enospc : null);
        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

        const { writeUpgradeMarker } = await importModule();
        writeUpgradeMarker(MARKER_DATA);

        expect(existsSync(fallbackMarkerPath())).toBe(false);
        const warning = stderrSpy.mock.calls.find((args) =>
          String(args[0]).includes("could not write upgrade marker")
        );
        expect(warning).toBeDefined();
        expect(String(warning![0])).toContain("ENOSPC");
        expect(String(warning![0])).not.toContain("primary=");

        stderrSpy.mockRestore();
      });
    });

    describe("readAndClearUpgradeMarker", () => {
      it("returns null when no marker exists", async () => {
        const { readAndClearUpgradeMarker } = await importModule();
        expect(readAndClearUpgradeMarker()).toBeNull();
      });

      it("returns parsed data from the primary path", async () => {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(markerPath(), JSON.stringify(MARKER_DATA), "utf-8");

        const { readAndClearUpgradeMarker } = await importModule();
        expect(readAndClearUpgradeMarker()).toEqual(MARKER_DATA);
      });

      it("returns parsed data from the fallback path when only it exists", async () => {
        mkdirSync(fallbackDir(), { recursive: true });
        writeFileSync(fallbackMarkerPath(), JSON.stringify(MARKER_DATA), "utf-8");

        const { readAndClearUpgradeMarker } = await importModule();
        expect(readAndClearUpgradeMarker()).toEqual(MARKER_DATA);
      });

      it("prefers the newer file when both primary and fallback exist", async () => {
        // Primary is older — simulates a stuck marker from a pre-fallback
        // session. The fresher fallback must win.
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(markerPath(), JSON.stringify({ pipelex_agent: "0.20.0" }), "utf-8");
        const old = new Date(Date.now() - 5 * 60 * 1000);
        utimesSync(markerPath(), old, old);

        mkdirSync(fallbackDir(), { recursive: true });
        writeFileSync(fallbackMarkerPath(), JSON.stringify(MARKER_DATA), "utf-8");

        const { readAndClearUpgradeMarker } = await importModule();
        expect(readAndClearUpgradeMarker()).toEqual(MARKER_DATA);
      });

      it("removes the file on successful read", async () => {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(markerPath(), JSON.stringify(MARKER_DATA), "utf-8");

        const { readAndClearUpgradeMarker } = await importModule();
        readAndClearUpgradeMarker();
        expect(existsSync(markerPath())).toBe(false);
      });

      it("returns null and cleans up when the marker is older than the TTL", async () => {
        // This is exactly the stuck-marker case the fix is aimed at — a
        // previous session wrote the marker successfully but the next session
        // could not delete it. After enough time, we stop honoring it.
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(markerPath(), JSON.stringify(MARKER_DATA), "utf-8");
        const old = new Date(Date.now() - 61 * 60 * 1000);
        utimesSync(markerPath(), old, old);

        const { readAndClearUpgradeMarker } = await importModule();
        expect(readAndClearUpgradeMarker()).toBeNull();
        // Cleanup still runs even when we don't honor the marker
        expect(existsSync(markerPath())).toBe(false);
      });

      it("returns null when the marker mtime is in the future (clock skew)", async () => {
        // A future-dated marker (clock skew between sessions) has negative age;
        // without the skew guard it would never look stale and would replay the
        // upgrade announcement on every update-check.
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(markerPath(), JSON.stringify(MARKER_DATA), "utf-8");
        const future = new Date(Date.now() + 10 * 60 * 1000);
        utimesSync(markerPath(), future, future);

        const { readAndClearUpgradeMarker } = await importModule();
        expect(readAndClearUpgradeMarker()).toBeNull();
        // Cleanup still runs even when we don't honor the marker.
        expect(existsSync(markerPath())).toBe(false);
      });

      it("self-heals by overwriting with empty content when unlink fails", async () => {
        // Codex's sandbox blocks unlink under ~/.mthds/state/ even when
        // writes there happened to succeed earlier. Falling through to
        // writeFileSync('') makes the next read return null (JSON.parse fails).
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(markerPath(), JSON.stringify(MARKER_DATA), "utf-8");
        unlinkFailPredicate = (p) => (p === markerPath() ? eperm(p) : null);

        const mod = await importModule();
        // First read consumes the marker (overwrites with empty since unlink fails)
        expect(mod.readAndClearUpgradeMarker()).toEqual(MARKER_DATA);
        expect(readFileSync(markerPath(), "utf-8")).toBe("");
        // Second read sees the empty file and returns null
        expect(mod.readAndClearUpgradeMarker()).toBeNull();
      });

      it("warns once when neither unlink nor overwrite can clear the marker", async () => {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(markerPath(), JSON.stringify(MARKER_DATA), "utf-8");
        unlinkFailPredicate = (p) => (p === markerPath() ? eperm(p) : null);
        writeFailPredicate = (p) => (p === markerPath() ? eperm(p) : null);

        const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const { readAndClearUpgradeMarker } = await importModule();

        readAndClearUpgradeMarker();
        readAndClearUpgradeMarker();

        const warnings = stderrSpy.mock.calls.filter((args) =>
          String(args[0]).includes("could not clear upgrade marker")
        );
        expect(warnings.length).toBe(1);

        stderrSpy.mockRestore();
      });

      it("returns null when content is not valid JSON", async () => {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(markerPath(), "not-json", "utf-8");

        const { readAndClearUpgradeMarker } = await importModule();
        expect(readAndClearUpgradeMarker()).toBeNull();
      });

      it("returns null when JSON parses to a non-object", async () => {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(markerPath(), '["array","not","object"]', "utf-8");

        const { readAndClearUpgradeMarker } = await importModule();
        expect(readAndClearUpgradeMarker()).toBeNull();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Fallback directory hardening (symlink / TOCTOU)
  // ---------------------------------------------------------------------------
  describe("fallback dir hardening", () => {
    // These tests deliberately trip the hardening warnings; silence the
    // expected stderr noise. Tests that assert on a warning stack their own
    // spy on top, which works fine and is restored here too.
    beforeEach(() => {
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("creates a fresh 0o700 directory owned by the current user", async () => {
      const { ensureFallbackDir } = await importModule();
      expect(ensureFallbackDir(true)).toEqual({ usable: true, reason: "ok" });
      expect(existsSync(fallbackDir())).toBe(true);
      expect(statSync(fallbackDir()).mode & 0o777).toBe(0o700);
    });

    it("refuses a fallback directory that is a symlink", async () => {
      const evil = join(tempHome, "evil");
      mkdirSync(evil, { recursive: true });
      symlinkSync(evil, fallbackDir());

      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      const { ensureFallbackDir } = await importModule();
      const res = ensureFallbackDir(true);
      expect(res).toEqual({ usable: false, reason: "symlink" });
      expect(
        stderrSpy.mock.calls.some((a) =>
          String(a[0]).includes("refusing fallback state directory")
        )
      ).toBe(true);
      stderrSpy.mockRestore();
    });

    it("refuses a fallback path that exists as a regular file", async () => {
      writeFileSync(fallbackDir(), "not a directory", "utf-8");
      const { ensureFallbackDir } = await importModule();
      expect(ensureFallbackDir(true).reason).toBe("not-a-dir");
    });

    it("chmods a pre-existing owned fallback directory back to 0o700", async () => {
      mkdirSync(fallbackDir(), { recursive: true });
      chmodSync(fallbackDir(), 0o777);
      const { ensureFallbackDir } = await importModule();
      expect(ensureFallbackDir(true)).toEqual({ usable: true, reason: "ok" });
      expect(statSync(fallbackDir()).mode & 0o777).toBe(0o700);
    });

    it("refuses the fallback when $TMPDIR is world-writable without the sticky bit", async () => {
      chmodSync(tempTmp!, 0o777);
      const { ensureFallbackDir } = await importModule();
      expect(ensureFallbackDir(true).reason).toBe("insecure-tmp");
      expect(existsSync(fallbackDir())).toBe(false);
    });

    it("allows the fallback when $TMPDIR is world-writable but sticky", async () => {
      chmodSync(tempTmp!, 0o1777);
      const { ensureFallbackDir } = await importModule();
      expect(ensureFallbackDir(true)).toEqual({ usable: true, reason: "ok" });
    });

    it("refuses a fallback directory owned by another user", async () => {
      // Spy getuid to a bogus uid *before* importing, so FALLBACK_DIR is named
      // for the bogus uid; the directory we create is owned by the real test
      // uid, producing the ownership mismatch.
      const bogus = (process.getuid?.() ?? 0) + 99999;
      const uidSpy = vi.spyOn(process, "getuid").mockReturnValue(bogus);
      mkdirSync(fallbackDir(), { recursive: true, mode: 0o700 });
      const { ensureFallbackDir } = await importModule();
      expect(ensureFallbackDir(true).reason).toBe("foreign-owner");
      uidSpy.mockRestore();
    });

    it("reports the fallback as absent without warning when the directory is missing", async () => {
      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      const { ensureFallbackDir } = await importModule();
      expect(ensureFallbackDir(false)).toEqual({ usable: false, reason: "absent" });
      expect(
        stderrSpy.mock.calls.some((a) => String(a[0]).includes("refusing"))
      ).toBe(false);
      stderrSpy.mockRestore();
    });

    it("memoizes a suspicious refusal and warns at most once", async () => {
      const evil = join(tempHome, "evil");
      mkdirSync(evil, { recursive: true });
      symlinkSync(evil, fallbackDir());

      const stderrSpy = vi
        .spyOn(process.stderr, "write")
        .mockImplementation(() => true);
      const { ensureFallbackDir } = await importModule();
      expect(ensureFallbackDir(true).reason).toBe("symlink");
      expect(ensureFallbackDir(false).reason).toBe("symlink");
      expect(ensureFallbackDir(true).reason).toBe("symlink");
      const warnings = stderrSpy.mock.calls.filter((a) =>
        String(a[0]).includes("refusing fallback state directory")
      );
      expect(warnings.length).toBe(1);
      stderrSpy.mockRestore();
    });

    it("refuses to write through a symlinked fallback file (O_NOFOLLOW)", async () => {
      mkdirSync(fallbackDir(), { recursive: true, mode: 0o700 });
      const evilTarget = join(tempHome, "evil-target");
      writeFileSync(evilTarget, "original", "utf-8");
      symlinkSync(evilTarget, fallbackCachePath());

      writeFailPredicate = (p) => (p === cachePath() ? eperm(p) : null);
      const { writeCache } = await importModule();
      writeCache({ aggregate: "UP_TO_DATE", payload: OK_PAYLOAD });

      // O_NOFOLLOW must have rejected the write — the target stays untouched.
      expect(readFileSync(evilTarget, "utf-8")).toBe("original");
    });

    it("readCache ignores a symlinked fallback directory and uses the primary", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(
        cachePath(),
        "UP_TO_DATE\n" + JSON.stringify(OK_PAYLOAD) + "\n",
        "utf-8"
      );
      const evil = join(tempHome, "evil");
      mkdirSync(evil, { recursive: true });
      symlinkSync(evil, fallbackDir());

      const { readCache } = await importModule();
      expect(readCache()?.aggregate).toBe("UP_TO_DATE");
    });

    it("falls back to the legacy unsuffixed name when process.getuid is unavailable", async () => {
      const orig = process.getuid;
      Object.defineProperty(process, "getuid", {
        value: undefined,
        configurable: true,
      });
      try {
        const mod = await importModule();
        expect(mod.FALLBACK_DIR.endsWith(join("tmp", "mthds-agent"))).toBe(true);
        expect(mod.ensureFallbackDir(true).usable).toBe(true);
      } finally {
        Object.defineProperty(process, "getuid", {
          value: orig,
          configurable: true,
        });
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Remote upstream-version cache
  // ---------------------------------------------------------------------------
  describe("remote cache", () => {
    function remotePath() {
      return join(stateDir(), "last-remote-fetch");
    }
    function fallbackRemotePath() {
      return join(fallbackDir(), "last-remote-fetch");
    }

    describe("readRemoteCache", () => {
      it("returns null when file does not exist", async () => {
        const { readRemoteCache } = await importModule();
        expect(readRemoteCache()).toBeNull();
      });

      it("returns null on malformed JSON", async () => {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(remotePath(), "not-json", "utf-8");
        const { readRemoteCache } = await importModule();
        expect(readRemoteCache()).toBeNull();
      });

      it("returns null on wrong shape (missing required key)", async () => {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(remotePath(), '{"mthds_agent_latest":"0.8.1"}', "utf-8");
        const { readRemoteCache } = await importModule();
        expect(readRemoteCache()).toBeNull();
      });

      it("returns null when wrong field type", async () => {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(
          remotePath(),
          '{"mthds_agent_latest":42,"plugin_latest":null}',
          "utf-8",
        );
        const { readRemoteCache } = await importModule();
        expect(readRemoteCache()).toBeNull();
      });

      it("returns payload when valid and unexpired", async () => {
        mkdirSync(stateDir(), { recursive: true });
        const payload = { mthds_agent_latest: "0.8.1", plugin_latest: "0.11.3" };
        writeFileSync(remotePath(), JSON.stringify(payload), "utf-8");
        const { readRemoteCache } = await importModule();
        expect(readRemoteCache()).toEqual(payload);
      });

      it("returns payload when one field is null and entry is fresh", async () => {
        mkdirSync(stateDir(), { recursive: true });
        const payload = { mthds_agent_latest: "0.8.1", plugin_latest: null };
        writeFileSync(remotePath(), JSON.stringify(payload), "utf-8");
        const { readRemoteCache } = await importModule();
        expect(readRemoteCache()).toEqual(payload);
      });

      it("returns null when older than 24h (TTL expired)", async () => {
        mkdirSync(stateDir(), { recursive: true });
        const payload = { mthds_agent_latest: "0.8.1", plugin_latest: "0.11.3" };
        writeFileSync(remotePath(), JSON.stringify(payload), "utf-8");
        // Backdate mtime to 25h ago.
        const old = Math.floor((Date.now() - 25 * 60 * 60 * 1000) / 1000);
        utimesSync(remotePath(), old, old);
        const { readRemoteCache } = await importModule();
        expect(readRemoteCache()).toBeNull();
      });

      it("treats partial entry older than 1h as expired (re-probe needed)", async () => {
        mkdirSync(stateDir(), { recursive: true });
        // One field null → partial → short TTL applies.
        const payload = { mthds_agent_latest: "0.8.1", plugin_latest: null };
        writeFileSync(remotePath(), JSON.stringify(payload), "utf-8");
        // Backdate mtime by 90 min — past the 1h partial TTL but well within
        // the 24h complete TTL. Without the partial-aware TTL this would
        // return the stale null and lock the upstream-missing signal for 23h.
        const old = Math.floor((Date.now() - 90 * 60 * 1000) / 1000);
        utimesSync(remotePath(), old, old);
        const { readRemoteCache } = await importModule();
        expect(readRemoteCache()).toBeNull();
      });

      it("returns complete entry up to 24h old (full TTL applies when no nulls)", async () => {
        mkdirSync(stateDir(), { recursive: true });
        const payload = { mthds_agent_latest: "0.8.1", plugin_latest: "0.11.3" };
        writeFileSync(remotePath(), JSON.stringify(payload), "utf-8");
        // Backdate 90 min — past the partial TTL but no field is null, so the
        // full 24h TTL must still apply.
        const old = Math.floor((Date.now() - 90 * 60 * 1000) / 1000);
        utimesSync(remotePath(), old, old);
        const { readRemoteCache } = await importModule();
        expect(readRemoteCache()).toEqual(payload);
      });

      it("readRemoteCacheRaw ignores both TTLs (returns even old partial entries)", async () => {
        mkdirSync(stateDir(), { recursive: true });
        const payload = { mthds_agent_latest: "0.8.1", plugin_latest: null };
        writeFileSync(remotePath(), JSON.stringify(payload), "utf-8");
        // 25h old — past every TTL.
        const old = Math.floor((Date.now() - 25 * 60 * 60 * 1000) / 1000);
        utimesSync(remotePath(), old, old);
        const { readRemoteCacheRaw } = await importModule();
        expect(readRemoteCacheRaw()).toEqual(payload);
      });

      it("prefers newer of primary vs fallback when both present", async () => {
        mkdirSync(stateDir(), { recursive: true });
        const primary = { mthds_agent_latest: "0.8.0", plugin_latest: "0.11.0" };
        const fallback = { mthds_agent_latest: "0.8.1", plugin_latest: "0.11.3" };
        writeFileSync(remotePath(), JSON.stringify(primary), "utf-8");
        // Backdate primary by 1h, leave fallback at "now".
        const hourAgo = Math.floor((Date.now() - 60 * 60 * 1000) / 1000);
        utimesSync(remotePath(), hourAgo, hourAgo);

        mkdirSync(fallbackDir(), { recursive: true, mode: 0o700 });
        writeFileSync(fallbackRemotePath(), JSON.stringify(fallback), "utf-8");

        const { readRemoteCache } = await importModule();
        expect(readRemoteCache()).toEqual(fallback);
      });
    });

    describe("writeRemoteCache", () => {
      it("writes the payload to the primary path", async () => {
        const { writeRemoteCache } = await importModule();
        writeRemoteCache({
          mthds_agent_latest: "0.8.1",
          plugin_latest: "0.11.3",
        });
        const content = readFileSync(remotePath(), "utf-8");
        expect(JSON.parse(content)).toEqual({
          mthds_agent_latest: "0.8.1",
          plugin_latest: "0.11.3",
        });
      });

      it("falls back to $TMPDIR on EPERM at the primary path", async () => {
        const target = remotePath();
        writeFailPredicate = (p) => (p === target ? eperm(target) : null);
        const { writeRemoteCache } = await importModule();
        writeRemoteCache({
          mthds_agent_latest: "0.8.1",
          plugin_latest: null,
        });
        expect(existsSync(target)).toBe(false);
        expect(existsSync(fallbackRemotePath())).toBe(true);
      });
    });

    describe("readRemoteCacheRaw", () => {
      it("returns expired payload (no TTL check)", async () => {
        mkdirSync(stateDir(), { recursive: true });
        const payload = { mthds_agent_latest: "0.8.1", plugin_latest: "0.11.3" };
        writeFileSync(remotePath(), JSON.stringify(payload), "utf-8");
        const week = Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000);
        utimesSync(remotePath(), week, week);

        const { readRemoteCache, readRemoteCacheRaw } = await importModule();
        expect(readRemoteCache()).toBeNull(); // TTL gate
        expect(readRemoteCacheRaw()).toEqual(payload); // bypasses TTL
      });

      it("still validates payload shape", async () => {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(remotePath(), "not-json", "utf-8");
        const { readRemoteCacheRaw } = await importModule();
        expect(readRemoteCacheRaw()).toBeNull();
      });
    });

    describe("clearRemoteCache", () => {
      it("removes the remote cache file", async () => {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(remotePath(), '{"mthds_agent_latest":null,"plugin_latest":null}', "utf-8");
        const { clearRemoteCache } = await importModule();
        clearRemoteCache();
        expect(existsSync(remotePath())).toBe(false);
      });

      it("no-ops when file does not exist", async () => {
        const { clearRemoteCache } = await importModule();
        expect(() => clearRemoteCache()).not.toThrow();
      });
    });
  });
});
