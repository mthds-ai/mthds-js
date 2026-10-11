/**
 * The facts of the shared usage-statistics contract this CLI sends by.
 *
 * The contract is the spec `conformance/specs/usage-statistics.md`, whose machine-readable
 * source is `usage-statistics.json`, vendored byte-identical at
 * `tests/fixtures/usage-statistics.json`. This module is its TypeScript copy for the `mthds`
 * tool: `tests/unit/usage-stats/contract.test.ts` checks every value below against the vendored
 * file, and `tests/unit/usage-stats/event.test.ts` checks the events this package builds against
 * the file's declarations, so the two cannot drift without a test failing.
 */

export const SCHEMA_VERSION = 1;

/** The `tool` this package reports as, for both of its CLIs. */
export const TOOL = "mthds";

/** The entry points of the `mthds` tool, the `surface` property. */
export const SURFACES = ["mthds", "mthds-agent"] as const;
export type Surface = (typeof SURFACES)[number];

// ── Destination ─────────────────────────────────────────────────────

/** The capture host of the PostHog project "Open-source usage", in the EU region. */
export const CAPTURE_HOST = "https://eu.i.posthog.com";
export const BATCH_PATH = "/batch/";
/** The project's token: public by design, it can only write events, and the gate decides what is kept. */
export const PROJECT_TOKEN = "phc_uQjSVbzNPJxA8bHxfevn7NMzB6PbC6aJQRB6ka6MxT7a";
export const PERSON_PROFILE_PROPERTY = "$process_person_profile";

// ── Notice ──────────────────────────────────────────────────────────

export const NOTICE_VERSION = 1;
export const NOTICE_DETAILS_URL = "https://docs.pipelex.com/latest/setup/usage-statistics/";
export const NOTICE_DISABLE_COMMAND = "mthds telemetry disable";
/** The notice as this tool prints it: the schema's text with this tool's way to disable. */
export const NOTICE_TEXT =
  "Pipelex collects anonymous usage statistics: counts of commands, runs, pipe types, models and tokens, " +
  "and the country your IP address maps to; the address itself is never stored. It never collects your " +
  "methods, prompts, inputs, outputs, file names or pipe names. To turn it off, run " +
  `\`${NOTICE_DISABLE_COMMAND}\` or set DO_NOT_TRACK=1. Details: ${NOTICE_DETAILS_URL}`;

// ── Environment variables ───────────────────────────────────────────

export const ENV = {
  doNotTrack: "DO_NOT_TRACK",
  toolSwitch: "PIPELEX_USAGE_STATS",
  debug: "PIPELEX_USAGE_STATS_DEBUG",
  endpointOverride: "PIPELEX_USAGE_STATS_ENDPOINT",
  host: "PIPELEX_USAGE_STATS_HOST",
  mthdsToolSwitch: "DISABLE_TELEMETRY",
} as const;

/** How each switch variable reads, trimmed and lowercased. */
export const SWITCH_VALUES = {
  /** `DO_NOT_TRACK` and the debug variable have no effect when unset or set to one of these. */
  falsy: ["", "0", "false"],
  /** `PIPELEX_USAGE_STATS` turns statistics off for these. */
  toolSwitchOff: ["0", "false", "no", "off"],
  /** `PIPELEX_USAGE_STATS` has no effect when unset or set to one of these; any other value fails closed. */
  toolSwitchNoEffect: ["", "1", "true", "yes", "on"],
  /** `DISABLE_TELEMETRY` means off, in the environment and in `~/.mthds/config`, for these. */
  mthdsDisableOn: ["1", "true", "yes", "on"],
} as const;

/**
 * The `off_by` tokens of the switches this tool honours, in the contract's order. `packaged_default`,
 * `editor_setting` and `integration_mode` belong to pipelex and the VS Code extension only.
 */
