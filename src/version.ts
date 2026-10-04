/**
 * This package's own release number, as a constant the SDK can read at runtime.
 *
 * It MUST equal `package.json`'s `"version"`. A unit test
 * (`tests/unit/version.test.ts`) fails the suite the moment the two differ, so a
 * release that bumps `package.json` without this line cannot pass its gates.
 *
 * Why a constant rather than reading `package.json` at runtime: the SDK is
 * bundled by consumers (Next.js / Turbopack in `pipelex-app`), where a
 * `createRequire(import.meta.url)` of `../../../package.json` does not resolve,
 * and `tsconfig`'s `rootDir: "src"` keeps a JSON import of the manifest out of
 * the compiled tree. A literal works identically from `src/`, `dist/` and any
 * bundle.
 *
 * This is NOT `MTHDS_STANDARD_VERSION` nor `MTHDS_PROTOCOL_VERSION` — see
 * `docs/versioning.md`.
 */
export const MTHDS_JS_VERSION = "0.30.0";
