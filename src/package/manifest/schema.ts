/**
 * Flat parsed manifest types and Zod schemas for the package manager.
 *
 * Zod schemas are the **source of truth** for which keys are allowed in
 * METHODS.toml.  `.strict()` rejects unknown keys (equivalent to Pydantic's
 * `extra="forbid"`).
 *
 * This is separate from the nested MethodsManifest in types.ts which is used
 * by the installer. A conversion bridge (convert.ts) maps between the two.
 */

import { z } from "zod";

import { parseConstraint, parseVersion, SemVerError, versionSatisfies } from "../semver.js";
import type { ManifestPackageReason } from "./package-reason.js";

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const _SINGLE_CONSTRAINT =
  "(?:" +
  "\\*" +
  "|(?:(?:\\^|~|>=?|<=?|==|!=)?(?:0|[1-9]\\d*)(?:\\.(?:0|[1-9]\\d*|\\*))?(?:\\.(?:0|[1-9]\\d*|\\*))?)" +
  "(?:-(?:(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?" +
  ")";

const VERSION_CONSTRAINT_RE = new RegExp(
  `^${_SINGLE_CONSTRAINT}(?:\\s*,\\s*${_SINGLE_CONSTRAINT})*$`,
);

const ADDRESS_RE = /^[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+\/[a-zA-Z0-9._/-]+$/;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RESERVED_DOMAINS: ReadonlySet<string> = new Set(["native", "mthds", "pipelex"]);

/**
 * The MTHDS standard version this implementation implements — the version of the
 * specification itself (its language, native concept set, manifest, lock and crate
 * formats). Cut by `mthds/docs/spec/versioning.md` § "The Standard Version"; this
 * is the single declaration of it in this package, so following a cut is one edit.
 *
 * It is what a manifest's `mthds_version` constraint is evaluated against
 * (`satisfiesMthdsStandardVersion` below) and what `mthds package init` writes as
 * the floor of a new package's constraint.
 */
export const MTHDS_STANDARD_VERSION = "9.2.0";

// ---------------------------------------------------------------------------
// Standalone validation helpers (used outside the parser too)
// ---------------------------------------------------------------------------

export function isReservedDomainPath(domainPath: string): boolean {
  const firstSegment = domainPath.split(".")[0]!;
  return RESERVED_DOMAINS.has(firstSegment);
}

export function isValidSemver(version: string): boolean {
  return SEMVER_RE.test(version);
}

export function isValidVersionConstraint(constraint: string): boolean {
  return VERSION_CONSTRAINT_RE.test(constraint.trim());
}

export function isValidAddress(address: string): boolean {
  return ADDRESS_RE.test(address);
}

/** The verdict of evaluating a manifest's `mthds_version` against the standard. */
export type MthdsVersionVerdict =
  | { readonly kind: "satisfied" }
  /** Well-formed, but the standard version this implementation implements is outside it. */
  | { readonly kind: "unsatisfied"; readonly standardVersion: string }
  /**
   * The evaluator could not compile it. This is not the same population as the
   * one `isValidVersionConstraint` rejects: the regex is the looser of the two
   * in places — it admits a prerelease suffix on a partial version (`>=1.0-beta`,
   * `1-alpha`), which npm's `Range` will not read — so a constraint can pass the
   * regex gate and land here. Callers that gate on the regex first must still
   * handle this verdict.
   */
  | { readonly kind: "malformed"; readonly reason: string };

/**
 * Evaluate a manifest's `mthds_version` against the standard version this
 * implementation implements.
 *
 * `mthds_version` is a **constraint** — the versions of the MTHDS standard the
 * package declares itself compatible with — and not a stamp, so it is checked by
 * evaluation rather than by equality. See `mthds/docs/spec/versioning.md`
 * § "`mthds_version` and the Crate Stamp".
 */
export function satisfiesMthdsStandardVersion(constraint: string): MthdsVersionVerdict {
  // Parsed outside the try below: this is OUR constant, and a defect in it is not
  // the manifest's fault. Left inside, a typo here (`"2.0"` for `"2.0.0"`) came
  // back as `malformed` and every method on every repository was skipped with a
  // message quoting the manifest's own perfectly valid constraint.
  const current = parseVersion(MTHDS_STANDARD_VERSION);
  try {
    const parsed = parseConstraint(constraint);
    return versionSatisfies(current, parsed)
      ? { kind: "satisfied" }
      : { kind: "unsatisfied", standardVersion: MTHDS_STANDARD_VERSION };
  } catch (err) {
    if (err instanceof SemVerError) {
      return { kind: "malformed", reason: err.message };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Zod schemas — source of truth for allowed TOML keys
// ---------------------------------------------------------------------------

/** Method name: snake_case, 2-25 chars, starts with a letter */
export const METHOD_NAME_RE = /^[a-z][a-z0-9_]{1,24}$/;

export function isValidMethodName(name: string): boolean {
  return METHOD_NAME_RE.test(name);
}

/**
 * One entry of `[package] categories`: a lowercase slug, the standard's pattern as it writes it
 * (`mthds/docs/spec/manifest-format.md`, "Categories"). The standard lists no values, so this is
 * the whole check: a repeated entry and a value no list names are not errors.
 */
export const CATEGORY_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function isValidCategory(category: string): boolean {
  return CATEGORY_SLUG_RE.test(category);
}

/** A rule of `result_line` or `examples` a manifest breaks on its own, with the reason the format gives it. */
export interface ManifestRuleFault {
  readonly reason: ManifestPackageReason;
  readonly message: string;
}

/**
 * The rules of `[package] result_line` and `examples` a manifest can break on its own
 * (`mthds/docs/spec/manifest-format.md`, "Result Line" and "Example Inputs"), in the order the
 * strict reader reports them, the first one being the one it refuses the manifest for:
 *
 * - a `result_line` that is empty or holds only white space, which would render to no line at all,
 *   breaks `result_line_invalid`;
 * - a `result_line` without the manifest's own `main_pipe`, whose output it reads, breaks
 *   `result_line_without_main_pipe`;
 * - a non-empty `examples` without `main_pipe`, whose inputs each example fills, breaks
 *   `examples_without_main_pipe`. An empty array declares no example, as leaving the key out does.
 *
 * The rest is the runtime's to judge, since it needs what a manifest alone does not hold: whether
 * the template parses as Jinja2 and reads no free variable but `output`, whether each example
 * names a file of the tree, and whether each file holds a valid set of inputs for the main pipe.
 */
export function presentationKeyFaults(pkg: {
  readonly mainPipe?: string | undefined;
  readonly resultLine?: string | undefined;
  readonly examples?: readonly string[] | undefined;
}): ManifestRuleFault[] {
  const faults: ManifestRuleFault[] = [];
  if (pkg.resultLine !== undefined && pkg.resultLine.trim() === "") {
    faults.push({
      reason: "result_line_invalid",
      message:
        "[package.result_line] must not be empty: it is a template wording a finished run of the main pipe in one line.",
    });
  }
  if (pkg.mainPipe === undefined) {
    if (pkg.resultLine !== undefined) {
      faults.push({
        reason: "result_line_without_main_pipe",
        message:
          "[package.result_line] requires [package.main_pipe]: the result line reads the output of the manifest's own main pipe.",
      });
    }
    if (pkg.examples !== undefined && pkg.examples.length > 0) {
      faults.push({
        reason: "examples_without_main_pipe",
        message:
          "[package.examples] requires [package.main_pipe]: each example is a set of inputs for the manifest's own main pipe.",
      });
    }
  }
  return faults;
}

/** Raw [package] section in METHODS.toml */
export const PackageSectionSchema = z
  .object({
    name: z.string().optional(),
    address: z.string(),
    version: z.string(),
    description: z.string(),
    display_name: z.string().optional(),
    authors: z.array(z.string()).optional(),
    license: z.string().optional(),
    mthds_version: z.string().optional(),
    main_pipe: z.string().optional(),
    exclude: z.array(z.string()).optional(),
    categories: z.array(z.string()).optional(),
    result_line: z.string().optional(),
    examples: z.array(z.string()).optional(),
  })
  .strict();

/** Flattened domain exports (after walkExportsTable) */
export const DomainExportsSchema = z
  .object({
    pipes: z.array(z.string()),
  })
  .strict();

/** Top-level METHODS.toml structure */
export const MethodsTomlSchema = z
  .object({
    package: PackageSectionSchema,
    exports: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DomainExports {
  readonly pipes: string[];
}

/**
 * Flat parsed manifest — the primary model for the package manager.
 *
 * All export domains are flattened to dotted paths (e.g. "legal.contracts").
 */
export interface ParsedManifest {
  readonly name?: string;
  readonly address: string;
  readonly displayName?: string;
  readonly version: string;
  readonly description: string;
  readonly authors: string[];
  readonly license?: string;
  readonly mthdsVersion?: string;
  readonly mainPipe?: string;
  /** `[package] exclude`: patterns in `.gitignore` syntax keeping files out of the method tree. */
  readonly exclude?: string[];
  /**
   * `[package] categories`: the categories the method belongs to, as lowercase slugs, carried as
   * the manifest writes them, order, repeats and an empty array included.
   */
  readonly categories?: string[];
  /**
   * `[package] result_line`: a Jinja2 template wording a finished run of `mainPipe` in one line,
   * reading the main pipe's output as `output`, carried as written. Rendering it is the runtime's.
   */
  readonly resultLine?: string;
  /**
   * `[package] examples`: files of the method's tree, each holding a complete set of example
   * inputs for `mainPipe`, in the order a consumer offers them, carried as written, an empty array
   * included.
   */
  readonly examples?: string[];
  readonly exports: Record<string, DomainExports>;
}

// One rule for the manifest's reader and the method tree's lister, which reads the patterns too.
export { isValidExcludePattern } from "../../method-tree/membership.js";
