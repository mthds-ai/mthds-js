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
const DUMMY_PASSWORD = "hunter2-dummy";
const URL_WITH_CREDENTIALS = `https://user:${DUMMY_PASSWORD}@example.com`;

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

  it("hides the credentials of a base URL, in config get and list and in the refusal of config set", () => {
    const env = { MTHDS_BASE_URL: URL_WITH_CREDENTIALS };
    expect(agent(["config", "get", "base-url"], env)).toEqual({
      key: "base-url",
      value: "https://…@example.com",
      masked: true,
      source: "env",
    });
    expect(JSON.stringify(agent(["config", "list"], env))).not.toContain(DUMMY_PASSWORD);

    const refused = run(AGENT_CLI, [
      "config",
      "set",
      "base-url",
      URL_WITH_CREDENTIALS,
      "--error-format",
      "json",
    ]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).not.toContain(DUMMY_PASSWORD);
    expect((JSON.parse(refused.stderr) as { message?: string }).message).toBe(
      "Invalid URL: https://…@example.com",
    );
  });
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

  it("hides the credentials of a base URL", () => {
    const env = { MTHDS_BASE_URL: URL_WITH_CREDENTIALS, ...NO_PIPELEX };
    for (const args of [
      ["config", "get", "base-url"],
      ["config", "list"],
      ["runner", "status"],
    ]) {
      const printed = run(MTHDS_CLI, args, env);
      expect(printed.stdout + printed.stderr).not.toContain(DUMMY_PASSWORD);
      expect(printed.stdout).toContain("https://…@example.com");
    }
    const refused = run(MTHDS_CLI, ["config", "set", "base-url", URL_WITH_CREDENTIALS]);
    expect(refused.status).toBe(1);
    expect(refused.stdout + refused.stderr).not.toContain(DUMMY_PASSWORD);
  });
});
