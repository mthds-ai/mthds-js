import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startLoopbackServer } from "../../support/loopback-server.js";
import type { LoopbackServer } from "../../support/loopback-server.js";

// The spool and the sender, posting to a loopback server standing in for PostHog's capture host.

let tempHome: string;

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return { ...original, homedir: () => tempHome };
});

// The identifier reading is wrapped, to run a `disable` from inside it, between a sender's claim
// and its post.
vi.mock("../../../src/usage-stats/state.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../src/usage-stats/state.js")>();
  return { ...original, readInstallationId: vi.fn(original.readInstallationId) };
});

import { drainSpool, postBatch, postDirect } from "../../../src/usage-stats/sender.js";
import {
  claimFile,
  listReadyFiles,
  spoolDir,
  tidySpool,
  writeSpoolFile,
} from "../../../src/usage-stats/spool.js";
import { buildCommandCompleted } from "../../../src/usage-stats/event.js";
import type { Envelope } from "../../../src/usage-stats/event.js";
import {
  createDisabledFile,
  deleteEverySpool,
  obtainInstallationId,
  readInstallationId,
  stateDir,
} from "../../../src/usage-stats/state.js";
import { PROJECT_TOKEN } from "../../../src/usage-stats/contract.js";

const OTHER_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

let server: LoopbackServer;
/** Another loopback server, the endpoint a file was queued for when it was not `server`. */
let elsewhere: LoopbackServer;

function event(distinctId?: string): Envelope {
  const installation = distinctId
    ? { id: distinctId, idNew: false, persisted: true }
    : obtainInstallationId();
  return buildCommandCompleted(
    { surface: "mthds", toolVersion: "0.31.0", installation, env: {} },
    { command: "install", outcome: "succeeded", durationMs: 10 },
  );
}

function deadline(): number {
  return Date.now() + 5_000;
}

function spoolNames(): string[] {
  try {
    return readdirSync(spoolDir());
  } catch {
    return [];
  }
}

/**
 * Put a file in the spool by hand, holding `content` as it is, the way another tool or an earlier
 * version could have left it. Answers its path.
 */
function placeSpoolFile(content: Record<string, unknown>, createdMs = Date.now()): string {
  mkdirSync(spoolDir(), { recursive: true });
  const path = join(spoolDir(), `${createdMs}-${Math.random().toString(16).slice(2, 10)}.json`);
  writeFileSync(path, JSON.stringify(content));
  return path;
}

function readHeld(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

beforeAll(async () => {
  server = await startLoopbackServer();
  elsewhere = await startLoopbackServer();
});

afterAll(async () => {
  await server.close();
  await elsewhere.close();
});

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), "mthds-sender-"));
  server.requests.length = 0;
  server.respond(() => ({ status: 200, body: { status: "Ok" } }));
  elsewhere.requests.length = 0;
  elsewhere.respond(() => ({ status: 200, body: { status: "Ok" } }));
  vi.mocked(readInstallationId).mockClear();
});

/** What `mthds telemetry disable` does: create `disabled`, then delete every tool's spool. */
function disableOnMachine(): void {
  createDisabledFile();
  deleteEverySpool();
}

describe("postBatch", () => {
  it("posts the project token and the events to /batch/", async () => {
    const events = [event()];
    expect(await postBatch(server.origin, events, 2_000)).toBe("delivered");
    expect(server.requests).toEqual([
      {
        method: "POST",
        path: "/batch/",
        body: { api_key: PROJECT_TOKEN, batch: JSON.parse(JSON.stringify(events)) },
      },
    ]);
  });

  it.each([
    [400, "refused"],
    [401, "refused"],
    [403, "refused"],
    [413, "refused"],
    [429, "retry"],
    [500, "retry"],
    [503, "retry"],
  ])("reads status %i as %s", async (status, verdict) => {
    server.respond(() => ({ status }));
    expect(await postBatch(server.origin, [event()], 2_000)).toBe(verdict);
  });

  it("retries when nothing answers", async () => {
    expect(await postBatch("http://127.0.0.1:9", [event()], 2_000)).toBe("retry");
  });
});

