/**
 * The usage statistics, end to end: the built `mthds` and `mthds-agent` run in an environment
 * built from nothing (a scratch home, no inherited switch), posting to a loopback server that
 * stands in for PostHog's capture host. Every event they print or post is checked against the
 * vendored schema.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startLoopbackServer } from "../support/loopback-server.js";
import type { LoopbackServer } from "../support/loopback-server.js";
import { gateProblems, noticeFor } from "../unit/usage-stats/schema.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MTHDS = join(__dirname, "../../dist/cli.js");
const MTHDS_AGENT = join(__dirname, "../../dist/agent-cli.js");
const NOTICE = noticeFor("mthds");

interface Result {
  stdout: string;
  stderr: string;
  status: number | null;
}

interface DebugEvent {
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
}

let server: LoopbackServer;
let home: string;
let work: string;

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env["PATH"] ?? "",
    HOME: home,
    LC_ALL: "C",
    TERM: "dumb",
    PIPELEX_USAGE_STATS_ENDPOINT: server.origin,
    ...extra,
  };
}

/**
 * Run a CLI without blocking this process, whose event loop serves the loopback server the CLI
 * posts to: a synchronous spawn would leave every post unanswered until the CLI had exited.
 */
function run(cli: string, args: string[], extra: Record<string, string> = {}): Promise<Result> {
  return new Promise((resolve) => {
    const child = spawn("node", [cli, ...args], { cwd: work, env: baseEnv(extra) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf-8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status });
    });
  });
}

function debugEvents(stderr: string): DebugEvent[] {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith('{"usage_stats_debug"'))
    .map((line) => (JSON.parse(line) as { usage_stats_debug: DebugEvent }).usage_stats_debug);
}

function onlyEvent(stderr: string): DebugEvent {
  const events = debugEvents(stderr);
  expect(events).toHaveLength(1);
  const event = events[0]!;
  expect(gateProblems(event as unknown as Record<string, unknown>, "mthds")).toEqual([]);
  return event;
}

function stateDir(): string {
  return join(home, ".mthds", "usage-stats");
}

function spoolDirectory(): string {
  return join(stateDir(), "spool", "mthds");
}

function spooled(): string[] {
  const directory = spoolDirectory();
  return existsSync(directory) ? readdirSync(directory) : [];
}

