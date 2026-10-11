import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BATCH_PATH,
  BUDGETS_MS,
  CAPTURE_HOST,
  CI_VARIABLES,
  COMMANDS,
  CONTAINER_MARKERS,
  ENV,
  ERROR_DOMAINS,
  HOST_VALUES,
  LEGACY_KEY,
  NOTICE_DETAILS_URL,
  NOTICE_DISABLE_COMMAND,
  NOTICE_TEXT,
  NOTICE_VERSION,
  OFF_BY_TOKENS,
  OUTCOMES,
  PERSON_PROFILE_PROPERTY,
  PROJECT_MARKERS,
  PROJECT_TOKEN,
  SCHEMA_VERSION,
  SPOOL_LIMITS,
  STATE_FILES,
  SURFACES,
  SWITCH_VALUES,
  TOOL,
} from "../../../src/usage-stats/contract.js";
import { SCHEMA, SCHEMA_PATH, noticeFor } from "./schema.js";

// src/usage-stats/contract.ts is this package's copy of the shared schema: every value it holds is
// checked here against the vendored file, so the two cannot drift without a failing test.

describe("the vendored schema", () => {
  it("is the conformance repository's file, byte for byte, when that repository is checked out beside this one", () => {
    // tests/fixtures/ sits two levels below the repository, whose siblings hold `conformance`.
    const canonical = join(
      dirname(SCHEMA_PATH),
      "..",
      "..",
      "..",
      "conformance",
      "specs",
      "usage-statistics.json",
    );
    let canonicalText: string;
    try {
      canonicalText = readFileSync(canonical, "utf-8");
    } catch {
      return; // Not checked out here, as in CI: conformance's own drift check compares the copies.
    }
    expect(readFileSync(SCHEMA_PATH, "utf-8")).toBe(canonicalText);
  });
});

describe("contract constants", () => {
  it("follow the schema's version, destination and person-profile property", () => {
    expect(SCHEMA_VERSION).toBe(SCHEMA.schema_version);
    expect(CAPTURE_HOST).toBe(SCHEMA.destination.capture_host);
    expect(BATCH_PATH).toBe(SCHEMA.destination.batch_path);
    expect(PROJECT_TOKEN).toBe(SCHEMA.destination.project_token);
    expect(PERSON_PROFILE_PROPERTY).toBe(SCHEMA.person_profile_property);
  });

  it("print the schema's notice with this tool's way to disable", () => {
    expect(NOTICE_VERSION).toBe(SCHEMA.notice.version);
    expect(NOTICE_DETAILS_URL).toBe(SCHEMA.notice.details_url);
    expect(NOTICE_DISABLE_COMMAND).toBe(SCHEMA.notice.disable_commands[TOOL]);
    expect(NOTICE_TEXT).toBe(noticeFor(TOOL));
  });

  it("read the schema's variables and values", () => {
    expect(ENV).toEqual({
      doNotTrack: SCHEMA.environment["do_not_track"],
      toolSwitch: SCHEMA.environment["tool_switch"],
      debug: SCHEMA.environment["debug"],
      endpointOverride: SCHEMA.environment["endpoint_override"],
      host: SCHEMA.environment["host"],
      mthdsToolSwitch: SCHEMA.environment["mthds_tool_switch"],
    });
    expect(SWITCH_VALUES).toEqual({
      falsy: SCHEMA.switch_values["falsy"],
      toolSwitchOff: SCHEMA.switch_values["tool_switch_off"],
      toolSwitchNoEffect: SCHEMA.switch_values["tool_switch_no_effect"],
      mthdsDisableOn: SCHEMA.switch_values["mthds_disable_on"],
    });
  });

  it("honour exactly the switches the schema gives this tool, in its order", () => {
    const honoured = SCHEMA.switches
      .filter((entry) => entry.tools.includes(TOOL))
      .map((entry) => entry.token);
    expect([...OFF_BY_TOKENS]).toEqual(honoured);
  });

  it("name the shared state's files, the legacy key, and the spool's limits as the schema does", () => {
    expect(STATE_FILES).toEqual({
      id: SCHEMA.state["id"],
      disabled: SCHEMA.state["disabled"],
      legacyMigrated: SCHEMA.state["legacy_migrated"],
      noticePrefix: SCHEMA.state["notice_prefix"],
      internal: SCHEMA.state["internal"],
      spool: SCHEMA.state["spool"],
    });
    expect(LEGACY_KEY).toBe(SCHEMA.state["legacy_key"]);
    expect(SPOOL_LIMITS).toEqual({
      maxFilesPerTool: SCHEMA.spool["max_files_per_tool"],
      maxAgeDays: SCHEMA.spool["max_age_days"],
      staleClaimMinutes: SCHEMA.spool["stale_claim_minutes"],
      staleTempMinutes: SCHEMA.spool["stale_temp_minutes"],
    });
    expect(BUDGETS_MS).toEqual({
      cliInProcess: SCHEMA.budgets_ms["cli_in_process"],
      detachedSender: SCHEMA.budgets_ms["detached_sender"],
    });
  });

  it("detect CI, containers and projects by the schema's lists", () => {
    expect([...CI_VARIABLES]).toEqual(SCHEMA.ci_variables);
    expect(CONTAINER_MARKERS).toEqual({
      files: SCHEMA.container_markers.files,
      environment: SCHEMA.container_markers.environment,
      cgroupWords: SCHEMA.container_markers.cgroup_words,
    });
    expect([...PROJECT_MARKERS]).toEqual(SCHEMA.project_markers);
  });

  it("send only the values the schema declares", () => {
    const common = SCHEMA.common_properties;
    const command = SCHEMA.events["command_completed"]!;
    expect(SCHEMA.events["command_completed"]!.tools).toContain(TOOL);
    expect(common["tool"]!.values).toContain(TOOL);
    expect([...SURFACES]).toEqual(common["surface"]!.values_by!.values[TOOL]);
    expect([...HOST_VALUES]).toEqual(common["host"]!.values);
    expect([...OUTCOMES]).toEqual(command.properties["outcome"]!.values);
    expect([...ERROR_DOMAINS]).toEqual(command.properties["error_domain"]!.values);
    for (const surface of SURFACES) {
      expect([...COMMANDS[surface]]).toEqual(
        command.properties["command"]!.values_by!.values[surface],
      );
    }
  });
});
