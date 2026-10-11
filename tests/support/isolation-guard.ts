/**
 * Loaded before every test file (`setupFiles` in vitest.config.ts). A test file fails when it
 * changed the account's real usage-statistics state, and a test fails when it opened a TCP
 * connection to anything but a loopback host.
 *
 * No test may open a TCP connection to anything but a loopback host. Every outgoing connection of this process (fetch,
 * node:http, node:https, PostHog's client) goes through `net.Socket.prototype.connect`, which is
 * wrapped here to refuse any other host and to fail the test that tried, even when the code under
 * test swallows the refusal, as a usage-statistics sender does.
 *
 * Processes a test spawns are kept off the network by the environment vitest.config.ts gives every
 * test: a scratch HOME, DO_NOT_TRACK=1 and a loopback usage-statistics endpoint, which they inherit.
 */

import net from "node:net";
import { afterAll, afterEach, beforeAll } from "vitest";
import { REAL_STATE_DIR, realStateSnapshot } from "./real-home.js";

// ── The real home ───────────────────────────────────────────────────

let realStateBefore: string;

beforeAll(() => {
  realStateBefore = realStateSnapshot();
});

afterAll(() => {
  if (realStateSnapshot() !== realStateBefore) {
    throw new Error(
      `This test file changed ${REAL_STATE_DIR}, the real usage-statistics state of this machine. ` +
        "Run the code under the scratch HOME vitest.config.ts sets, or mock homedir().",
    );
  }
});

// ── The network ─────────────────────────────────────────────────────

/** The hosts refused since the last test ended, shared under a global key so a test of the guard can read them. */
const REFUSED_KEY = Symbol.for("mthds.tests.refusedHosts");
const shared = globalThis as unknown as Record<symbol, string[] | undefined>;
const refused: string[] = (shared[REFUSED_KEY] ??= []);

function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127(?:\.\d{1,3}){3}$/.test(bare);
}

/** The host a `connect` call targets, or undefined for a local socket path. */
function connectHost(args: unknown[]): string | undefined {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (typeof first === "string") return undefined; // A pipe or Unix socket path.
  if (typeof first === "number") return typeof args[1] === "string" ? args[1] : "localhost";
  if (typeof first === "object" && first !== null) {
    const options = first as { path?: unknown; host?: unknown };
    if (typeof options.path === "string") return undefined;
    return typeof options.host === "string" ? options.host : "localhost";
  }
  return undefined;
}

const originalConnect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
  const host = connectHost(args);
  if (host !== undefined && !isLoopback(host)) {
    refused.push(host);
    throw new Error(`A test tried to connect to ${host}; tests may reach loopback hosts only.`);
  }
  return (originalConnect as (...connectArgs: unknown[]) => net.Socket).apply(this, args);
} as typeof net.Socket.prototype.connect;

afterEach(() => {
  if (refused.length === 0) return;
  const hosts = [...new Set(refused.splice(0))].join(", ");
  throw new Error(
    `This test tried to reach ${hosts}. Tests reach loopback hosts only: point the code at a loopback server.`,
  );
});