async function postedEvents(count: number, withinMs = 8_000): Promise<DebugEvent[]> {
  const until = Date.now() + withinMs;
  for (;;) {
    const events = server.requests.flatMap(
      (request) => (request.body as { batch: DebugEvent[] }).batch,
    );
    if (events.length >= count || Date.now() > until) return events;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const DEBUG = { PIPELEX_USAGE_STATS_DEBUG: "1" };

beforeAll(async () => {
  server = await startLoopbackServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mthds-usage-e2e-"));
  work = join(home, "work");
  mkdirSync(work);
  server.requests.length = 0;
  server.receivedAt.length = 0;
  server.respond(() => ({ status: 200, body: { status: "Ok" } }));
});

describe.skipIf(process.platform === "win32")("mthds usage statistics (e2e)", () => {
  it("prints the notice once, then counts the command", async () => {
    const first = await run(MTHDS, ["config", "list"], DEBUG);
    expect(first.status).toBe(0);
    expect(first.stderr.split(NOTICE)).toHaveLength(2);
    const event = onlyEvent(first.stderr);
    expect(event.event).toBe("command_completed");
    expect(event.properties).toMatchObject({
      tool: "mthds",
      surface: "mthds",
      command: "config list",
      outcome: "succeeded",
      id_new: true,
      notice_version: 1,
    });
    expect(readFileSync(join(stateDir(), "id"), "utf-8")).toBe(event.distinct_id);

    const second = await run(MTHDS, ["config", "list"], DEBUG);
    expect(second.stderr).not.toContain(NOTICE);
    expect(onlyEvent(second.stderr)).toMatchObject({
      distinct_id: event.distinct_id,
      properties: { id_new: false },
    });
  });

  it("does nothing at all while DO_NOT_TRACK is set", async () => {
    const result = await run(MTHDS, ["config", "list"], { ...DEBUG, DO_NOT_TRACK: "1" });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain(NOTICE);
    expect(debugEvents(result.stderr)).toEqual([]);
    expect(existsSync(join(stateDir(), "id"))).toBe(false);
  });

  it("is turned off for good by `mthds telemetry disable`, which it does not count", async () => {
    const disable = await run(MTHDS, ["telemetry", "disable"], DEBUG);
    expect(disable.status).toBe(0);
    expect(debugEvents(disable.stderr)).toEqual([]);
    expect(existsSync(join(stateDir(), "disabled"))).toBe(true);
    expect(debugEvents((await run(MTHDS, ["config", "list"], DEBUG)).stderr)).toEqual([]);
  });

  it.each([["--help"], ["--version"], ["config"], ["telemetry", "status"]])(
    "sends nothing for `mthds %s`",
    async (...args) => {
      expect(debugEvents((await run(MTHDS, args, DEBUG)).stderr)).toEqual([]);
    },
  );

  it("counts a command that failed to parse as failed on its input", async () => {
    const result = await run(MTHDS, ["config", "get", "--no-such-option"], DEBUG);
    expect(result.status).not.toBe(0);
    expect(onlyEvent(result.stderr).properties).toMatchObject({
      command: "config get",
      outcome: "failed",
      error_domain: "input",
    });
  });

  it("answers `telemetry status --format json` with the status object alone on stdout", async () => {
    const result = await run(MTHDS, ["telemetry", "status", "--format", "json"], {
      DO_NOT_TRACK: "1",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      tool: "mthds",
      enabled: false,
      off_by: ["do_not_track"],
      state_dir: stateDir(),
    });
  });

  it.each([
    [["--local"], false],
    [["--hosted"], true],
    [["--inputs", "--local"], undefined],
  ] as const)("reads hosted from the run's parsed flags %j", async (flags, hosted) => {
    // The API runner, on the loopback server, refuses the missing bundle before any request.
    const result = await run(MTHDS, ["--runner", "api", "run", "pipe", "missing.mthds", ...flags], {
      ...DEBUG,
      MTHDS_BASE_URL: server.origin,
    });
    const event = onlyEvent(result.stderr);
    expect(event.properties["command"]).toBe("run pipe");
    expect(event.properties["hosted"]).toBe(hosted);
  });

  it("posts the event before exiting in CI, and leaves nothing spooled", async () => {
    const result = await run(MTHDS, ["config", "list"], { CI: "true" });
    expect(result.status).toBe(0);
    expect(server.requests).toHaveLength(1);
    const [event] = await postedEvents(1, 0);
    expect(event!.properties).toMatchObject({ command: "config list", ci: true });
    expect(gateProblems(event as unknown as Record<string, unknown>, "mthds")).toEqual([]);
    expect(spooled()).toEqual([]);
  });

  it("queues its event for the endpoint it resolved, written as the variable gave it", async () => {
    // Nothing listens there, so the post fails and the event stays queued.
    const unanswered = "http://localhost:9";
    const result = await run(MTHDS, ["config", "list"], {
      CI: "true",
      PIPELEX_USAGE_STATS_ENDPOINT: unanswered,
    });
    expect(result.status).toBe(0);
    const files = spooled();
    expect(files).toHaveLength(1);
    const held = JSON.parse(readFileSync(join(spoolDirectory(), files[0]!), "utf-8")) as {
      events: DebugEvent[];
    };
    expect(held).toMatchObject({ spool_version: 1, endpoint: unanswered });
    expect(held.events.map((queued) => queued.properties["command"])).toEqual(["config list"]);
  });

  it("leaves a file queued for another endpoint in the spool, posting only its own", async () => {
    // A file an earlier run queued under another loopback override, its event made under the
    // machine's identifier, so nothing but its endpoint keeps it from this sender's post.
    const id = "6f1c2b9e-3d4a-4b5c-8d6e-7f8091a2b3c4";
    mkdirSync(spoolDirectory(), { recursive: true });
    writeFileSync(join(stateDir(), "id"), id);
    const queuedName = `${Date.now() - 1_000}-abcdef012345.json`;
    writeFileSync(
      join(spoolDirectory(), queuedName),
      JSON.stringify({
        spool_version: 1,
        endpoint: "http://127.0.0.1:9",
        events: [
          {
            event: "command_completed",
            distinct_id: id,
            uuid: "0b6c8f0e-2f6a-4d3b-9c1e-5a7d9e2f4b6c",
            properties: { command: "install" },
          },
        ],
      }),
    );
    const result = await run(MTHDS, ["config", "list"]);
    expect(result.status).toBe(0);
    // The sender takes the older file first, so it has left it by the time the command's arrives.
    const events = await postedEvents(1);
    expect(events.map((posted) => posted.properties["command"])).toEqual(["config list"]);
    expect(events[0]!.distinct_id).toBe(id);
    expect(spooled()).toContain(queuedName);
  });

  it("hands the event to a detached sender otherwise", async () => {
    const result = await run(MTHDS, ["config", "list"]);
    expect(result.status).toBe(0);
    const events = await postedEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.properties).toMatchObject({ command: "config list", ci: false });
  });

  it("posts an event made under a process-local identifier directly, never spooling it", async () => {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), "id"), "not-an-identifier\n");
    await run(MTHDS, ["config", "list"]);
    const events = await postedEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.distinct_id).not.toBe("not-an-identifier");
    expect(events[0]!.properties["id_new"]).toBe(true);
    expect(spooled()).toEqual([]);
    expect(readFileSync(join(stateDir(), "id"), "utf-8")).toBe("not-an-identifier\n");
  });

  it("does not wait at exit for the post of an event made under a process-local identifier", async () => {
    // A capture host slow to answer: a command that waited for its sender would stay until the
    // one-second budget ran out, long after the post arrived.
    server.respond(() => ({ status: 200, body: { status: "Ok" }, delayMs: 3_000 }));
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), "id"), "not-an-identifier\n");
    let exitedAt = 0;
    const result = await run(MTHDS, ["config", "list"]).then((done) => {
      exitedAt = Date.now();
      return done;
    });
    expect(result.status).toBe(0);
    const events = await postedEvents(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.properties["id_new"]).toBe(true);
    expect(exitedAt - server.receivedAt[0]!).toBeLessThan(500);
    expect(spooled()).toEqual([]);
  });

  it("posts an event made under a process-local identifier before exiting in CI", async () => {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), "id"), "not-an-identifier\n");
    const result = await run(MTHDS, ["config", "list"], { CI: "true" });
    expect(result.status).toBe(0);
    expect(server.requests).toHaveLength(1);
    expect(spooled()).toEqual([]);
  });

  it("gives first runs racing on a fresh machine one identifier, created once", async () => {
    const runs = Array.from(
      { length: 4 },
      async () => (await run(MTHDS, ["config", "list"], DEBUG)).stderr,
    );
    const events = (await Promise.all(runs)).map((stderr) => onlyEvent(stderr));
    const ids = new Set(events.map((event) => event.distinct_id));
    expect(ids.size).toBe(1);
    expect(events.filter((event) => event.properties["id_new"] === true)).toHaveLength(1);
    expect(readFileSync(join(stateDir(), "id"), "utf-8")).toBe([...ids][0]);
  });
});

