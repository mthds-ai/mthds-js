/**
 * The version of the MTHDS core error registry this package is written against: the standard
 * version the registry is published with (mthds/docs/spec/versioning.md, "The Core Error
 * Registry"). The vendored snapshot, scripts/registry/mthds-error-registry.json, must be this
 * version, and the offline drift check (tests/unit/problems/registry.test.ts) fails when it is
 * not, so that moving to another registry is a deliberate edit of this line beside a re-vendor
 * (`make vendor-error-registry REF=<tag>`).
 *
 * It is not `MTHDS_STANDARD_VERSION`, the standard version this package implements for manifests
 * and crates, which a release of the standard moves on its own.
 */
export const MTHDS_ERROR_REGISTRY_TARGET_VERSION = "8.0.1";
