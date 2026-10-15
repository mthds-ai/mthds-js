/**
 * Posting events to the capture endpoint, and draining this tool's spool.
 *
 * Run by the sender process (`sender-main.ts`), which a command starts when it ends, never by the
 * command itself: a CLI's exit handler cannot wait on the network, so the command writes its event
 * to the spool and hands the posting to a process of its own.
 */

import { existsSync } from "node:fs";
import { BATCH_PATH, PROJECT_TOKEN } from "./contract.js";
import type { Envelope } from "./event.js";
import {
  claimFile,
  deleteFile,
  isQueuedFor,
  listReadyFiles,
  readSpoolFile,
  releaseClaim,
  rewriteClaimed,
  tidySpool,
} from "./spool.js";
import type { SpoolContent } from "./spool.js";
import { isMachineDisabled, readInstallationId, runLegacyMigration } from "./state.js";

/** What a post's answer means for the file it came from. */
export type PostVerdict = "delivered" | "refused" | "retry";

/** Statuses meaning that resending would be refused again: the file is deleted. */
const PERMANENT_REFUSALS = new Set([400, 401, 403, 413]);

/** The body PostHog's batch endpoint takes: the project token and the events. */
export function batchBody(events: Envelope[]): string {
  return JSON.stringify({ api_key: PROJECT_TOKEN, batch: events });
}

/** Post one batch within `timeoutMs`, and say what its answer means for the events. */
export async function postBatch(
  endpoint: string,
  events: Envelope[],
  timeoutMs: number,
): Promise<PostVerdict> {
  if (timeoutMs <= 0) return "retry";
  try {
    const response = await fetch(`${endpoint}${BATCH_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: batchBody(events),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The body is not read: the status alone decides, and an unread body holds the socket open.
    await response.body?.cancel().catch(() => undefined);
    if (response.status >= 200 && response.status < 300) return "delivered";
    if (PERMANENT_REFUSALS.has(response.status)) return "refused";
    return "retry";
  } catch {
    return "retry";
  }
}

export interface DrainOptions {
  /** The origin this sender posts to; it posts only the files queued for it, or naming none. */
  endpoint: string;
  /** When the whole run must be over, in epoch milliseconds. */
  deadline: number;
  /** Post only this spool file, as a command in CI or a container does with its own events. */
  onlyFile?: string;
}

/**
 * The events of a claimed file that may be posted, read immediately before the post, as the
 * contract's "Before each post" says. The legacy migration runs first, so an opt-out written to
 * `~/.mthds/config` since the last post is carried over now; it parses the file only when it changed
 * since it was last read. Then none are posted when there is no valid identifier, when statistics
 * are off on the machine, or when the claimed file is gone, which only `disable`, `reset-id` or the
 * legacy migration does to a claimed file; otherwise those made under the current identifier are.
 * The identifier is read before `disabled`, so that a `disable` running meanwhile is seen.
 */
function eventsToPost(claimed: string, events: Envelope[]): Envelope[] {
  runLegacyMigration();
  const current = readInstallationId();
  if (current.kind !== "valid") return [];
  const kept = events.filter((event) => event.distinct_id === current.id);
  if (!existsSync(claimed) || isMachineDisabled()) return [];
  return kept;
}

/**
 * Give a file whose post should be retried back to the spool, for the next sender, without the
 * events it dropped and still naming the endpoint it was queued for. Not when statistics were
 * turned off on the machine or the file was deleted while the post ran: it is deleted then, and
 * never written again.
 */
function giveBack(claimed: string, content: SpoolContent, posted: Envelope[]): void {
  if (isMachineDisabled()) {
    deleteFile(claimed);
    return;
  }
  if (
    posted.length !== content.events.length &&
    !rewriteClaimed(claimed, { endpoint: content.endpoint, events: posted })
  ) {
    return;
  }
  releaseClaim(claimed);
}

/**
 * Post this tool's spool, one attempt per file, oldest first, until the deadline. A file queued
 * for an endpoint other than this sender's is left in place, unclaimed, for a sender posting
 * there, so events queued under a test's loopback override never reach PostHog and events queued
 * for PostHog never reach a loopback server; a file naming no endpoint is posted. Immediately
 * before each post, the sender runs the legacy migration, posts nothing, deleting what it claimed,
 * once statistics are off on the machine, and drops every event made under an identifier other
 * than the current one.
 */
export async function drainSpool(options: DrainOptions): Promise<void> {
  tidySpool();
  const files = options.onlyFile !== undefined ? [options.onlyFile] : listReadyFiles();
  for (const file of files) {
    if (Date.now() >= options.deadline) return;
    // Read before claiming, so a file queued elsewhere is never taken from the spool, even briefly.
    const peeked = readSpoolFile(file);
    if (peeked !== undefined && !isQueuedFor(peeked, options.endpoint)) continue;
    const claimed = claimFile(file);
    if (claimed === undefined) continue;
    const content = readSpoolFile(claimed);
    if (content === undefined) {
      deleteFile(claimed);
      continue;
    }
    // The claimed file decides: the peek reads nothing while another sender holds the file claimed.
    if (!isQueuedFor(content, options.endpoint)) {
      releaseClaim(claimed);
      continue;
    }
    const kept = eventsToPost(claimed, content.events);
    if (kept.length === 0) {
      deleteFile(claimed);
      continue;
    }
    const verdict = await postBatch(options.endpoint, kept, options.deadline - Date.now());
    if (verdict === "retry") giveBack(claimed, content, kept);
    else deleteFile(claimed);
  }
}

/**
 * Post events that belong to no spool: those of a process whose identifier is its own, persisted
 * nowhere, which a spool would drop as made under another identifier. What fails is not kept.
 */
export async function postDirect(
  endpoint: string,
  events: Envelope[],
  deadline: number,
): Promise<void> {
  runLegacyMigration();
  if (isMachineDisabled()) return;
  await postBatch(endpoint, events, deadline - Date.now());
}
