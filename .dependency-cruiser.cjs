/**
 * dependency-cruiser config — enforces the ONE architectural boundary the
 * protocol ⊥ runners split introduced (plan 04b, decision D-D):
 *
 *   `src/protocol/` is the pure MTHDS Protocol mirror (exact mirror of
 *   `mthds-python/mthds/protocol/`). It must import NOTHING from `runners/`,
 *   `cli/`, `agent/`, or `config/`. The generic `MTHDSProtocol<PipeOutputT>`
 *   is the mechanism that keeps it pure — it never names a runner-side concrete.
 *
 * Edges BETWEEN runner subpackages (`runners/pipelex → runners/api`,
 * `runners/types → runners/api`) are intentionally NOT policed (D-C): mthds-js
 * needs a shared `Runner` supertype for the CLI that python has no analog for.
 */

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "protocol-stays-pure",
      severity: "error",
      comment:
        "src/protocol/ is the pure MTHDS Protocol mirror — it must not import from runners/, cli/, agent/, or config/. Move the offending type to the runner layer or invert the dependency.",
      from: { path: "^src/protocol/" },
      to: { path: "^src/(runners|cli|agent|config)/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    // With tsConfig + tsPreCompilationDeps, dependency-cruiser drives the
    // TypeScript resolver, which natively maps ESM `.js` import specifiers to
    // their `.ts` source — so the `to.path` matches real on-disk modules.
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
  },
};
