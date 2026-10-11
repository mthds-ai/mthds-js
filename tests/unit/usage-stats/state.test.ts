import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The state every reporting tool shares, under a temporary home.

let tempHome: string;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => tempHome };
});

import {
  legacyOptOutPending,
  markLegacyMigrated,
  noticeVersionSeen,
  obtainInstallationId,
  readInstallationId,
  recordNoticeShown,
  replaceInstallationId,
  runLegacyMigration,
  stateDir,
} from "../../../src/usage-stats/state.js";
import { INSTALLATION_ID_PATTERN } from "../../../src/usage-stats/contract.js";

const EXISTING_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function configPath(): string {
  return join(tempHome, ".mthds", "config");
}

function writeLegacyConfig(content: string, mtime?: Date): void {
  mkdirSync(join(tempHome, ".mthds"), { recursive: true });
  writeFileSync(configPath(), content);
  if (mtime !== undefined) utimesSync(configPath(), mtime, mtime);
}

function seedSpool(tool: string): string {
  const directory = join(stateDir(), "spool", tool);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${Date.now()}-aaaaaa.json`);
  writeFileSync(path, '{"spool_version":1,"events":[]}');
  return path;
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "mthds-state-"));
});

describe("the installation identifier", () => {
  it("is created once, as a canonical UUID v4, with the directory private to the user", () => {
    const first = obtainInstallationId();
    expect(first).toMatchObject({ idNew: true, persisted: true });
    expect(first.id).toMatch(INSTALLATION_ID_PATTERN);
    expect(readFileSync(join(stateDir(), "id"), "utf-8")).toBe(first.id);
    if (process.platform !== "win32") {
      expect(statSync(stateDir()).mode & 0o777).toBe(0o700);
    }

    const second = obtainInstallationId();
    expect(second).toEqual({ id: first.id, idNew: false, persisted: true });
    expect(readdirSync(stateDir()).filter((name) => name.startsWith("id"))).toEqual(["id"]);
  });

  it("reads an existing identifier, ignoring surrounding whitespace", () => {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), "id"), `  ${EXISTING_ID}\n`);
    expect(obtainInstallationId()).toEqual({ id: EXISTING_ID, idNew: false, persisted: true });
  });

  it.each(["", "not-a-uuid", EXISTING_ID.toUpperCase(), "0f8fad5b-d9cb-169f-a165-70867728950e"])(
    "never rewrites a malformed identifier %j, and reports under one of the process's own",
    (content) => {
      mkdirSync(stateDir(), { recursive: true });
      writeFileSync(join(stateDir(), "id"), content);
      expect(readInstallationId()).toEqual({ kind: "malformed" });
      const installation = obtainInstallationId();
      expect(installation).toMatchObject({ idNew: true, persisted: false });
      expect(installation.id).toMatch(INSTALLATION_ID_PATTERN);
      expect(readFileSync(join(stateDir(), "id"), "utf-8")).toBe(content);
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "gives the process an identifier of its own when the state directory cannot be written",
    () => {
      mkdirSync(stateDir(), { recursive: true });
      chmodSync(stateDir(), 0o500);
      try {
        const installation = obtainInstallationId();
        expect(installation).toMatchObject({ idNew: true, persisted: false });
        expect(existsSync(join(stateDir(), "id"))).toBe(false);
      } finally {
        chmodSync(stateDir(), 0o700);
      }
    },
  );

  it("sweeps a crash's stale temporary file, and leaves a recent one", () => {
    mkdirSync(stateDir(), { recursive: true });
    const stale = join(stateDir(), "id.tmp-stale");
    const recent = join(stateDir(), "id.tmp-recent");
    writeFileSync(stale, "x");
    writeFileSync(recent, "x");
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(stale, twoHoursAgo, twoHoursAgo);

    obtainInstallationId();

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it("is replaced by reset-id, which persists the new one", () => {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), "id"), EXISTING_ID);
    const replaced = replaceInstallationId();
    expect(replaced).not.toBe(EXISTING_ID);
    expect(readInstallationId()).toEqual({ kind: "valid", id: replaced });
  });
});

describe("the notice markers", () => {
  it("record the notice as shown, once per version", () => {
    expect(noticeVersionSeen()).toBe(0);
    expect(recordNoticeShown()).toBe(true);
    expect(noticeVersionSeen()).toBe(1);
    expect(existsSync(join(stateDir(), "notice-v1"))).toBe(true);
  });

  it("count a later version's marker as no newer than this tool's own", () => {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), "notice-v7"), "");
    expect(noticeVersionSeen()).toBe(0);
  });
});

describe("the legacy opt-out", () => {
  it.each(["1", "true", "YES", " on "])("is pending at DISABLE_TELEMETRY=%j", (value) => {
    writeLegacyConfig(`DISABLE_TELEMETRY=${value}\n`);
    expect(legacyOptOutPending()).toBe(true);
  });

  it.each(["0", "false", "", "maybe"])("is not pending at DISABLE_TELEMETRY=%j", (value) => {
    writeLegacyConfig(`DISABLE_TELEMETRY=${value}\n`);
    expect(legacyOptOutPending()).toBe(false);
  });

  it("migrates into the shared state: disabled created, every spool deleted, marker set", () => {
    writeLegacyConfig("DISABLE_TELEMETRY=1\n");
    const mthdsSpool = seedSpool("mthds");
    const pipelexSpool = seedSpool("pipelex");

    expect(runLegacyMigration()).toBe(true);

    expect(existsSync(join(stateDir(), "disabled"))).toBe(true);
    expect(existsSync(mthdsSpool)).toBe(false);
    expect(existsSync(pipelexSpool)).toBe(false);
    expect(existsSync(join(stateDir(), "legacy-migrated"))).toBe(true);
    expect(legacyOptOutPending()).toBe(false);
    expect(readFileSync(configPath(), "utf-8")).toBe("DISABLE_TELEMETRY=1\n");
    expect(runLegacyMigration()).toBe(false);
  });

  it("is pending again when the config file is written after the marker", () => {
    writeLegacyConfig("DISABLE_TELEMETRY=1\n");
    runLegacyMigration();
    writeLegacyConfig("DISABLE_TELEMETRY=1\n", new Date(Date.now() + 60_000));
    expect(legacyOptOutPending()).toBe(true);
  });

  it("is settled by a marker dated past a config file whose clock runs ahead", () => {
    writeLegacyConfig("DISABLE_TELEMETRY=1\n", new Date(Date.now() + 3_600_000));
    markLegacyMigrated();
    expect(statSync(join(stateDir(), "legacy-migrated")).mtimeMs).toBeGreaterThan(
      statSync(configPath()).mtimeMs,
    );
    expect(legacyOptOutPending()).toBe(false);
  });
});
