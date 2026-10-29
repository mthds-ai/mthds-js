import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The switches, each read from an environment the test hands in and from a temporary home, so the
// machine running the tests never turns one on.

let tempHome: string;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => tempHome };
});

import {
  isDoNotTrack,
  methodEventsOffBy,
  resolveEndpoint,
  toolSwitchSaysOff,
  usageStatsOffBy,
} from "../../../src/usage-stats/switches.js";
import { findProjectRoot, projectSettingTurnsOff } from "../../../src/usage-stats/project.js";
import { CAPTURE_HOST } from "../../../src/usage-stats/contract.js";
import { SCHEMA } from "./schema.js";

let work: string;

function offBy(env: NodeJS.ProcessEnv, cwd = work): string[] {
  return usageStatsOffBy({ env, cwd });
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "mthds-switches-"));
  work = join(tempHome, "work");
  mkdirSync(work, { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("DO_NOT_TRACK", () => {
  it.each(SCHEMA.switch_values["falsy"]!)("leaves statistics on at %j", (value) => {
    expect(isDoNotTrack({ DO_NOT_TRACK: value })).toBe(false);
  });

  it.each(["1", "true", "yes", "anything", " FALSE-ish "])(
    "turns statistics off at %j",
    (value) => {
      expect(isDoNotTrack({ DO_NOT_TRACK: value })).toBe(true);
    },
  );

  it("reads FALSE and padded values case-insensitively", () => {
    expect(isDoNotTrack({ DO_NOT_TRACK: " FALSE " })).toBe(false);
  });
});

describe("PIPELEX_USAGE_STATS", () => {
  it.each(SCHEMA.switch_values["tool_switch_off"]!)("turns statistics off at %j", (value) => {
    expect(toolSwitchSaysOff({ PIPELEX_USAGE_STATS: value })).toBe(true);
  });

  it.each(SCHEMA.switch_values["tool_switch_no_effect"]!)("has no effect at %j", (value) => {
    expect(toolSwitchSaysOff({ PIPELEX_USAGE_STATS: value })).toBe(false);
  });

  it("fails closed on a value it cannot read", () => {
    expect(toolSwitchSaysOff({ PIPELEX_USAGE_STATS: "maybe" })).toBe(true);
  });
});

describe("the endpoint override", () => {
  it("posts to PostHog's capture host when unset", () => {
    expect(resolveEndpoint({})).toBe(CAPTURE_HOST);
  });

  it.each(["http://127.0.0.1:8123", "http://localhost:9", "http://[::1]:65535"])(
    "accepts the loopback origin %s",
    (value) => {
      expect(resolveEndpoint({ PIPELEX_USAGE_STATS_ENDPOINT: value })).toBe(value);
    },
  );

  it.each([
    "",
    "https://eu.i.posthog.com",
    "http://127.0.0.1",
    "http://127.0.0.1:0",
    "http://127.0.0.1:70000",
    "http://127.0.0.1:8123/",
    "http://example.com:8123",
    "https://127.0.0.1:8123",
  ])("turns statistics off at %j", (value) => {
    expect(resolveEndpoint({ PIPELEX_USAGE_STATS_ENDPOINT: value })).toBeUndefined();
    expect(offBy({ PIPELEX_USAGE_STATS_ENDPOINT: value })).toEqual(["invalid_endpoint_override"]);
  });

  it("overrides the host a caller names as it overrides PostHog's capture host", () => {
    const host = "https://events.example.com";
    expect(resolveEndpoint({}, host)).toBe(host);
    expect(resolveEndpoint({ PIPELEX_USAGE_STATS_ENDPOINT: "http://127.0.0.1:8123" }, host)).toBe(
      "http://127.0.0.1:8123",
    );
    expect(resolveEndpoint({ PIPELEX_USAGE_STATS_ENDPOINT: "https://x" }, host)).toBeUndefined();
  });
});

describe("usageStatsOffBy", () => {
  it("is empty when nothing says off", () => {
    expect(offBy({})).toEqual([]);
  });

  it("reads DISABLE_TELEMETRY in the environment as this CLI's own tool variable", () => {
    expect(offBy({ DISABLE_TELEMETRY: "1" })).toEqual(["tool_variable"]);
    expect(offBy({ DISABLE_TELEMETRY: "0" })).toEqual([]);
  });

  it("lists every switch at once, in the contract's order", () => {
    const state = join(tempHome, ".mthds", "usage-stats");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "disabled"), "");
    writeFileSync(join(tempHome, ".mthds", "config"), "DISABLE_TELEMETRY=1\n");
    mkdirSync(join(work, ".pipelex"));
    writeFileSync(join(work, ".pipelex", "pipelex.toml"), "[usage_stats]\nenabled = false\n");
    expect(
      offBy({
        DO_NOT_TRACK: "1",
        PIPELEX_USAGE_STATS: "0",
        PIPELEX_USAGE_STATS_ENDPOINT: "https://example.com",
      }),
    ).toEqual([
      "do_not_track",
      "tool_variable",
      "machine_choice",
      "legacy_mthds_choice",
      "project_setting",
      "invalid_endpoint_override",
    ]);
  });
});

