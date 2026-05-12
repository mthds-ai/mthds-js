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

let tempHome: string;
let tempTmp: string | undefined;

// Pluggable failure predicates so individual tests can simulate sandbox EPERM
// on writes / mkdirs / unlinks without touching real filesystem perms.
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
  return await import("../../../src/agent/snooze.js");
}

function stateDir() {
  return join(tempHome, ".mthds", "state");
}

function snoozePath() {
  return join(stateDir(), "update-snoozed");
}

function fallbackDir() {
  return join(tempTmp ?? tmpdir(), "mthds-agent");
}

function fallbackSnoozePath() {
  return join(fallbackDir(), "update-snoozed");
}

function eperm(path: string): NodeJS.ErrnoException {
  const err = new Error(`EPERM: operation not permitted, '${path}'`) as NodeJS.ErrnoException;
  err.code = "EPERM";
  return err;
}

describe("snooze", () => {
  beforeEach(() => {
    writeFailPredicate = null;
    mkdirFailPredicate = null;
    unlinkFailPredicate = null;
    tempTmp = undefined;
    tempHome = mkdtempSync(join(tmpdir(), "mthds-snooze-test-"));
    tempTmp = join(tempHome, "tmp");
    mkdirSync(tempTmp, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // readSnooze
  // ---------------------------------------------------------------------------
  describe("readSnooze", () => {
    it("returns null when file does not exist", async () => {
      const { readSnooze } = await importModule();
      expect(readSnooze()).toBeNull();
    });

    it("returns null when file has corrupt format", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(snoozePath(), "garbage\n", "utf-8");

      const { readSnooze } = await importModule();
      expect(readSnooze()).toBeNull();
    });

    it("returns null when level is zero", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(snoozePath(), "ok:ok:ok 0 1711440000000\n", "utf-8");

      const { readSnooze } = await importModule();
      expect(readSnooze()).toBeNull();
    });

    it("returns null when level is negative", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(snoozePath(), "ok:ok:ok -1 1711440000000\n", "utf-8");

      const { readSnooze } = await importModule();
      expect(readSnooze()).toBeNull();
    });

    it("parses valid snooze line correctly", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(snoozePath(), "ok:ok:outdated>=0.3.2 2 1711440000000\n", "utf-8");

      const { readSnooze } = await importModule();
      const state = readSnooze();
      expect(state).not.toBeNull();
      expect(state!.versionKey).toBe("ok:ok:outdated>=0.3.2");
      expect(state!.level).toBe(2);
      expect(state!.epoch).toBe(1711440000000);
    });

    it("reads the fallback when only the fallback file exists", async () => {
      mkdirSync(fallbackDir(), { recursive: true });
      writeFileSync(
        fallbackSnoozePath(),
        "ok:ok:outdated>=0.3.2 2 1711440000000\n",
        "utf-8"
      );

      const { readSnooze } = await importModule();
      const state = readSnooze();
      expect(state).not.toBeNull();
      expect(state!.versionKey).toBe("ok:ok:outdated>=0.3.2");
      expect(state!.level).toBe(2);
    });

    it("prefers the newer file when fallback is newer than primary", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(snoozePath(), `KEY_A 1 ${Date.now()}\n`, "utf-8");
      const old = new Date(Date.now() - 30 * 60 * 1000);
      utimesSync(snoozePath(), old, old);

      mkdirSync(fallbackDir(), { recursive: true });
      writeFileSync(fallbackSnoozePath(), `KEY_B 2 ${Date.now()}\n`, "utf-8");

      const { readSnooze } = await importModule();
      expect(readSnooze()!.versionKey).toBe("KEY_B");
    });

    it("prefers the newer file when primary is newer than fallback", async () => {
      mkdirSync(fallbackDir(), { recursive: true });
      writeFileSync(fallbackSnoozePath(), `KEY_B 2 ${Date.now()}\n`, "utf-8");
      const old = new Date(Date.now() - 30 * 60 * 1000);
      utimesSync(fallbackSnoozePath(), old, old);

      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(snoozePath(), `KEY_A 1 ${Date.now()}\n`, "utf-8");

      const { readSnooze } = await importModule();
      expect(readSnooze()!.versionKey).toBe("KEY_A");
    });

    it("treats empty content as null (sandbox-cleared file)", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(snoozePath(), "", "utf-8");

      const { readSnooze } = await importModule();
      expect(readSnooze()).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // writeSnooze
  // ---------------------------------------------------------------------------
  describe("writeSnooze", () => {
    it("creates file with level 1 on first write", async () => {
      const { writeSnooze, readSnooze } = await importModule();
      writeSnooze("ok:ok:outdated>=0.3.2");

      const state = readSnooze();
      expect(state).not.toBeNull();
      expect(state!.level).toBe(1);
      expect(state!.versionKey).toBe("ok:ok:outdated>=0.3.2");
    });

    it("escalates to level 2 for same versionKey", async () => {
      const { writeSnooze, readSnooze } = await importModule();
      writeSnooze("ok:ok:outdated>=0.3.2");
      writeSnooze("ok:ok:outdated>=0.3.2");

      const state = readSnooze();
      expect(state!.level).toBe(2);
    });

    it("escalates to level 3 for same versionKey on third snooze", async () => {
      const { writeSnooze, readSnooze } = await importModule();
      writeSnooze("ok:ok:outdated>=0.3.2");
      writeSnooze("ok:ok:outdated>=0.3.2");
      writeSnooze("ok:ok:outdated>=0.3.2");

      const state = readSnooze();
      expect(state!.level).toBe(3);
    });

    it("resets to level 1 when versionKey changes", async () => {
      const { writeSnooze, readSnooze } = await importModule();
      writeSnooze("ok:ok:outdated>=0.3.2");
      writeSnooze("ok:ok:outdated>=0.3.2");
      writeSnooze("ok:ok:outdated>=0.4.0"); // different key

      const state = readSnooze();
      expect(state!.level).toBe(1);
      expect(state!.versionKey).toBe("ok:ok:outdated>=0.4.0");
    });

    it("falls back to $TMPDIR when primary writeFileSync throws EPERM", async () => {
      writeFailPredicate = (p) => (p === snoozePath() ? eperm(p) : null);

      const { writeSnooze } = await importModule();
      writeSnooze("ok:ok:outdated>=0.3.2");

      expect(existsSync(snoozePath())).toBe(false);
      expect(existsSync(fallbackSnoozePath())).toBe(true);
      const content = readFileSync(fallbackSnoozePath(), "utf-8");
      expect(content).toMatch(/^ok:ok:outdated>=0\.3\.2 1 \d+\n$/);
    });

    it("falls back to $TMPDIR when primary mkdirSync throws EPERM", async () => {
      mkdirFailPredicate = (p) => (p === stateDir() ? eperm(p) : null);

      const { writeSnooze } = await importModule();
      writeSnooze("ok:ok:outdated>=0.3.2");

      expect(existsSync(snoozePath())).toBe(false);
      expect(existsSync(fallbackSnoozePath())).toBe(true);
    });

    it("escalates correctly when only the fallback file exists", async () => {
      writeFailPredicate = (p) => (p === snoozePath() ? eperm(p) : null);

      const { writeSnooze } = await importModule();
      writeSnooze("ok:ok:outdated>=0.3.2");
      writeSnooze("ok:ok:outdated>=0.3.2");

      const content = readFileSync(fallbackSnoozePath(), "utf-8");
      expect(content).toMatch(/^ok:ok:outdated>=0\.3\.2 2 \d+\n$/);
    });

    it("escalates against the newer file when both primary and fallback exist", async () => {
      // Older primary at level 2, newer fallback at level 3, primary is EPERM.
      // writeSnooze must read the newer (fallback level 3) and write level 4
      // to the fallback (since primary is blocked).
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(snoozePath(), `KEY 2 ${Date.now() - 100}\n`, "utf-8");
      const old = new Date(Date.now() - 30 * 60 * 1000);
      utimesSync(snoozePath(), old, old);

      mkdirSync(fallbackDir(), { recursive: true });
      writeFileSync(fallbackSnoozePath(), `KEY 3 ${Date.now()}\n`, "utf-8");

      writeFailPredicate = (p) => (p === snoozePath() ? eperm(p) : null);

      const { writeSnooze } = await importModule();
      writeSnooze("KEY");

      const content = readFileSync(fallbackSnoozePath(), "utf-8");
      expect(content).toMatch(/^KEY 4 \d+\n$/);
    });

    it("resets to level 1 when versionKey differs from the newer file", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(snoozePath(), `KEY_A 2 ${Date.now() - 100}\n`, "utf-8");
      const old = new Date(Date.now() - 30 * 60 * 1000);
      utimesSync(snoozePath(), old, old);

      mkdirSync(fallbackDir(), { recursive: true });
      writeFileSync(fallbackSnoozePath(), `KEY_B 3 ${Date.now()}\n`, "utf-8");

      const { writeSnooze, readSnooze } = await importModule();
      writeSnooze("KEY_C"); // different from both

      const state = readSnooze();
      expect(state!.versionKey).toBe("KEY_C");
      expect(state!.level).toBe(1);
    });

    it("emits the warning at most once per process when both writes fail", async () => {
      writeFailPredicate = () => eperm("any");
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const { writeSnooze } = await importModule();
      writeSnooze("K");
      writeSnooze("K");
      writeSnooze("K");

      const snoozeWarnings = stderrSpy.mock.calls.filter((c) =>
        String(c[0]).includes("could not write snooze state")
      );
      expect(snoozeWarnings).toHaveLength(1);

      stderrSpy.mockRestore();
    });

    it("does not warn when fallback succeeds", async () => {
      writeFailPredicate = (p) => (p === snoozePath() ? eperm(p) : null);
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const { writeSnooze } = await importModule();
      writeSnooze("K");

      const snoozeWarnings = stderrSpy.mock.calls.filter((c) =>
        String(c[0]).includes("could not write snooze state")
      );
      expect(snoozeWarnings).toHaveLength(0);

      stderrSpy.mockRestore();
    });
  });

  // ---------------------------------------------------------------------------
  // isSnoozed
  // ---------------------------------------------------------------------------
  describe("isSnoozed", () => {
    it("returns false when no snooze file exists", async () => {
      const { isSnoozed } = await importModule();
      expect(isSnoozed("ok:ok:ok")).toBe(false);
    });

    it("returns false when versionKey differs", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(
        snoozePath(),
        `ok:ok:outdated>=0.3.2 1 ${Date.now()}\n`,
        "utf-8"
      );

      const { isSnoozed } = await importModule();
      expect(isSnoozed("different:key:here")).toBe(false);
    });

    it("returns true within 24h window at level 1", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(
        snoozePath(),
        `ok:ok:outdated>=0.3.2 1 ${Date.now()}\n`,
        "utf-8"
      );

      const { isSnoozed } = await importModule();
      expect(isSnoozed("ok:ok:outdated>=0.3.2")).toBe(true);
    });

    it("returns false after 24h at level 1", async () => {
      mkdirSync(stateDir(), { recursive: true });
      const expired = Date.now() - 25 * 60 * 60 * 1000; // 25h ago
      writeFileSync(
        snoozePath(),
        `ok:ok:outdated>=0.3.2 1 ${expired}\n`,
        "utf-8"
      );

      const { isSnoozed } = await importModule();
      expect(isSnoozed("ok:ok:outdated>=0.3.2")).toBe(false);
    });

    it("returns true within 48h at level 2", async () => {
      mkdirSync(stateDir(), { recursive: true });
      const recent = Date.now() - 30 * 60 * 60 * 1000; // 30h ago (within 48h)
      writeFileSync(
        snoozePath(),
        `ok:ok:outdated>=0.3.2 2 ${recent}\n`,
        "utf-8"
      );

      const { isSnoozed } = await importModule();
      expect(isSnoozed("ok:ok:outdated>=0.3.2")).toBe(true);
    });

    it("returns true within 7d at level 3", async () => {
      mkdirSync(stateDir(), { recursive: true });
      const recent = Date.now() - 3 * 24 * 60 * 60 * 1000; // 3 days ago (within 7d)
      writeFileSync(
        snoozePath(),
        `ok:ok:outdated>=0.3.2 3 ${recent}\n`,
        "utf-8"
      );

      const { isSnoozed } = await importModule();
      expect(isSnoozed("ok:ok:outdated>=0.3.2")).toBe(true);
    });

    it("uses the epoch from the newer file (not the file mtime)", async () => {
      // Older primary has a *fresh* epoch — would say snoozed.
      // Newer fallback has an *expired* epoch — should win and say not snoozed.
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(snoozePath(), `KEY 1 ${Date.now()}\n`, "utf-8");
      const old = new Date(Date.now() - 30 * 60 * 1000);
      utimesSync(snoozePath(), old, old);

      mkdirSync(fallbackDir(), { recursive: true });
      const expiredEpoch = Date.now() - 25 * 60 * 60 * 1000;
      writeFileSync(fallbackSnoozePath(), `KEY 1 ${expiredEpoch}\n`, "utf-8");

      const { isSnoozed } = await importModule();
      expect(isSnoozed("KEY")).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // computeVersionKey
  // ---------------------------------------------------------------------------
  describe("computeVersionKey", () => {
    it("produces consistent key for same input", async () => {
      const { computeVersionKey } = await importModule();
      const payload = {
        mthds_agent: { s: "ok" as const, v: "0.2.1" },
        pipelex_agent: { s: "ok" as const, v: "0.22.0" },
        plxt: { s: "ok" as const, v: "0.3.2" },
      };
      expect(computeVersionKey(payload)).toBe(computeVersionKey(payload));
    });

    it("produces 2-part key when pipelex_agent is absent", async () => {
      const { computeVersionKey } = await importModule();
      const payload = {
        mthds_agent: { s: "ok" as const, v: "0.2.1" },
        plxt: { s: "ok" as const, v: "0.3.2" },
      };
      expect(computeVersionKey(payload)).toBe("ok:ok");
    });

    it("changes when constraint changes", async () => {
      const { computeVersionKey } = await importModule();
      const payload1 = {
        mthds_agent: { s: "ok" as const, v: "0.2.1" },
        pipelex_agent: { s: "ok" as const, v: "0.22.0" },
        plxt: { s: "outdated" as const, v: "0.3.1", r: ">=0.3.2" },
      };
      const payload2 = {
        mthds_agent: { s: "ok" as const, v: "0.2.1" },
        pipelex_agent: { s: "ok" as const, v: "0.22.0" },
        plxt: { s: "outdated" as const, v: "0.3.1", r: ">=0.4.0" },
      };
      expect(computeVersionKey(payload1)).not.toBe(computeVersionKey(payload2));
    });
  });

  // ---------------------------------------------------------------------------
  // clearSnooze
  // ---------------------------------------------------------------------------
  describe("clearSnooze", () => {
    it("removes the snooze file", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(snoozePath(), "ok:ok:ok 1 12345\n", "utf-8");

      const { clearSnooze } = await importModule();
      clearSnooze();
      expect(existsSync(snoozePath())).toBe(false);
    });

    it("no-ops when file does not exist", async () => {
      const { clearSnooze } = await importModule();
      expect(() => clearSnooze()).not.toThrow();
    });

    it("deletes both primary and fallback paths", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(snoozePath(), "ok:ok:ok 1 12345\n", "utf-8");
      mkdirSync(fallbackDir(), { recursive: true });
      writeFileSync(fallbackSnoozePath(), "ok:ok:ok 1 12345\n", "utf-8");

      const { clearSnooze } = await importModule();
      clearSnooze();

      expect(existsSync(snoozePath())).toBe(false);
      expect(existsSync(fallbackSnoozePath())).toBe(false);
    });

    it("self-heals by overwriting with empty content when unlink fails", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(snoozePath(), "ok:ok:ok 1 12345\n", "utf-8");
      unlinkFailPredicate = (p) => (p === snoozePath() ? eperm(p) : null);

      const { clearSnooze, readSnooze } = await importModule();
      clearSnooze();

      expect(existsSync(snoozePath())).toBe(true);
      expect(readFileSync(snoozePath(), "utf-8")).toBe("");
      expect(readSnooze()).toBeNull();
    });

    it("warns once when neither unlink nor overwrite can clear the file", async () => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(snoozePath(), "ok:ok:ok 1 12345\n", "utf-8");
      unlinkFailPredicate = () => eperm("blocked");
      writeFailPredicate = () => eperm("blocked");

      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const { clearSnooze } = await importModule();
      clearSnooze();
      clearSnooze();

      const clearWarnings = stderrSpy.mock.calls.filter((c) =>
        String(c[0]).includes("could not clear snooze state")
      );
      expect(clearWarnings).toHaveLength(1);

      stderrSpy.mockRestore();
    });

    it("does not warn when both files are absent", async () => {
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const { clearSnooze } = await importModule();
      clearSnooze();

      const clearWarnings = stderrSpy.mock.calls.filter((c) =>
        String(c[0]).includes("could not clear snooze state")
      );
      expect(clearWarnings).toHaveLength(0);

      stderrSpy.mockRestore();
    });
  });
});
