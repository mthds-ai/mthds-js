import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Every event this package builds is checked against the vendored schema the way the project's
// gate reads it, for both surfaces, every command it lists, every outcome and the optional
// properties, so an event the gate would drop cannot ship.

let tempHome: string;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => tempHome };
});

import {
  buildCommandCompleted,
  commandValue,
  commonProperties,
  hostFromEnvironment,
} from "../../../src/usage-stats/event.js";
import type { CommonContext } from "../../../src/usage-stats/event.js";
import { COMMANDS, SURFACES } from "../../../src/usage-stats/contract.js";
import type { Surface } from "../../../src/usage-stats/contract.js";
import { gateProblems } from "./schema.js";

const INSTALLATION_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function context(surface: Surface, overrides: Partial<CommonContext> = {}): CommonContext {
  return {
    surface,
    toolVersion: "0.31.0",
    installation: { id: INSTALLATION_ID, idNew: false, persisted: true },
    env: {},
    ...overrides,
  };
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "mthds-event-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("command_completed", () => {
  for (const surface of SURFACES) {
    it(`passes the gate for every command ${surface} lists`, () => {
      for (const command of COMMANDS[surface]) {
        const event = buildCommandCompleted(context(surface), {
          command,
          outcome: "succeeded",
          durationMs: 42,
        });
        expect(gateProblems(event as unknown as Record<string, unknown>, "mthds")).toEqual([]);
        expect(event.properties["command"]).toBe(command);
      }
    });
  }

  it("passes the gate with every optional property set", () => {
    const event = buildCommandCompleted(
      context("mthds-agent", { env: { PIPELEX_USAGE_STATS_HOST: "cocode" } }),
      {
        command: "run pipe",
        outcome: "failed",
        errorDomain: "input",
        durationMs: 1234.6,
        hosted: true,
      },
    );
    expect(gateProblems(event as unknown as Record<string, unknown>, "mthds")).toEqual([]);
    expect(event.properties).toMatchObject({
      host: "cocode",
      error_domain: "input",
      hosted: true,
      duration_ms: 1235,
      outcome: "failed",
    });
  });

  it("sends `other` for a command the schema does not list, never the command itself", () => {
    expect(commandValue("mthds", "run start")).toBe("other");
    expect(commandValue("mthds-agent", "run start")).toBe("other");
    const event = buildCommandCompleted(context("mthds"), {
      command: "qcanary7f3a",
      outcome: "succeeded",
      durationMs: 1,
    });
    expect(event.properties["command"]).toBe("other");
    expect(JSON.stringify(event)).not.toContain("qcanary7f3a");
  });

  it("leaves error_domain out unless the command failed", () => {
    const event = buildCommandCompleted(context("mthds"), {
      command: "install",
      outcome: "cancelled",
      errorDomain: "input",
      durationMs: 5,
    });
    expect(event.properties).not.toHaveProperty("error_domain");
    expect(gateProblems(event as unknown as Record<string, unknown>, "mthds")).toEqual([]);
  });

  it("keeps duration_ms within the schema's bounds", () => {
    const negative = buildCommandCompleted(context("mthds"), {
      command: "install",
      outcome: "succeeded",
      durationMs: -3,
    });
    const huge = buildCommandCompleted(context("mthds"), {
      command: "install",
      outcome: "succeeded",
      durationMs: 1e12,
    });
    expect(negative.properties["duration_ms"]).toBe(0);
    expect(huge.properties["duration_ms"]).toBe(2_592_000_000);
  });

  it("draws a fresh uuid and a millisecond UTC timestamp for each event", () => {
    const first = buildCommandCompleted(context("mthds"), {
      command: "install",
      outcome: "succeeded",
      durationMs: 1,
    });
    const second = buildCommandCompleted(context("mthds"), {
      command: "install",
      outcome: "succeeded",
      durationMs: 1,
    });
    expect(first.uuid).not.toBe(second.uuid);
    expect(first.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(first.distinct_id).toBe(INSTALLATION_ID);
  });
});

describe("common properties", () => {
  it("carry the machine's internal marker and the notice version seen", () => {
    const state = join(tempHome, ".mthds", "usage-stats");
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "internal"), "");
    writeFileSync(join(state, "notice-v1"), "");
    const properties = commonProperties(context("mthds"));
    expect(properties).toMatchObject({ internal: true, notice_version: 1 });
  });

  it("say whether the process created the identifier", () => {
    const properties = commonProperties(
      context("mthds", { installation: { id: INSTALLATION_ID, idNew: true, persisted: false } }),
    );
    expect(properties["id_new"]).toBe(true);
  });

  it("detect CI by the contract's variables", () => {
    expect(commonProperties(context("mthds", { env: { GITHUB_ACTIONS: "true" } }))["ci"]).toBe(
      true,
    );
    expect(commonProperties(context("mthds", { env: { CI: "false" } }))["ci"]).toBe(false);
  });

  it("send node-<major> as the language runtime", () => {
    expect(commonProperties(context("mthds"))["language_runtime"]).toMatch(/^node-\d+$/);
  });
});

describe("host", () => {
  it.each([
    [undefined, undefined],
    ["", undefined],
    ["mthds-agent", "mthds-agent"],
    [" Cocode ", "cocode"],
    ["something-else", "other"],
  ])("reads PIPELEX_USAGE_STATS_HOST=%j as %j", (value, expected) => {
    expect(
      hostFromEnvironment(value === undefined ? {} : { PIPELEX_USAGE_STATS_HOST: value }),
    ).toBe(expected);
  });
});