export const OFF_BY_TOKENS = [
  "do_not_track",
  "tool_variable",
  "machine_choice",
  "legacy_mthds_choice",
  "project_setting",
  "invalid_endpoint_override",
] as const;
export type OffByToken = (typeof OFF_BY_TOKENS)[number];

// ── Shared state ────────────────────────────────────────────────────

/** The file names of the shared state directory, `~/.mthds/usage-stats/`. */
export const STATE_FILES = {
  id: "id",
  disabled: "disabled",
  legacyMigrated: "legacy-migrated",
  noticePrefix: "notice-v",
  internal: "internal",
  spool: "spool",
} as const;

/** The legacy opt-out today's `mthds` CLI stored in `~/.mthds/config`. */
export const LEGACY_KEY = "DISABLE_TELEMETRY";

export const SPOOL_LIMITS = {
  maxFilesPerTool: 100,
  maxAgeDays: 30,
  staleClaimMinutes: 10,
  staleTempMinutes: 60,
} as const;

/** The budgets a CLI sends within, in milliseconds. */
export const BUDGETS_MS = {
  cliInProcess: 1000,
  detachedSender: 10000,
} as const;

// ── CI, containers and projects ─────────────────────────────────────

export const CI_VARIABLES = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "BUILD_NUMBER",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "CIRCLECI",
  "TRAVIS",
  "BUILDKITE",
  "TF_BUILD",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "BITBUCKET_BUILD_NUMBER",
  "CODEBUILD_BUILD_ID",
  "DRONE",
  "APPVEYOR",
  "SEMAPHORE",
  "WOODPECKER",
] as const;

export const CONTAINER_MARKERS = {
  files: ["/.dockerenv", "/run/.containerenv"],
  environment: ["container", "KUBERNETES_SERVICE_HOST"],
  cgroupWords: ["docker", "kubepods", "containerd", "lxc"],
} as const;

/** What makes a directory a project root, the way pipelex finds its project configuration. */
export const PROJECT_MARKERS = [
  ".pipelex",
  ".git",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "package.json",
  ".hg",
] as const;

// ── Property values ─────────────────────────────────────────────────

export const HOST_VALUES = ["cocode", "mthds-agent", "other"] as const;
export type HostValue = (typeof HOST_VALUES)[number];

export const OUTCOMES = ["succeeded", "failed", "cancelled"] as const;
export type CommandOutcome = (typeof OUTCOMES)[number];

export const ERROR_DOMAINS = ["input", "config", "runtime", "other"] as const;
export type ErrorDomain = (typeof ERROR_DOMAINS)[number];

/** The `command` values each surface may send; any other command sends `other`. */
export const COMMANDS: Record<Surface, readonly string[]> = {
  mthds: [
    "login",
    "run bundle",
    "run method",
    "run pipe",
    "build inputs method",
    "build inputs pipe",
    "validate bundle",
    "validate method",
    "validate pipe",
    "install",
    "publish",
    "share",
    "config get",
    "config list",
    "config set",
    "runner setup",
    "runner set-default",
    "runner status",
    "package init",
    "package list",
    "package validate",
    "other",
  ],
  "mthds-agent": [
    "bootstrap",
    "install",
    "publish",
    "share",
    "config get",
    "config list",
    "config set",
    "package init",
    "package list",
    "package validate",
    "runner setup api",
    "runner setup pipelex",
    "plxt fmt",
    "plxt lint",
    "doctor",
    "init",
    "validate bundle",
    "validate method",
    "validate pipe",
    "run bundle",
    "run method",
    "run pipe",
    "models",
    "check-model",
    "inputs bundle",
    "inputs method",
    "inputs pipe",
    "codegen check",
    "codegen types",
    "update-check",
    "upgrade",
    "codex apply-config",
    "codex hook",
    "other",
  ],
};

// ── Patterns ────────────────────────────────────────────────────────

/** A random UUID version 4 in its canonical lowercase form: the installation identifier. */
export const INSTALLATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
