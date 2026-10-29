import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Every test, and every CLI a test spawns, runs under a scratch home with usage statistics and
// method events off and the endpoint both follow pointed at a loopback port nothing listens on, so
// no test reads or writes the real ~/.mthds and none reaches PostHog. The tests of the statistics
// themselves build their environment from nothing, keeping a loopback endpoint. tests/support/isolation-guard.ts fails any test
// that connects to a non-loopback host and any test file that changed the real usage-statistics
// state, and tests/support/global-setup.ts fails the run if that state changed at all.
const scratchHome = mkdtempSync(join(tmpdir(), "mthds-tests-home-"));

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    env: {
      HOME: scratchHome,
      USERPROFILE: scratchHome,
      DO_NOT_TRACK: "1",
      PIPELEX_USAGE_STATS_ENDPOINT: "http://127.0.0.1:9",
    },
    setupFiles: ["tests/support/isolation-guard.ts"],
    globalSetup: ["tests/support/global-setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["tests/**", "dist/**", "coverage/**"],
    },
  },
});