describe("methodEventsOffBy", () => {
  it("follows the method-event switches only", () => {
    mkdirSync(join(work, ".pipelex"));
    writeFileSync(join(work, ".pipelex", "pipelex.toml"), "[usage_stats]\nenabled = false\n");
    vi.spyOn(process, "cwd").mockReturnValue(work);
    expect(
      methodEventsOffBy({
        PIPELEX_USAGE_STATS: "0",
        PIPELEX_USAGE_STATS_ENDPOINT: "http://127.0.0.1:8123",
      }),
    ).toEqual([]);
    expect(methodEventsOffBy({ DO_NOT_TRACK: "1", DISABLE_TELEMETRY: "true" })).toEqual([
      "do_not_track",
      "tool_variable",
    ]);
  });

  it("goes off at an endpoint override that is not a loopback origin", () => {
    expect(methodEventsOffBy({ PIPELEX_USAGE_STATS_ENDPOINT: "https://x" })).toEqual([
      "invalid_endpoint_override",
    ]);
  });

  it("follows the machine choice and the legacy opt-out", () => {
    mkdirSync(join(tempHome, ".mthds", "usage-stats"), { recursive: true });
    writeFileSync(join(tempHome, ".mthds", "usage-stats", "disabled"), "");
    writeFileSync(join(tempHome, ".mthds", "config"), "DISABLE_TELEMETRY=yes\n");
    expect(methodEventsOffBy({})).toEqual(["machine_choice", "legacy_mthds_choice"]);
  });
});

describe("the project setting", () => {
  function project(toml: string | undefined, marker = ".git"): string {
    const root = join(work, "repo");
    mkdirSync(join(root, marker), { recursive: true });
    if (toml !== undefined) {
      mkdirSync(join(root, ".pipelex"), { recursive: true });
      writeFileSync(join(root, ".pipelex", "pipelex.toml"), toml);
    }
    const nested = join(root, "src", "deep");
    mkdirSync(nested, { recursive: true });
    return nested;
  }

  it("finds the nearest project root by its markers, never the home directory", () => {
    const nested = project(undefined);
    expect(findProjectRoot(nested, tempHome)).toBe(join(work, "repo"));
    writeFileSync(join(tempHome, "package.json"), "{}");
    expect(findProjectRoot(work, tempHome)).toBeUndefined();
  });

  it.each([
    ["enabled = false", "[usage_stats]\nenabled = false\n", true],
    ["enabled = true", "[usage_stats]\nenabled = true\n", false],
    ["no usage_stats table", "[other]\nx = 1\n", false],
    ["no enabled key", "[usage_stats]\n", false],
    ["invalid TOML", "[usage_stats\n", true],
    ["enabled of the wrong type", '[usage_stats]\nenabled = "no"\n', true],
    ["usage_stats of the wrong type", "usage_stats = 3\n", true],
  ])("reads %s", (_label, toml, off) => {
    expect(projectSettingTurnsOff(project(toml), tempHome)).toBe(off);
  });

  it("ignores a project without a .pipelex/pipelex.toml", () => {
    expect(projectSettingTurnsOff(project(undefined, "pyproject.toml"), tempHome)).toBe(false);
  });
});
