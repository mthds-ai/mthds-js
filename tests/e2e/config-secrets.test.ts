import { describe, it, expect, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// No command of either CLI shows the API key whole, nor the credentials of a base URL: an agent
// session that runs `config get api-key` or `config list` would copy them into its transcript.
// Every key here is an obvious dummy, and every run gets a home of its own.

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const AGENT_CLI = join(__dirname, "../../dist/agent-cli.js");
const MTHDS_CLI = join(__dirname, "../../dist/cli.js");

const DUMMY_KEY = "sk-test-dummy-0123456789abcdef";
const DUMMY_KEY_MASKED = "sk-t…def";
const SHORT_DUMMY_KEY = "short-dummy";
const DUMMY_USER = "fakeuser";
const DUMMY_PASSWORD = "FAKEPASS123";
const CREDENTIALS = `${DUMMY_USER}:${DUMMY_PASSWORD}`;

/**
 * A base URL holding credentials, in every form the URL parser reads them from, or a person would
 * write them in: with its scheme, without one, wrapped in whitespace, which the parser trims, and
 * with no slashes or with backslashes after a special scheme, which the parser accepts. The last
 * member is the value as it is shown: everything before its last `@` hidden, the rest kept.
 */
const URLS_WITH_CREDENTIALS: ReadonlyArray<[string, string, string]> = [
  ["with its scheme", `https://${CREDENTIALS}@example.com`, "…@example.com"],
  ["without a scheme", `${CREDENTIALS}@example.com`, "…@example.com"],
  ["wrapped in whitespace", ` https://${CREDENTIALS}@example.com `, "…@example.com "],
  ["with no slashes after the scheme", `https:${CREDENTIALS}@example.com`, "…@example.com"],
  ["with backslashes after the scheme", `https:\\\\${CREDENTIALS}@example.com`, "…@example.com"],
];

/** A `PATH` holding node alone, so that `runner status` finds no `pipelex` to ask its version of. */
const NO_PIPELEX = { PATH: dirname(process.execPath) };

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mthds-config-secrets-"));
});

/** The environment of a run: the test's, without any `MTHDS_*` setting a shell exported, plus `extra`. */
function environment(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("MTHDS_")) env[name] = value;
  }
  return { ...env, HOME: home, USERPROFILE: home, ...extra };
}

