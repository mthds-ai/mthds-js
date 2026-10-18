import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_PATH = join(__dirname, "../../../dist/agent-cli.js");

function runAgent(...args: string[]): { stdout: string; stderr: string; status: number | null } {
  return runAgentWith({}, ...args);
}

function runAgentWith(
  env: Record<string, string>,
  ...args: string[]
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync("node", [CLI_PATH, ...args], {
    encoding: "utf-8",
    timeout: 10_000,
    env: { ...process.env, ...env },
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

// On the API runner, `validate bundle`/`validate pipe` accept `--format` / `--error-format`.
// These reject an out-of-vocabulary value at option-parse time (a `client.argument_invalid`
// problem) instead of silently coercing the typo to the default `markdown`. Rejection happens before the
// action runs, so no API config or real bundle is needed.
describe("mthds-agent validate --format/--error-format value validation (e2e)", () => {
  it("rejects an invalid --format value instead of silently coercing to markdown", () => {
    const { stderr, status } = runAgent(
      "--runner",
      "api",
      "validate",
      "bundle",
      "nonexistent.mthds",
      "--format",
      "jsno",
      "--error-format",
      "json",
    );
    expect(status).toBe(1);
    const payload = JSON.parse(stderr) as {
      code?: string;
      params?: { argument?: string; reason?: string };
      message?: string;
    };
    expect(payload.code).toBe("client.argument_invalid");
    expect(payload.params?.argument).toContain("--format");
    expect(payload.message).toContain("jsno");
  });

  it("rejects an invalid --error-format value on validate pipe", () => {
    const { stderr, status } = runAgent(
      "--runner",
      "api",
      "validate",
      "pipe",
      "nonexistent.mthds",
      "--error-format",
      "yaml",
    );
    expect(status).toBe(1);
    // An --error-format it cannot read leaves the error stream in its default form, Markdown.
    expect(stderr).toMatch(/^## An argument was refused before sending\n/);
    expect(stderr).toContain("yaml");
    expect(stderr).toContain("- Code: `client.argument_invalid`");
  });
});

// A no-verdict failure of the API runner's validate is written in the form the command line asks
// for, wherever `--error-format` stands. The runtime is a loopback port nothing listens on, so
// every case fails as `client.unreachable` before any verdict.
describe("mthds-agent validate's no-verdict failure in the error format asked for (e2e)", () => {
  const bundleDir = mkdtempSync(join(tmpdir(), "mthds-validate-format-"));
  const bundle = join(bundleDir, "demo.mthds");
  writeFileSync(bundle, 'domain = "demo"\n');
  const unreachable = { MTHDS_BASE_URL: "http://127.0.0.1:9", MTHDS_API_KEY: "test-key" };

  it.each([
    [
      "before the command",
      ["--runner", "api", "--error-format", "json", "validate", "bundle", bundle],
    ],
    [
      "before the command, in its = form",
      ["--runner", "api", "--error-format=json", "validate", "pipe", bundle],
    ],
    [
      "on the validate group",
      ["--runner", "api", "validate", "--error-format", "json", "bundle", bundle],
    ],
    ["on the command", ["--runner", "api", "validate", "bundle", bundle, "--error-format", "json"]],
  ])("writes JSON when --error-format json stands %s", (_where, args) => {
    const { stderr, status } = runAgentWith(unreachable, ...args);
    expect(status).toBe(1);
    const problem = JSON.parse(stderr) as { code?: string };
    expect(problem.code).toBe("client.unreachable");
  });

  it("lets the command's own --error-format win over the one before it", () => {
    const { stderr, status } = runAgentWith(
      unreachable,
      "--runner",
      "api",
      "--error-format",
      "json",
      "validate",
      "bundle",
      bundle,
      "--error-format",
      "markdown",
    );
    expect(status).toBe(1);
    expect(stderr).toMatch(/^## The runtime could not be reached\n/);
  });

  it("lets --error-format json before the command win over the command's --format markdown", () => {
    const { stderr, status } = runAgentWith(
      unreachable,
      "--runner",
      "api",
      "--error-format",
      "json",
      "validate",
      "bundle",
      bundle,
      "--format",
      "markdown",
    );
    expect(status).toBe(1);
    expect((JSON.parse(stderr) as { code?: string }).code).toBe("client.unreachable");
  });
});

// One rule for a repeated `--error-format`, the one Commander applies to any option: the last one
// written wins, whichever command runs and whether it fails before or after its options are read.
describe("mthds-agent's repeated --error-format, the last one winning (e2e)", () => {
  const scratchHome = mkdtempSync(join(tmpdir(), "mthds-error-format-home-"));
  const env = {
    HOME: scratchHome,
    MTHDS_BASE_URL: "http://127.0.0.1:9",
    MTHDS_API_KEY: "test-key",
  };

  it("writes JSON when validate's bundle cannot be read before the request", () => {
    const { stderr, status } = runAgentWith(
      env,
      "--runner",
      "api",
      "--error-format",
      "markdown",
      "validate",
      "bundle",
      "--error-format",
      "json",
      "/does-not-exist.mthds",
    );
    expect(status).toBe(1);
    expect((JSON.parse(stderr) as { code?: string }).code).toBe("client.file_unreadable");
  });

  it("writes JSON when config get refuses its key", () => {
    const { stderr, status } = runAgentWith(
      env,
      "--error-format",
      "markdown",
      "config",
      "get",
      "invalid",
      "--error-format",
      "json",
    );
    expect(status).toBe(1);
    expect((JSON.parse(stderr) as { code?: string }).code).toBe("client.argument_invalid");
  });
});
