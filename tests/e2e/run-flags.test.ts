import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_PATH = join(__dirname, "../../dist/cli.js");

// `mthds run pipe` and `run bundle` used to accept every flag and drop the ones they
// did not declare, so `--dry-run` started a real, paid run. A stub `pipelex` on PATH
// records the command it receives, so these runs cost nothing and reach no API.
describe.skipIf(process.platform === "win32")("mthds run pipe|bundle flags (e2e)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "mthds-run-flags-"));
  const binDir = join(tmp, "bin");
  const argvLog = join(tmp, "pipelex-argv.log");
  const bundlePath = join(tmp, "hello.mthds");

  writeFileSync(bundlePath, 'domain = "demo"\nmain_pipe = "hello"\n', "utf-8");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "pipelex"), `#!/bin/sh\necho "$*" >> "${argvLog}"\n`, "utf-8");
  chmodSync(join(binDir, "pipelex"), 0o755);

  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function runMthds(...args: string[]): { output: string; status: number | null } {
    writeFileSync(argvLog, "", "utf-8");
    const result = spawnSync("node", [CLI_PATH, "--no-logo", ...args], {
      encoding: "utf-8",
      timeout: 10_000,
      env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
    });
    return { output: result.stdout + result.stderr, status: result.status };
  }

  function pipelexCalls(): string[] {
    return readFileSync(argvLog, "utf-8").split("\n").filter(Boolean);
  }

  it.each(["pipe", "bundle"])("forwards --dry-run and --mock-inputs from `run %s`", (sub) => {
    const { status } = runMthds(
      "--runner",
      "pipelex",
      "run",
      sub,
      bundlePath,
      "--dry-run",
      "--mock-inputs",
      "--local",
    );

    expect(status).toBe(0);
    const [call] = pipelexCalls();
    expect(call).toMatch(/^run bundle /);
    expect(call).toContain("--dry-run");
    expect(call).toContain("--mock-inputs");
    expect(call).toContain("--local");
  });

  it.each(["pipe", "bundle"])("refuses a flag `run %s` does not declare", (sub) => {
    const { output, status } = runMthds("--runner", "pipelex", "run", sub, bundlePath, "--dryrun");

    expect(status).toBe(1);
    expect(output).toContain("unknown option '--dryrun'");
    expect(pipelexCalls()).toEqual([]);
  });

  it.each(["pipe", "bundle"])("refuses --hosted with --local on `run %s`", (sub) => {
    const { output, status } = runMthds(
      "--runner",
      "pipelex",
      "run",
      sub,
      bundlePath,
      "--hosted",
      "--local",
    );

    expect(status).toBe(1);
    expect(output).toContain("cannot be used with option '--local'");
    expect(pipelexCalls()).toEqual([]);
  });

  it("still reads the global options given after the subcommand", () => {
    const { status } = runMthds("run", "bundle", bundlePath, "--runner", "pipelex", "-L", tmp);

    expect(status).toBe(0);
    const [call] = pipelexCalls();
    expect(call).toContain(`-L ${tmp}`);
  });
});
