import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tempHome: string;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: () => tempHome,
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

describe("snooze", () => {
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "mthds-snooze-test-"));
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
  });
});
