/**
 * Posting events to the capture endpoint, and draining this tool's spool.
 *
 * Run by the sender process (`sender-main.ts`), which a command starts when it ends, never by the
 * command itself: a CLI's exit handler cannot wait on the network, so the command writes its event
 * to the spool and hands the posting to a process of its own.
 */

import { BATCH_PATH, PROJECT_TOKEN } from "./contract.js";
import type { Envelope } from "./event.js";
import {
  claimFile,
  deleteFile,
  listReadyFiles,
  readSpoolFile,
  releaseClaim,
  rewriteClaimed,
  tidySpool,
} from "./spool.js";
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
  endpoint: string;
  /** When the whole run must be over, in epoch milliseconds. */
  deadline: number;
  /** Post only this spool file, as a command in CI or a container does with its own events. */
  onlyFile?: string;
}

/**
 * Post this tool's spool, one attempt per file, oldest first, until the deadline. Before each post
 * it runs the legacy migration; with statistics turned off on the machine it deletes what it claimed
 * unsent; and it drops every event made under an identifier other than the current one.
 */
export async function drainSpool(options: DrainOptions): Promise<void> {
  tidySpool();
  const files = options.onlyFile !== undefined ? [options.onlyFile] : listReadyFiles();
  for (const file of files) {
    if (Date.now() >= options.deadline) return;
    const claimed = claimFile(file);
    if (claimed === undefined) continue;
    runLegacyMigration();
    if (isMachineDisabled()) {
      deleteFile(claimed);
      continue;
    }
    const content = readSpoolFile(claimed);
    if (content === undefined) {
      deleteFile(claimed);
      continue;
    }
    const current = readInstallationId();
    const currentId = current.kind === "valid" ? current.id : undefined;
    const kept = content.events.filter((event) => event.distinct_id === currentId);
    if (kept.length === 0) {
      deleteFile(claimed);
      continue;
    }
    if (kept.length !== content.events.length) rewriteClaimed(claimed, kept);
    const verdict = await postBatch(options.endpoint, kept, options.deadline - Date.now());
    if (verdict === "retry") releaseClaim(claimed);
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