function run(
  cli: string,
  args: string[],
  extra: Record<string, string> = {},
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf-8",
    timeout: 15_000,
    env: environment(extra),
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function agent(args: string[], extra: Record<string, string> = {}): Record<string, unknown> {
  const { stdout, stderr, status } = run(AGENT_CLI, args, extra);
  expect(status, stderr).toBe(0);
  return JSON.parse(stdout) as Record<string, unknown>;
}

function apiKeyEntry(listed: Record<string, unknown>): Record<string, unknown> | undefined {
  return (listed["config"] as Array<Record<string, unknown>>).find(
    (entry) => entry["key"] === "api-key",
  );
}

describe("mthds-agent config never answers a secret whole", () => {
  it("masks the key config set saved, config get reads and config list lists", () => {
    const set = agent(["config", "set", "api-key", DUMMY_KEY]);
    expect(set).toEqual({ success: true, key: "api-key", value: DUMMY_KEY_MASKED, masked: true });

    const got = agent(["config", "get", "api-key"]);
    expect(got).toEqual({ key: "api-key", value: DUMMY_KEY_MASKED, masked: true, source: "file" });

    const listed = agent(["config", "list"]);
    expect(apiKeyEntry(listed)).toEqual({
      key: "api-key",
      value: DUMMY_KEY_MASKED,
      masked: true,
      source: "file",
    });
    expect(JSON.stringify([set, got, listed])).not.toContain(DUMMY_KEY);
  });

  it("shows a short key as the mark alone", () => {
    agent(["config", "set", "api-key", SHORT_DUMMY_KEY]);
    expect(agent(["config", "get", "api-key"])["value"]).toBe("…");
    expect(apiKeyEntry(agent(["config", "list"]))?.["value"]).toBe("…");
  });

  it("masks a key set in MTHDS_API_KEY", () => {
    const env = { MTHDS_API_KEY: DUMMY_KEY };
    expect(agent(["config", "get", "api-key"], env)).toEqual({
      key: "api-key",
      value: DUMMY_KEY_MASKED,
      masked: true,
      source: "env",
    });
    expect(apiKeyEntry(agent(["config", "list"], env))?.["value"]).toBe(DUMMY_KEY_MASKED);
  });

  it("answers an unset key as empty, with nothing masked", () => {
    expect(agent(["config", "get", "api-key"])).toEqual({
      key: "api-key",
      value: "",
      source: "default",
    });
  });

  it("masks the key runner setup api saved", () => {
    const { stdout, status } = run(AGENT_CLI, ["runner", "setup", "api", "--api-key", DUMMY_KEY]);
    expect(status).toBe(0);
    expect(stdout).not.toContain(DUMMY_KEY);
    expect(JSON.parse(stdout)).toEqual({
      success: true,
      key: "api-key",
      value: DUMMY_KEY_MASKED,
      masked: true,
    });
  });

  it("never reports the API key in doctor, even masked", () => {
    const report = run(AGENT_CLI, ["doctor", "--format", "json"], {
      MTHDS_API_KEY: DUMMY_KEY,
      ...NO_PIPELEX,
    });
    expect(report.stdout + report.stderr).not.toContain(DUMMY_KEY);
    expect(report.stdout).not.toContain(DUMMY_KEY_MASKED);
    const config = (JSON.parse(report.stdout) as { config: Array<Record<string, unknown>> }).config;
    expect(config.find((entry) => entry["key"] === "api-key")?.["value"]).toBe("configured");
  });

  it.each(URLS_WITH_CREDENTIALS)(
    "hides the credentials of a base URL %s in config get, config list, doctor and the refusal of config set",
    (_form, url, shown) => {
      const env = { MTHDS_BASE_URL: url, ...NO_PIPELEX };
      const got = agent(["config", "get", "base-url"], env);
      expect(got).toEqual({ key: "base-url", value: shown, masked: true, source: "env" });

      const printed = [
        JSON.stringify(got),
        JSON.stringify(agent(["config", "list"], env)),
        run(AGENT_CLI, ["doctor", "--format", "json"], env).stdout,
        run(AGENT_CLI, ["doctor"], env).stdout,
      ];
      const doctor = JSON.parse(printed[2]!) as { config: Array<Record<string, unknown>> };
      expect(doctor.config.find((entry) => entry["key"] === "base-url")).toEqual({
        key: "base-url",
        value: shown,
        masked: true,
        source: "env",
      });
      expect(printed[3]).toContain(`| base-url | ${shown} | env |`);

      const refused = run(AGENT_CLI, ["config", "set", "base-url", url, "--error-format", "json"]);
      expect(refused.status).toBe(1);
      expect((JSON.parse(refused.stderr) as { message?: string }).message).toBe(
        `Invalid URL: ${shown}`,
      );
      printed.push(refused.stdout, refused.stderr);

      for (const output of printed) {
        expect(output).not.toContain(DUMMY_PASSWORD);
        expect(output).not.toContain(DUMMY_USER);
      }
    },
  );
});

describe("mthds config never prints a secret whole", () => {
  it("masks the key config set saved, config get reads and config list lists", () => {
    const set = run(MTHDS_CLI, ["config", "set", "api-key", DUMMY_KEY]);
    const got = run(MTHDS_CLI, ["config", "get", "api-key"]);
    const listed = run(MTHDS_CLI, ["config", "list"]);
    const status = run(MTHDS_CLI, ["runner", "status"], NO_PIPELEX);
    for (const printed of [set, got, listed]) {
      expect(printed.status).toBe(0);
      expect(printed.stdout + printed.stderr).not.toContain(DUMMY_KEY);
      expect(printed.stdout).toContain(`api-key = ${DUMMY_KEY_MASKED}`);
    }
    expect(status.stdout + status.stderr).not.toContain(DUMMY_KEY);
    expect(status.stdout).toContain(`API key:  ${DUMMY_KEY_MASKED}`);
  });

  it("shows a short key as the mark alone and an unset one as not set", () => {
    expect(run(MTHDS_CLI, ["config", "get", "api-key"]).stdout).toContain("api-key = (not set)");
    run(MTHDS_CLI, ["config", "set", "api-key", SHORT_DUMMY_KEY]);
    const got = run(MTHDS_CLI, ["config", "get", "api-key"]);
    expect(got.stdout).toContain("api-key = …");
    expect(got.stdout).not.toContain(SHORT_DUMMY_KEY);
  });

  it.each(URLS_WITH_CREDENTIALS)(
    "hides the credentials of a base URL %s in config get, config list, runner status and the refusal of config set",
    (_form, url, shown) => {
      const env = { MTHDS_BASE_URL: url, ...NO_PIPELEX };
      const printed: string[] = [];
      for (const args of [
        ["config", "get", "base-url"],
        ["config", "list"],
        ["runner", "status"],
      ]) {
        const output = run(MTHDS_CLI, args, env);
        expect(output.stdout).toContain(shown);
        printed.push(output.stdout, output.stderr);
      }
      const refused = run(MTHDS_CLI, ["config", "set", "base-url", url]);
      expect(refused.status).toBe(1);
      expect(refused.stdout).toContain(`Invalid URL: ${shown}`);
      printed.push(refused.stdout, refused.stderr);

      for (const output of printed) {
        expect(output).not.toContain(DUMMY_PASSWORD);
        expect(output).not.toContain(DUMMY_USER);
      }
    },
  );
});