/** Every `--format` and `--error-format` combination, each absent, `json` or `markdown`. */
const FORMAT_FLAGS: readonly (readonly string[])[] = [undefined, "json", "markdown"].flatMap(
  (format) =>
    [undefined, "json", "markdown"].map((errorFormat) => [
      ...(format === undefined ? [] : ["--format", format]),
      ...(errorFormat === undefined ? [] : ["--error-format", errorFormat]),
    ]),
);

/** A `pipelex-agent` first on the PATH, answering `--version` with `version` and running fine. */
function stubPipelexAgent(version: string): Record<string, string> {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "pipelex-agent"),
    [
      "#!/bin/sh",
      `if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi`,
      'echo "ran"',
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "pipelex-agent"), 0o755);
  return { PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}` };
}

/** The notice was neither printed on this run's stderr nor recorded on the machine. */
function expectNoNotice(result: Result): void {
  expect(result.stderr).not.toContain(NOTICE);
  expect(result.stderr).not.toContain("collects anonymous usage statistics");
  expect(readdirSync(stateDir()).filter((name) => name.startsWith("notice-v"))).toEqual([]);
}

/** The one event the run posted before exiting, as a command in CI does. */
function sentEvent(): DebugEvent {
  expect(server.requests).toHaveLength(1);
  const batch = (server.requests[0]!.body as { batch: DebugEvent[] }).batch;
  expect(batch).toHaveLength(1);
  const event = batch[0]!;
  expect(gateProblems(event as unknown as Record<string, unknown>, "mthds")).toEqual([]);
  return event;
}

describe.skipIf(process.platform === "win32")("mthds-agent usage statistics (e2e)", () => {
  // mthds-agent's stderr is a machine contract: it never prints or records the notice, and still
  // sends the run's statistics. A pipelex-agent it runs applies its own rule.

  it("counts a native command without ever printing the notice", async () => {
    const result = await run(MTHDS_AGENT, ["config", "list"], DEBUG);
    expect(result.status).toBe(0);
    expectNoNotice(result);
    expect(onlyEvent(result.stderr).properties).toMatchObject({
      surface: "mthds-agent",
      command: "config list",
      outcome: "succeeded",
    });
    expect(JSON.parse(result.stdout)).toBeTypeOf("object");
  });

  it("keeps a JSON error stream one JSON document, and sends the failure", async () => {
    const result = await run(
      MTHDS_AGENT,
      ["config", "get", "no-such-key", "--error-format", "json"],
      { CI: "true" },
    );
    expect(result.status).not.toBe(0);
    expectNoNotice(result);
    expect(JSON.parse(result.stderr)).toMatchObject({ code: "client.argument_invalid" });
    expect(sentEvent().properties).toMatchObject({
      command: "config get",
      outcome: "failed",
      error_domain: "input",
    });
  });

  it("keeps the default Markdown error stream free of the notice, and sends the failure", async () => {
    const result = await run(MTHDS_AGENT, ["config", "get", "no-such-key"], { CI: "true" });
    expect(result.status).not.toBe(0);
    expectNoNotice(result);
    expect(result.stderr).toMatch(/^## An argument was refused before sending\n/);
    expect(result.stderr).toContain("- Code: `client.argument_invalid`");
    expect(sentEvent().properties).toMatchObject({ command: "config get", outcome: "failed" });
  });

  describe.each(FORMAT_FLAGS.map((flags) => [flags.join(" ") || "no format flag", flags]))(
    "with %s",
    (_label, flags) => {
      it("never prints or records the notice on a success, and sends it", async () => {
        const result = await run(
          MTHDS_AGENT,
          ["--runner", "pipelex", "run", "pipe", "x.mthds", ...flags],
          {
            ...stubPipelexAgent("pipelex 99.0.0"),
            CI: "true",
          },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("ran");
        expectNoNotice(result);
        expect(sentEvent().properties).toMatchObject({
          surface: "mthds-agent",
          command: "run pipe",
          outcome: "succeeded",
        });
      });

      it("never prints or records the notice on a parse failure, and sends it", async () => {
        const result = await run(MTHDS_AGENT, ["--runner", "api", "validate", "pipe", ...flags], {
          CI: "true",
        });
        expect(result.status).not.toBe(0);
        expectNoNotice(result);
        expect(sentEvent().properties).toMatchObject({
          surface: "mthds-agent",
          command: "validate pipe",
          outcome: "failed",
        });
      });

      it("never prints or records the notice on a refusal in the command, and sends it", async () => {
        const result = await run(
          MTHDS_AGENT,
          ["--runner", "api", "validate", "pipe", "not-a-bundle", ...flags],
          { MTHDS_BASE_URL: server.origin, CI: "true" },
        );
        expect(result.status).not.toBe(0);
        expectNoNotice(result);
        expect(sentEvent().properties).toMatchObject({
          surface: "mthds-agent",
          command: "validate pipe",
          outcome: "failed",
        });
      });
    },
  );

  it.each(["markdown", "json"])(
    "sends an invalid bundle's verdict as the caller's to fix under %s errors",
    async (errorFormat) => {
      writeFileSync(join(work, "bundle.mthds"), 'domain = "demo"\n');
      // The loopback server stands in for the API runner too, answering its handshake with no
      // blob store, so the tree travels inline, and its validate with an invalid verdict and its
      // server-rendered Markdown.
      const runnerPath = (path: string): boolean =>
        path.endsWith("/validate") || path.endsWith("/version");
      server.respond((request) => {
        if (request.path.endsWith("/version")) {
          return { status: 200, body: { protocol_version: "1.0.0" } };
        }
        return request.path.endsWith("/validate")
          ? {
              status: 200,
              body: {
                is_valid: false,
                message: "Bundle is invalid",
                pending_signatures: [],
                is_runnable: false,
                errors: [{ code: "method.syntax", detail: "boom" }],
                rendered_markdown: "# Validation failed\n\nboom",
              },
            }
          : { status: 200, body: { status: "Ok" } };
      });
      const result = await run(
        MTHDS_AGENT,
        ["--runner", "api", "validate", "pipe", "bundle.mthds", "--error-format", errorFormat],
        { MTHDS_BASE_URL: server.origin, CI: "true" },
      );
      expect(result.status).toBe(1);
      expect(result.stderr.startsWith("# Validation failed")).toBe(errorFormat === "markdown");
      const captures = server.requests.filter((request) => !runnerPath(request.path));
      expect(captures).toHaveLength(1);
      const [event] = (captures[0]!.body as { batch: DebugEvent[] }).batch;
      expect(gateProblems(event as unknown as Record<string, unknown>, "mthds")).toEqual([]);
      expect(event!.properties).toMatchObject({
        surface: "mthds-agent",
        command: "validate pipe",
        outcome: "failed",
        error_domain: "input",
      });
    },
  );

  it.each([
    ["its JSON error about an outdated tool", "pipelex 0.0.1", 1],
    ["its JSON warning about an unreadable version", "weird", 0],
  ])(
    "never prints or records the notice beside %s, and sends it",
    async (_case, version, status) => {
      const result = await run(
        MTHDS_AGENT,
        ["--runner", "pipelex", "run", "pipe", "x.mthds", "--error-format", "json"],
        {
          ...stubPipelexAgent(version),
          CI: "true",
        },
      );
      expect(result.status).toBe(status);
      expectNoNotice(result);
      expect(JSON.parse(result.stderr.trim())).toMatchObject(
        status === 0
          ? { warning: true }
          : {
              code: "client.tool_outdated",
              params: { tool: "pipelex-agent", version: "0.0.1" },
            },
      );
      expect(sentEvent().properties).toMatchObject({ command: "run pipe" });
    },
  );

  it("tells the tools it runs that mthds-agent ran them", async () => {
    const bin = join(home, "bin");
    const envLog = join(home, "plxt-host.log");
    mkdirSync(bin);
    writeFileSync(
      join(bin, "plxt"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "plxt 99.0.0"; exit 0; fi',
        `printf '%s' "$PIPELEX_USAGE_STATS_HOST" > "${envLog}"`,
        "",
      ].join("\n"),
    );
    chmodSync(join(bin, "plxt"), 0o755);
    const result = await run(MTHDS_AGENT, ["plxt", "lint"], {
      PATH: `${bin}${delimiter}${process.env["PATH"] ?? ""}`,
      PIPELEX_USAGE_STATS_HOST: "cocode",
      DO_NOT_TRACK: "1",
    });
    expect(result.status).toBe(0);
    expect(readFileSync(envLog, "utf-8")).toBe("mthds-agent");
  });
});