describe("drainSpool", () => {
  it("posts every spooled file and deletes each one delivered", async () => {
    writeSpoolFile(server.origin, [event()]);
    writeSpoolFile(server.origin, [event()]);
    await drainSpool({ endpoint: server.origin, deadline: deadline() });
    expect(server.requests).toHaveLength(2);
    expect(listReadyFiles()).toEqual([]);
  });

  it("gives a file back to the spool when the post should be retried", async () => {
    server.respond(() => ({ status: 503 }));
    const path = writeSpoolFile(server.origin, [event()]);
    await drainSpool({ endpoint: server.origin, deadline: deadline() });
    expect(listReadyFiles()).toEqual([path]);
  });

  it("deletes a file the endpoint refused", async () => {
    server.respond(() => ({ status: 400 }));
    writeSpoolFile(server.origin, [event()]);
    await drainSpool({ endpoint: server.origin, deadline: deadline() });
    expect(spoolNames()).toEqual([]);
  });

  it("deletes what it claimed, unsent, once statistics are off on the machine", async () => {
    writeSpoolFile(server.origin, [event()]);
    writeFileSync(join(stateDir(), "disabled"), "");
    await drainSpool({ endpoint: server.origin, deadline: deadline() });
    expect(server.requests).toEqual([]);
    expect(spoolNames()).toEqual([]);
  });

  it("runs the legacy migration first, so a legacy opt-out stops the send", async () => {
    writeSpoolFile(server.origin, [event()]);
    writeFileSync(join(tempHome, ".mthds", "config"), "DISABLE_TELEMETRY=1\n");
    await drainSpool({ endpoint: server.origin, deadline: deadline() });
    expect(server.requests).toEqual([]);
    expect(existsSync(join(stateDir(), "disabled"))).toBe(true);
  });

  it("runs the legacy migration before each post: an opt-out written between two posts stops the second", async () => {
    writeSpoolFile(server.origin, [event()]);
    writeSpoolFile(server.origin, [event()]);
    writeSpoolFile(server.origin, [event()]);
    // `~/.mthds/config` exists and says nothing of the opt-out when the drain starts.
    mkdirSync(join(tempHome, ".mthds"), { recursive: true });
    writeFileSync(join(tempHome, ".mthds", "config"), "MTHDS_RUNNER=api\n");
    server.respond(() => {
      // An older mthds writes its opt-out while the first post is answered.
      const configPath = join(tempHome, ".mthds", "config");
      writeFileSync(configPath, "MTHDS_RUNNER=api\nDISABLE_TELEMETRY=1\n");
      const later = new Date(Date.now() + 60_000);
      utimesSync(configPath, later, later);
      return { status: 200, body: { status: "Ok" } };
    });
    await drainSpool({ endpoint: server.origin, deadline: deadline() });
    expect(server.requests).toHaveLength(1);
    expect(existsSync(join(stateDir(), "disabled"))).toBe(true);
    expect(spoolNames()).toEqual([]);
  });

  it("posts nothing when statistics are turned off between its claim and its post", async () => {
    writeSpoolFile(server.origin, [event(OTHER_ID), event()]);
    const actual = await vi.importActual<typeof import("../../../src/usage-stats/state.js")>(
      "../../../src/usage-stats/state.js",
    );
    vi.mocked(readInstallationId).mockImplementationOnce(() => {
      disableOnMachine();
      return actual.readInstallationId();
    });
    await drainSpool({ endpoint: server.origin, deadline: deadline() });
    expect(server.requests).toEqual([]);
    // The claimed file `disable` deleted is not written again.
    expect(spoolNames()).toEqual([]);
  });

  it("posts nothing when the file it claimed was deleted before its post", async () => {
    writeSpoolFile(server.origin, [event()]);
    const actual = await vi.importActual<typeof import("../../../src/usage-stats/state.js")>(
      "../../../src/usage-stats/state.js",
    );
    // `reset-id` deletes every spool, claimed files included, and replaces the identifier.
    vi.mocked(readInstallationId).mockImplementationOnce(() => {
      const reading = actual.readInstallationId();
      deleteEverySpool();
      return reading;
    });
    await drainSpool({ endpoint: server.origin, deadline: deadline() });
    expect(server.requests).toEqual([]);
    expect(spoolNames()).toEqual([]);
  });

  it("never gives back a file that statistics were turned off for while its post ran", async () => {
    server.respond(() => {
      disableOnMachine();
      return { status: 503 };
    });
    writeSpoolFile(server.origin, [event(OTHER_ID), event()]);
    await drainSpool({ endpoint: server.origin, deadline: deadline() });
    expect(server.requests).toHaveLength(1);
    expect(spoolNames()).toEqual([]);
  });

  it("never writes again a file deleted while its post ran", async () => {
    server.respond(() => {
      deleteEverySpool();
      return { status: 503 };
    });
    writeSpoolFile(server.origin, [event(OTHER_ID), event()]);
    await drainSpool({ endpoint: server.origin, deadline: deadline() });
    expect(spoolNames()).toEqual([]);
  });

  it("gives a retried file back without the events made under another identifier", async () => {
    server.respond(() => ({ status: 503 }));
    const current = event();
    const path = writeSpoolFile(server.origin, [event(OTHER_ID), current]);
    await drainSpool({ endpoint: server.origin, deadline: deadline() });
    expect(listReadyFiles()).toEqual([path]);
    const kept = JSON.parse(readFileSync(path, "utf-8")) as { events: Envelope[] };
    expect(kept.events.map((held) => held.uuid)).toEqual([current.uuid]);
  });

  it("drops every event made under an identifier other than the current one", async () => {
    const current = event();
    writeSpoolFile(server.origin, [event(OTHER_ID), current]);
    writeSpoolFile(server.origin, [event(OTHER_ID)]);
    await drainSpool({ endpoint: server.origin, deadline: deadline() });
    expect(server.requests).toHaveLength(1);
    const batch = (server.requests[0]!.body as { batch: Envelope[] }).batch;
    expect(batch.map((sent) => sent.uuid)).toEqual([current.uuid]);
    expect(spoolNames()).toEqual([]);
  });

  it("posts only the file it was given, leaving the rest for a later sender", async () => {
    const first = writeSpoolFile(server.origin, [event()]);
    const second = writeSpoolFile(server.origin, [event()]);
    await drainSpool({ endpoint: server.origin, deadline: deadline(), onlyFile: second });
    expect(server.requests).toHaveLength(1);
    expect(listReadyFiles()).toEqual([first]);
  });

  it("leaves a file another sender claimed", async () => {
    const path = writeSpoolFile(server.origin, [event()]);
    expect(claimFile(path)).toBeDefined();
    await drainSpool({ endpoint: server.origin, deadline: deadline() });
    expect(server.requests).toEqual([]);
  });

  it("stops at the deadline", async () => {
    writeSpoolFile(server.origin, [event()]);
    await drainSpool({ endpoint: server.origin, deadline: Date.now() - 1 });
    expect(server.requests).toEqual([]);
    expect(listReadyFiles()).toHaveLength(1);
  });
});

