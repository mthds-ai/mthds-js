/**
 * Publishing, end to end: the built `mthds` and `mthds-agent` publish a local repository to a
 * loopback server standing in for mthds.sh, named by `MTHDS_HUB_URL`, with `DO_NOT_TRACK=1` set,
 * which no longer has any say in publishing. The real hub is never reached.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MTHDS_STANDARD_VERSION } from "../../src/package/manifest/schema.js";
import { startLoopbackServer } from "../support/loopback-server.js";
import type { LoopbackServer } from "../support/loopback-server.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MTHDS = join(__dirname, "../../dist/cli.js");
const MTHDS_AGENT = join(__dirname, "../../dist/agent-cli.js");

const LISTED = {
  address: "Acme/tools",
  name: "scoring",
  version: "1.0.0",
  commit_sha: "8d39d1dca38a4de613c20e85fbaa05dd75024835",
  url: "https://mthds.sh/methods/Acme/tools/scoring",
};

interface Result {
  output: string;
  stdout: string;
  stderr: string;
  status: number | null;
}

let hub: LoopbackServer;
let home: string;
let repo: string;

/** Run without blocking this process, whose event loop serves the fake hub. */
function run(cli: string, args: string[], hubUrl = hub.origin): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn("node", [cli, ...args], {
      cwd: home,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: home,
        LC_ALL: "C",
        TERM: "dumb",
        DO_NOT_TRACK: "1",
        PIPELEX_USAGE_STATS_ENDPOINT: "http://127.0.0.1:9",
        MTHDS_HUB_URL: hubUrl,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ output: stdout + stderr, stdout, stderr, status });
    });
  });
}

function writeMethod(name: string): void {
  const dir = join(repo, "methods", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "METHODS.toml"),
    [
      "[package]",
      `name = "${name}"`,
      'address = "github.com/acme/tools"',
      'version = "1.0.0"',
      `description = "The ${name} method"`,
      `mthds_version = ">=${MTHDS_STANDARD_VERSION}"`,
      "",
      "[exports.tools]",
      'pipes = ["run"]',
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "main.mthds"), 'domain = "tools"\n');
}

beforeAll(async () => {
  hub = await startLoopbackServer();
});

afterAll(async () => {
  await hub.close();
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mthds-publish-e2e-"));
  repo = join(home, "repo");
  writeMethod("scoring");
  hub.requests.length = 0;
  hub.respond(() => ({
    status: 201,
    body: { outcome: "registered", method: LISTED, validation: "queued" },
  }));
});

describe.skipIf(process.platform === "win32")("publishing through the registry route (e2e)", () => {
  it("mthds publish lists a local method by its manifest's address, with DO_NOT_TRACK set", async () => {
    const result = await run(MTHDS, ["--no-logo", "publish", "--local", repo]);
    expect(result.status).toBe(0);
    expect(hub.requests).toEqual([
      {
        method: "POST",
        path: "/api/v1/registry/methods",
        body: { address: "github.com/acme/tools", name: "scoring" },
      },
    ]);
    expect(result.output).toContain(LISTED.url);
    expect(result.output).toContain("Published 1 method to mthds.sh");
  });

  it("mthds publish shows a refusal and exits non-zero, whatever the status says", async () => {
    hub.respond(() => ({
      status: 200,
      body: {
        outcome: "refused",
        reason: "repository_not_found",
        message: "github.com/acme/tools is not a public GitHub repository.",
        errors: [],
      },
    }));
    const result = await run(MTHDS, ["--no-logo", "publish", "--local", repo]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("repository_not_found");
    expect(result.output).not.toContain("Published 1 method");
  });

  it("mthds publish refuses a hub override that is not a loopback origin, before any request", async () => {
    const result = await run(
      MTHDS,
      ["--no-logo", "publish", "--local", repo],
      "https://example.com",
    );
    expect(result.status).toBe(1);
    expect(result.output).toContain("MTHDS_HUB_URL");
    expect(hub.requests).toEqual([]);
  });

  it("mthds-agent publish --local registers nothing, and says so", async () => {
    const result = await run(MTHDS_AGENT, ["publish", "--local", repo]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      published_methods: ["scoring"],
      registrations: [],
      message: expect.stringContaining("Nothing was registered on mthds.sh"),
    });
    expect(hub.requests).toEqual([]);
  });
});
