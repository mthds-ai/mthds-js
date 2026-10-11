import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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

// `mthds telemetry` reads and writes the state every reporting tool shares, under a temporary
// home here. Its verbs are the contract's: `status` (read-only, `--format json` answering the
// status object), `disable`, `enable` and `reset-id`.

let tempHome: string;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => tempHome };
});

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../../src/cli/commands/index.js", () => ({ printLogo: vi.fn() }));

import * as p from "@clack/prompts";
import {
  telemetryDisable,
  telemetryEnable,
  telemetryResetId,
  telemetryStatus,
} from "../../../src/cli/commands/telemetry.js";

const INSTALLATION_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const STATUS_KEYS = [
  "tool",
  "enabled",
  "off_by",
  "installation_id",
  "notice_version",
  "internal",
  "ci",
  "container",
  "state_dir",
];

function stateDir(): string {
  return join(tempHome, ".mthds", "usage-stats");
}

function seedSpools(): void {
  for (const tool of ["mthds", "pipelex", "plxt"]) {
    const directory = join(stateDir(), "spool", tool);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${Date.now()}-abc123.json`), '{"spool_version":1,"events":[]}');
  }
}

function spooledFiles(): string[] {
  const root = join(stateDir(), "spool");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((tool) => readdirSync(join(root, tool)));
}

function statusJson(): Record<string, unknown> {
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    telemetryStatus({ format: "json" });
    expect(write).toHaveBeenCalledTimes(1);
    return JSON.parse(String(write.mock.calls[0]![0])) as Record<string, unknown>;
  } finally {
    write.mockRestore();
  }
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "mthds-telemetry-"));
  mkdirSync(join(tempHome, "work"), { recursive: true });
  vi.spyOn(process, "cwd").mockReturnValue(join(tempHome, "work"));
  vi.clearAllMocks();
  for (const name of Object.keys(process.env)) {
    if (
      name.startsWith("PIPELEX_USAGE_STATS") ||
      name === "DO_NOT_TRACK" ||
      name === "DISABLE_TELEMETRY"
    ) {
      vi.stubEnv(name, undefined);
    }
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("telemetry status", () => {
  it("answers the contract's status object on stdout, and creates nothing", () => {
    const status = statusJson();
    expect(Object.keys(status).sort()).toEqual([...STATUS_KEYS].sort());
    expect(status).toMatchObject({
      tool: "mthds",
      enabled: true,
      off_by: [],
      installation_id: null,
      notice_version: 0,
      internal: false,
      state_dir: stateDir(),
    });
    expect(existsSync(stateDir())).toBe(false);
  });

  it("lists every switch keeping statistics off, in the contract's order", () => {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), "disabled"), "");
    vi.stubEnv("PIPELEX_USAGE_STATS_ENDPOINT", "https://example.com");
    vi.stubEnv("DO_NOT_TRACK", "1");
    const status = statusJson();
    expect(status["enabled"]).toBe(false);
    expect(status["off_by"]).toEqual([
      "do_not_track",
      "machine_choice",
      "invalid_endpoint_override",
    ]);
  });

  it("reports the legacy opt-out without migrating it", () => {
    mkdirSync(join(tempHome, ".mthds"), { recursive: true });
    writeFileSync(join(tempHome, ".mthds", "config"), "DISABLE_TELEMETRY=1\n");
    expect(statusJson()["off_by"]).toEqual(["legacy_mthds_choice"]);
    expect(existsSync(join(stateDir(), "disabled"))).toBe(false);
  });

  it("reports the identifier, the notice seen and the internal marker", () => {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), "id"), `${INSTALLATION_ID}\n`);
    writeFileSync(join(stateDir(), "notice-v1"), "");
    writeFileSync(join(stateDir(), "internal"), "");
    expect(statusJson()).toMatchObject({
      installation_id: INSTALLATION_ID,
      notice_version: 1,
      internal: true,
    });
  });

  it("reports a malformed identifier as null", () => {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), "id"), "not-an-installation-id\n");
    expect(statusJson()["installation_id"]).toBeNull();
  });

  it("says in words what keeps statistics off", () => {
    vi.stubEnv("DO_NOT_TRACK", "1");
    telemetryStatus();
    expect(p.log.info).toHaveBeenCalledWith(expect.stringContaining("DO_NOT_TRACK is set"));
  });
});

describe("telemetry disable", () => {
  it("creates the disabled file and deletes every tool's spool", () => {
    seedSpools();
    telemetryDisable();
    expect(existsSync(join(stateDir(), "disabled"))).toBe(true);
    expect(spooledFiles()).toEqual([]);
    expect(p.log.success).toHaveBeenCalled();
  });

  it("never writes the old opt-out to ~/.mthds/config", () => {
    telemetryDisable();
    expect(existsSync(join(tempHome, ".mthds", "config"))).toBe(false);
  });
});

describe("telemetry enable", () => {
  it("deletes the disabled file and dates the legacy marker past the config file", () => {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), "disabled"), "");
    const configPath = join(tempHome, ".mthds", "config");
    writeFileSync(configPath, "DISABLE_TELEMETRY=1\n");
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(configPath, future, future);

    telemetryEnable();

    expect(existsSync(join(stateDir(), "disabled"))).toBe(false);
    const marker = statSync(join(stateDir(), "legacy-migrated"));
    expect(marker.mtimeMs).toBeGreaterThanOrEqual(statSync(configPath).mtimeMs);
    expect(statusJson()["off_by"]).toEqual([]);
    expect(p.log.success).toHaveBeenCalled();
  });

  it("takes the old opt-out out of ~/.mthds/config, so a later write of the file cannot bring it back", () => {
    const configPath = join(tempHome, ".mthds", "config");
    mkdirSync(join(tempHome, ".mthds"), { recursive: true });
    writeFileSync(configPath, "MTHDS_RUNNER=api\nDISABLE_TELEMETRY=1\n");

    telemetryEnable();

    expect(readFileSync(configPath, "utf-8")).toBe("MTHDS_RUNNER=api\n");
    // Any later rewrite of the file, by any program, is no opt-out.
    const later = new Date(Date.now() + 3_600_000);
    utimesSync(configPath, later, later);
    expect(statusJson()["off_by"]).toEqual([]);
  });

  it("names every switch that still keeps statistics off, rather than claiming success", () => {
    vi.stubEnv("DO_NOT_TRACK", "1");
    vi.stubEnv("PIPELEX_USAGE_STATS", "off");
    telemetryEnable();
    expect(p.log.success).not.toHaveBeenCalled();
    const warning = String(vi.mocked(p.log.warn).mock.calls[0]![0]);
    expect(warning).toContain("DO_NOT_TRACK");
    expect(warning).toContain("PIPELEX_USAGE_STATS");
  });
});

describe("telemetry reset-id", () => {
  it("replaces the identifier, prints the new one and deletes every spool", () => {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), "id"), INSTALLATION_ID);
    seedSpools();

    telemetryResetId();

    const replaced = readFileSync(join(stateDir(), "id"), "utf-8");
    expect(replaced).not.toBe(INSTALLATION_ID);
    expect(replaced).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(spooledFiles()).toEqual([]);
    expect(p.log.success).toHaveBeenCalledWith(expect.stringContaining(replaced));
    expect(readdirSync(stateDir()).filter((name) => name.startsWith("id"))).toEqual(["id"]);
  });

  it("replaces a malformed identifier too", () => {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), "id"), "not-an-installation-id\n");
    telemetryResetId();
    expect(statusJson()["installation_id"]).toBe(readFileSync(join(stateDir(), "id"), "utf-8"));
  });
});