describe("the endpoint a spool file was queued for", () => {
  it("is written into every file, as the origin it was given, before the events", () => {
    const events = [event()];
    const path = writeSpoolFile(server.origin, events);
    const held = readHeld(path);
    expect(Object.keys(held)).toEqual(["spool_version", "endpoint", "events"]);
    expect(held).toEqual({
      spool_version: 1,
      endpoint: server.origin,
      events: JSON.parse(JSON.stringify(events)),
    });
  });

  it("is written exactly as the command resolved it", () => {
    expect(readHeld(writeSpoolFile("http://localhost:8080", [])).endpoint).toBe(
      "http://localhost:8080",
    );
    expect(readHeld(writeSpoolFile("https://eu.i.posthog.com", [])).endpoint).toBe(
      "https://eu.i.posthog.com",
    );
  });

  it("keeps a file queued for another endpoint out of the post, in the spool", async () => {
    const queued = event();
    const path = placeSpoolFile({
      spool_version: 1,
      endpoint: elsewhere.origin,
      events: [queued],
    });
    await drainSpool({ endpoint: server.origin, deadline: deadline() });
    expect(server.requests).toEqual([]);
    expect(listReadyFiles()).toEqual([path]);
    expect(readHeld(path)).toMatchObject({ endpoint: elsewhere.origin });

    // A sender posting where the file was queued posts it.
    await drainSpool({ endpoint: elsewhere.origin, deadline: deadline() });
    expect(elsewhere.requests).toHaveLength(1);
    const batch = (elsewhere.requests[0]!.body as { batch: Envelope[] }).batch;
    expect(batch.map((sent) => sent.uuid)).toEqual([queued.uuid]);
    expect(spoolNames()).toEqual([]);
  });

  it("posts the files queued for its endpoint around one queued elsewhere", async () => {
    const before = writeSpoolFile(server.origin, [event()]);
    const other = placeSpoolFile({
      spool_version: 1,
      endpoint: elsewhere.origin,
      events: [event()],
    });
    const after = writeSpoolFile(server.origin, [event()]);
    await drainSpool({ endpoint: server.origin, deadline: deadline() });
    expect(server.requests).toHaveLength(2);
    expect(elsewhere.requests).toEqual([]);
    expect(listReadyFiles()).toEqual([other]);
    expect([before, after].filter((path) => existsSync(path))).toEqual([]);
  });

  it("leaves a file queued elsewhere even when it is the one file it was given", async () => {
    const path = placeSpoolFile({
      spool_version: 1,
      endpoint: elsewhere.origin,
      events: [event()],
    });
    await drainSpool({ endpoint: server.origin, deadline: deadline(), onlyFile: path });
    expect(server.requests).toEqual([]);
    expect(listReadyFiles()).toEqual([path]);
  });

  it.each([
    ["no endpoint", {}],
    ["a null endpoint", { endpoint: null }],
  ])("posts a file naming %s to whichever endpoint the sender posts to", async (_case, extra) => {
    const queued = event();
    placeSpoolFile({ spool_version: 1, ...extra, events: [queued] });
    await drainSpool({ endpoint: server.origin, deadline: deadline() });
    expect(server.requests).toHaveLength(1);
    const batch = (server.requests[0]!.body as { batch: Envelope[] }).batch;
    expect(batch.map((sent) => sent.uuid)).toEqual([queued.uuid]);
    expect(spoolNames()).toEqual([]);
  });

  it("deletes unsent a file whose endpoint is not a string", async () => {
    placeSpoolFile({ spool_version: 1, endpoint: 8080, events: [event()] });
    await drainSpool({ endpoint: server.origin, deadline: deadline() });
    expect(server.requests).toEqual([]);
    expect(spoolNames()).toEqual([]);
  });

  it("is kept when a retried file is given back without some of its events", async () => {
    server.respond(() => ({ status: 503 }));
    const current = event();
    const path = placeSpoolFile({
      spool_version: 1,
      endpoint: server.origin,
      events: [event(OTHER_ID), current],
    });
    await drainSpool({ endpoint: server.origin, deadline: deadline() });
    expect(listReadyFiles()).toEqual([path]);
    const held = readHeld(path);
    expect(held.endpoint).toBe(server.origin);
    expect((held.events as Envelope[]).map((kept) => kept.uuid)).toEqual([current.uuid]);
  });

  it("stays absent when a retried file naming none is given back", async () => {
    server.respond(() => ({ status: 503 }));
    const path = placeSpoolFile({ spool_version: 1, events: [event(OTHER_ID), event()] });
    await drainSpool({ endpoint: server.origin, deadline: deadline() });
    expect(Object.keys(readHeld(path))).toEqual(["spool_version", "events"]);
  });
});

