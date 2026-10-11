/**
 * Run once around the whole test run (`globalSetup` in vitest.config.ts): the run fails when the
 * account's real usage-statistics state changed while it ran. tests/support/isolation-guard.ts
 * checks the same thing file by file, naming the file; this catches what happens between files.
 */

import { REAL_STATE_DIR, realStateSnapshot } from "./real-home.js";

export default function setup(): () => void {
  const before = realStateSnapshot();
  return () => {
    if (realStateSnapshot() === before) return;
    // vitest reports a teardown's exception without failing the run; the exit code does.
    process.exitCode = 1;
    console.error(
      `The test run changed ${REAL_STATE_DIR}, the real usage-statistics state of this machine. ` +
        "Every test must run under the scratch HOME vitest.config.ts sets, or build its own.",
    );
  };
}
