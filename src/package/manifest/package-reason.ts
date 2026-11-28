/**
 * The reasons of `method.package_invalid` that a manifest's `result_line` and `examples` give —
 * mirror of `mthds/package/manifest/package_reason.py`.
 *
 * The core registry types `method.package_invalid`'s `reason` as an open identifier, so its
 * generated parameters read it as a `string`; the manifest format names these values in its rules
 * for `result_line` and `examples` (`mthds/docs/spec/manifest-format.md`, "Result Line" and
 * "Example Inputs"), and this tuple names them once for every reader that reports them.
 *
 * Both manifest readers check the three rules a manifest can break on its own
 * (`presentationKeyFaults` in `./schema.ts`), and `ManifestValidationError.reason` names which one
 * the strict reader met. `example_invalid` judges an example file's contents against the main
 * pipe's inputs, which only a runtime holding the method's tree and its resolved library can do,
 * so this package never raises it. An `examples` entry naming no file of the tree is no package
 * rule but `method.resource_missing`, and has no member here.
 */
export const MANIFEST_PACKAGE_REASONS = [
  /** `result_line` is empty, does not parse as a Jinja2 template, or reads a free variable whose root is not `output`. */
  "result_line_invalid",
  /** `result_line` is declared without the manifest's own `main_pipe`, whose output it reads. */
  "result_line_without_main_pipe",
  /** An example file is not a valid set of inputs for the main pipe. */
  "example_invalid",
  /** `examples` is declared without the manifest's own `main_pipe`, whose inputs the examples fill. */
  "examples_without_main_pipe",
] as const;

/** One of `MANIFEST_PACKAGE_REASONS`. */
export type ManifestPackageReason = (typeof MANIFEST_PACKAGE_REASONS)[number];
