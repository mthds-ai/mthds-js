/**
 * Publishing, end to end: the built `mthds` and `mthds-agent` publish a local repository to a
 * loopback server standing in for mthds.sh, named by `MTHDS_HUB_URL`, with `DO_NOT_TRACK=1` set,
 * which no longer has any say in publishing. GitHub, which a local publish asks whether the
 * manifest's repository is public, is a stub `gh` first on the PATH. The case that turns the
 * method events on points `PIPELEX_USAGE_STATS_ENDPOINT` at a second loopback server standing in
 * for PostHog. Neither the real hub, nor GitHub, nor PostHog is ever reached.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
let capture: LoopbackServer;
let home: string;
let repo: string;
let bin: string;

/** What the stub `gh` answers about the repository: `gh api repos/<org>/<repo>`. */
type GitHubAnswer = "public" | "private" | "missing";

/**
 * A stand-in for the `gh` CLI, first on the PATH: logged in, recording each call, and answering
 * the visibility the test asks for, so a publish asks GitHub without reaching it.
 */
function writeStubGh(): void {
  const script = [
    "#!/bin/sh",
    'echo "$*" >> "$HOME/gh-calls.log"',
    'case "$1" in',
    "  auth) exit 0 ;;",
    "  api)",
    '    if [ "$STUB_GH_ANSWER" = "missing" ]; then echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi',
    '    if [ "$STUB_GH_ANSWER" = "private" ]; then echo \'{"private": true}\'; else echo \'{"private": false}\'; fi',
    "    exit 0 ;;",
    "esac",
    "exit 1",
    "",
  ].join("\n");
  writeFileSync(join(bin, "gh"), script);
  chmodSync(join(bin, "gh"), 0o755);
}

function ghCalls(): string[] {
  const log = join(home, "gh-calls.log");
  return existsSync(log) ? readFileSync(log, "utf-8").trim().split("\n") : [];
}

/**
 * What the CLI may send besides the publish: nothing (`DO_NOT_TRACK=1`), or its method events,
 * posted to the loopback capture server, with `PIPELEX_USAGE_STATS=0` keeping the usage statistics,
 * which that switch reaches and the method events do not, out of the way.
 */
type Events = "off" | "method-events-to-capture";

/** Run without blocking this process, whose event loop serves the fake hub. */
function run(
  cli: string,
  args: string[],
  options: { hubUrl?: string; github?: GitHubAnswer; events?: Events } = {},
): Promise<Result> {
  const events: NodeJS.ProcessEnv =
    options.events === "method-events-to-capture"
      ? { PIPELEX_USAGE_STATS: "0", PIPELEX_USAGE_STATS_ENDPOINT: capture.origin }
      : { DO_NOT_TRACK: "1", PIPELEX_USAGE_STATS_ENDPOINT: "http://127.0.0.1:9" };
  return new Promise((resolve) => {
    const child = spawn("node", [cli, ...args], {
      cwd: home,
      env: {
        PATH: [bin, process.env["PATH"] ?? ""].join(delimiter),
        HOME: home,
        LC_ALL: "C",
        TERM: "dumb",
        ...events,
        MTHDS_HUB_URL: options.hubUrl ?? hub.origin,
        STUB_GH_ANSWER: options.github ?? "public",
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
  capture = await startLoopbackServer();
});

afterAll(async () => {
  await hub.close();
  await capture.close();
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mthds-publish-e2e-"));
  repo = join(home, "repo");
  bin = join(home, "bin");
  mkdirSync(bin);
  writeStubGh();
  writeMethod("scoring");
  hub.requests.length = 0;
  capture.requests.length = 0;
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
    expect(ghCalls()).toContain("api repos/acme/tools");
  });

  it("mthds publish sends its method_publish to a loopback endpoint override, not PostHog", async () => {
    const result = await run(MTHDS, ["--no-logo", "publish", "--local", repo], {
      events: "method-events-to-capture",
    });
    expect(result.status).toBe(0);
    expect(capture.requests).toHaveLength(1);
    const [post] = capture.requests;
    expect(post).toMatchObject({ method: "POST", path: "/batch/" });
    const { batch } = post!.body as { batch: { event: string; properties: unknown }[] };
    expect(batch).toHaveLength(1);
    expect(batch[0]).toMatchObject({
      event: "method_publish",
      properties: { address: LISTED.address, name: LISTED.name, package_version: LISTED.version },
    });
  });

  it.each([
    ["private", "acme/tools is a private repository"],
    ["missing", "GitHub has no public repository acme/tools"],
  ] as const)(
    "mthds publish --local refuses a %s repository without sending its name to the hub",
    async (github, message) => {
      const result = await run(MTHDS, ["--no-logo", "publish", "--local", repo], { github });
      expect(result.status).toBe(1);
      expect(result.output).toContain(message);
      expect(hub.requests).toEqual([]);
    },
  );

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
    const result = await run(MTHDS, ["--no-logo", "publish", "--local", repo], {
      hubUrl: "https://example.com",
    });
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
