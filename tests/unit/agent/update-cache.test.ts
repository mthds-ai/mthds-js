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

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: () => tempHome,
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

const OK_PAYLOAD = {
  mthds_agent: { s: "ok" as const, v: "0.2.1" },
  pipelex_agent: { s: "ok" as const, v: "0.22.0" },
  plxt: { s: "ok" as const, v: "0.3.2" },
};

const OUTDATED_PAYLOAD = {
  mthds_agent: { s: "ok" as const, v: "0.2.1" },
  pipelex_agent: { s: "outdated" as const, v: "0.21.0", r: ">=0.22.0" },
  plxt: { s: "ok" as const, v: "0.3.2" },
};

describe("update-cache", () => {
  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "mthds-cache-test-"));
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
      expect(result!.payload.pipelex_agent.r).toBe(">=0.22.0");
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
  });
});
