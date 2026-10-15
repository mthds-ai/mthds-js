/**
 * The sender process: started by a command as it ends, it posts the spool and exits.
 *
 * Detached, with no terminal and no output, it outlives the command and posts, within ten seconds,
 * the files of this tool's spool queued for `--endpoint` or naming no endpoint, leaving the others
 * for a sender posting where they were queued. A command in CI or a container runs it instead as a
 * child it waits for, with `--file` and a one-second budget, so its events are posted before it
 * exits. It never prints, and it always exits 0: nothing it does can concern the person who ran
 * the command.
 *
 * Usage: node sender-main.js --endpoint <origin> --budget-ms <n> [--file <spool file> | --events <base64 JSON>]
 */

import type { Envelope } from "./event.js";
import { drainSpool, postDirect } from "./sender.js";

interface SenderArguments {
  endpoint?: string;
  budgetMs?: number;
  file?: string;
  events?: Envelope[];
}

function parseArguments(argv: string[]): SenderArguments {
  const parsed: SenderArguments = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (value === undefined) break;
    if (name === "--endpoint") parsed.endpoint = value;
    else if (name === "--budget-ms") parsed.budgetMs = Number(value);
    else if (name === "--file") parsed.file = value;
    else if (name === "--events") {
      parsed.events = JSON.parse(Buffer.from(value, "base64").toString("utf-8")) as Envelope[];
    }
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  if (args.endpoint === undefined || args.budgetMs === undefined || !(args.budgetMs > 0)) return;
  const deadline = Date.now() + args.budgetMs;
  // A request that outlives its budget is abandoned with the process; its file stays claimed until
  // a later sender takes the stale claim back.
  setTimeout(() => process.exit(0), args.budgetMs + 250).unref();
  if (args.events !== undefined) {
    await postDirect(args.endpoint, args.events, deadline);
    return;
  }
  await drainSpool({ endpoint: args.endpoint, deadline, onlyFile: args.file });
}

main()
  .catch(() => undefined)
  .finally(() => {
    process.exitCode = 0;
  });