describe("postDirect", () => {
  it("posts events that belong to no spool, and keeps nothing", async () => {
    await postDirect(server.origin, [event(OTHER_ID)], deadline());
    expect(server.requests).toHaveLength(1);
    expect(spoolNames()).toEqual([]);
  });

  it("sends nothing once statistics are off on the machine", async () => {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(join(stateDir(), "disabled"), "");
    await postDirect(server.origin, [event(OTHER_ID)], deadline());
    expect(server.requests).toEqual([]);
  });
});

describe("the spool's housekeeping", () => {
  it("keeps at most the contract's number of files, deleting the oldest", () => {
    mkdirSync(spoolDir(), { recursive: true });
    const base = Date.now() - 10_000;
    for (let index = 0; index < 100; index++) {
      writeFileSync(
        join(spoolDir(), `${base + index}-abc.json`),
        '{"spool_version":1,"events":[]}',
      );
    }
    writeSpoolFile(server.origin, []);
    const ready = listReadyFiles();
    expect(ready).toHaveLength(100);
    expect(ready[0]).toContain(`${base + 1}-abc.json`);
  });

  it("takes back a stale claim, deletes old files and stale temporaries, and keeps the rest", () => {
    mkdirSync(spoolDir(), { recursive: true });
    const now = Date.now();
    const write = (name: string, mtimeMs = now): string => {
      const path = join(spoolDir(), name);
      writeFileSync(path, '{"spool_version":1,"events":[]}');
      utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
      return path;
    };
    write(`${now - 31 * 86_400_000}-aaa.json`);
    write(`${now - 60_000}-bbb.json.sending-111`, now - 11 * 60_000);
    write(`${now - 60_000}-ccc.json.sending-222`, now - 60_000);
    write(".leftover.tmp", now - 61 * 60_000);
    write(".recent.tmp", now - 60_000);
    write(`${now}-ddd.json`);

    tidySpool(now);

    expect(spoolNames().sort()).toEqual(
      [
        `${now - 60_000}-bbb.json`,
        `${now - 60_000}-ccc.json.sending-222`,
        ".recent.tmp",
        `${now}-ddd.json`,
      ].sort(),
    );
  });
});
